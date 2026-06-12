// Story 032 / Task 3.2 — teardown surgically removes the fork hook, falls back to backup (R4.2, R4.3).
//
// restore(backup): re-read the on-disk file; surgically delete ONLY the fork's marked group
// (preserving later user edits) and report 'surgical'; on a corrupt/unparseable file, fall back to
// the captured prior bytes and report 'backup'. Fully OFFLINE — temp dirs, no claude spawn.
//
// node:test: build first, then
//   node --experimental-strip-types --test test/gate-restore.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as SW from "../dist/gate/settings-writer.js";

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "fork-gate-restore-"));
}

test("3.2 inject→restore on an existing file: fork hook gone, prior preserved, reports 'surgical'", async (t) => {
  const dir = await tmpDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const settingsPath = path.join(dir, "settings.local.json");
  const prior = { model: "x", permissions: { allow: ["Read"] } };
  await fs.writeFile(settingsPath, JSON.stringify(prior, null, 2) + "\n", "utf8");

  const backup = await SW.injectHook({ settingsPath, port: 45678 });
  const result = await SW.restore(backup);

  assert.equal(result.path, "surgical", "an existing parseable file is restored surgically");
  const onDisk = JSON.parse(await fs.readFile(settingsPath, "utf8"));
  assert.equal(onDisk.model, "x", "prior key preserved");
  assert.deepEqual(onDisk.permissions, prior.permissions, "prior permissions preserved");
  // zero fork-hook residue
  const pre = (onDisk.hooks?.PreToolUse ?? []) as unknown[];
  assert.ok(!pre.some((g) => SW.isForkHookGroup(g)), "no fork-hook residue after restore");
});

test("3.2 a post-inject user edit SURVIVES restore — only the fork hook is removed (R4.3)", async (t) => {
  const dir = await tmpDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const settingsPath = path.join(dir, "settings.local.json");
  await fs.writeFile(settingsPath, JSON.stringify({ model: "x" }), "utf8");

  const backup = await SW.injectHook({ settingsPath, port: 45678 });

  // Simulate the user editing settings.local.json AFTER inject (adds a key + their own hook).
  const mid = JSON.parse(await fs.readFile(settingsPath, "utf8"));
  mid.newUserKey = "added-later";
  mid.hooks.PreToolUse.push({ matcher: "Edit", hooks: [{ type: "command", command: "echo edit" }] });
  await fs.writeFile(settingsPath, JSON.stringify(mid, null, 2) + "\n", "utf8");

  const result = await SW.restore(backup);

  assert.equal(result.path, "surgical", "surgical removal preserves the later edits");
  const onDisk = JSON.parse(await fs.readFile(settingsPath, "utf8"));
  assert.equal(onDisk.newUserKey, "added-later", "the user's later key SURVIVES restore");
  const pre = onDisk.hooks.PreToolUse as unknown[];
  assert.ok(!pre.some((g) => SW.isForkHookGroup(g)), "the fork hook is removed");
  assert.ok(
    pre.some((g) => (g as { matcher?: string }).matcher === "Edit"),
    "the user's later-added hook SURVIVES",
  );
});

test("3.2 absent-before-inject file is DELETED on restore (zero residue, not an empty husk)", async (t) => {
  const dir = await tmpDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const settingsPath = path.join(dir, "settings.local.json");

  const backup = await SW.injectHook({ settingsPath, port: 45678 }); // creates the file
  await SW.restore(backup);

  // The fork created the file; restore must leave NO file behind (the prior state was absence).
  await assert.rejects(() => fs.readFile(settingsPath, "utf8"), /ENOENT/, "file removed on restore");
});

test("3.2 a corrupted post-inject file triggers the 'backup' fallback restoring prior bytes", async (t) => {
  const dir = await tmpDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const settingsPath = path.join(dir, "settings.local.json");
  const priorText = JSON.stringify({ model: "x", keep: true }, null, 2) + "\n";
  await fs.writeFile(settingsPath, priorText, "utf8");

  const backup = await SW.injectHook({ settingsPath, port: 45678 });

  // Corrupt the file AFTER inject so surgical parse cannot isolate the fork entry.
  await fs.writeFile(settingsPath, "{ this is not <<< valid json", "utf8");

  const result = await SW.restore(backup);

  assert.equal(result.path, "backup", "an unparseable file forces the backup fallback");
  const restored = await fs.readFile(settingsPath, "utf8");
  assert.equal(restored, priorText, "the EXACT prior bytes are restored on the backup path");
});

test("3.2 restore is idempotent — a second restore does not throw or resurrect the hook", async (t) => {
  const dir = await tmpDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const settingsPath = path.join(dir, "settings.local.json");
  await fs.writeFile(settingsPath, JSON.stringify({ model: "x" }), "utf8");

  const backup = await SW.injectHook({ settingsPath, port: 45678 });
  await SW.restore(backup);
  const second = await SW.restore(backup); // re-running teardown must be safe

  assert.ok(second.path === "surgical" || second.path === "backup", "a second restore is a safe no-op");
  const onDisk = JSON.parse(await fs.readFile(settingsPath, "utf8"));
  const pre = (onDisk.hooks?.PreToolUse ?? []) as unknown[];
  assert.ok(!pre.some((g) => SW.isForkHookGroup(g)), "still no fork-hook residue after a second restore");
});
