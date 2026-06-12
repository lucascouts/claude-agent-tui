// Story 032 / Task 4.1 — lossless inject→restore round-trip (R5.1, R5.2).
//
// Drive a REALISTIC existing settings.local.json (several user keys + a user-defined PreToolUse
// hook) through injectHook (allocating a real free port via Task 1) then restore, and assert the
// post-restore file is semantically EQUAL to the seeded original (zero loss, zero fork-hook residue).
// Also assert the mid-cycle (post-inject) file is valid JSON and a superset differing ONLY by the
// injected 127.0.0.1:<port> hook. Fully OFFLINE — temp dir per test, no claude spawn.
//
// node:test: build first, then
//   node --experimental-strip-types --test test/gate-roundtrip.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as SW from "../dist/gate/settings-writer.js";
import { findFreePort } from "../dist/gate/port.js";

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "fork-gate-roundtrip-"));
}

/** A realistic user settings.local.json: several unrelated keys + the user's own PreToolUse hook. */
function seedSettings() {
  return {
    permissions: { allow: ["Read", "Bash(npm run lint)"], deny: ["Read(./.env)"], defaultMode: "default" },
    model: "claude-sonnet-4",
    env: { FOO: "bar", BAZ: "qux" },
    enableAllProjectMcpServers: false,
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo user-pre" }] }],
      PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "echo user-post" }] }],
    },
  };
}

test("4.1 a realistic settings file round-trips through inject→restore with ZERO loss", async (t) => {
  const dir = await tmpDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const settingsPath = path.join(dir, "settings.local.json");
  const original = seedSettings();
  await fs.writeFile(settingsPath, JSON.stringify(original, null, 2) + "\n", "utf8");

  // Allocate a REAL verified-free port (Task 1) — the production allocation path.
  const port = await findFreePort();

  const backup = await SW.injectHook({ settingsPath, port });

  // ── mid-cycle (post-inject) assertions: valid JSON + superset differing only by the fork hook ──
  const midRaw = await fs.readFile(settingsPath, "utf8");
  let mid: ReturnType<typeof seedSettings> & { hooks: { PreToolUse: unknown[] } };
  assert.doesNotThrow(() => {
    mid = JSON.parse(midRaw);
  }, "post-inject file must be valid JSON");
  mid = JSON.parse(midRaw);
  // every original key/value still present
  assert.deepEqual(mid.permissions, original.permissions, "permissions intact mid-cycle");
  assert.equal(mid.model, original.model, "model intact mid-cycle");
  assert.deepEqual(mid.env, original.env, "env intact mid-cycle");
  assert.deepEqual(mid.hooks.PostToolUse, original.hooks.PostToolUse, "PostToolUse intact mid-cycle");
  // PreToolUse differs ONLY by the appended fork hook
  const midPre = mid.hooks.PreToolUse as unknown[];
  assert.equal(midPre.length, original.hooks.PreToolUse.length + 1, "exactly one extra hook mid-cycle");
  assert.deepEqual(midPre[0], original.hooks.PreToolUse[0], "user's own hook unchanged mid-cycle");
  const forkGroups = midPre.filter((g) => SW.isForkHookGroup(g));
  assert.equal(forkGroups.length, 1, "exactly one fork hook mid-cycle");
  assert.match(
    (forkGroups[0] as { hooks: { url: string }[] }).hooks[0].url,
    new RegExp(`127\\.0\\.0\\.1:${port}\\b`),
    "the injected hook carries the allocated 127.0.0.1:<port> endpoint",
  );

  // ── teardown: restore must be lossless and surgical ──
  const result = await SW.restore(backup);
  assert.equal(result.path, "surgical", "an existing file is restored surgically");

  const restored = JSON.parse(await fs.readFile(settingsPath, "utf8"));
  // R5.1 / R5.2 — semantic equality with the original (same keys/values, no leftover hook).
  assert.deepEqual(restored, original, "post-restore file must deep-equal the seeded original (lossless)");
});

test("4.1 the round-trip differs from the original ONLY by the fork hook at mid-cycle", async (t) => {
  const dir = await tmpDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const settingsPath = path.join(dir, "settings.local.json");
  const original = seedSettings();
  await fs.writeFile(settingsPath, JSON.stringify(original, null, 2) + "\n", "utf8");

  const port = await findFreePort();
  const backup = await SW.injectHook({ settingsPath, port });

  // Compute the mid-cycle doc with the fork hook surgically stripped — it must equal the original.
  const mid = JSON.parse(await fs.readFile(settingsPath, "utf8"));
  mid.hooks.PreToolUse = (mid.hooks.PreToolUse as unknown[]).filter((g) => !SW.isForkHookGroup(g));
  assert.deepEqual(mid, original, "stripping ONLY the fork hook yields exactly the original (R5.2)");

  await SW.restore(backup);
});

test("4.1 round-trip preserves an empty-hooks user file without inventing structure", async (t) => {
  const dir = await tmpDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const settingsPath = path.join(dir, "settings.local.json");
  const original = { model: "x", permissions: { allow: [] } }; // no hooks block at all
  await fs.writeFile(settingsPath, JSON.stringify(original, null, 2) + "\n", "utf8");

  const port = await findFreePort();
  const backup = await SW.injectHook({ settingsPath, port });
  await SW.restore(backup);

  const restored = JSON.parse(await fs.readFile(settingsPath, "utf8"));
  assert.deepEqual(restored, original, "a hooks-less user file is restored byte-/semantics-equivalent");
});
