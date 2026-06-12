// Story 032 / Task 3.1 — capture backup + durable before-spawn write (R3.1, R3.2, R4.1).
//
// injectHook({settingsPath, port}) snapshots the prior file (bytes or absence) into a Backup, then
// durably writes the merged settings.local.json. The write is observable on disk before the promise
// resolves (durability contract). Fully OFFLINE — temp dirs, no claude spawn.
//
// node:test: build first, then
//   node --experimental-strip-types --test test/gate-inject.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as SW from "../dist/gate/settings-writer.js";

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "fork-gate-inject-"));
}

test("3.1 existing file: backup carries EXACT prior bytes and disk now contains the hook", async (t) => {
  const dir = await tmpDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const settingsPath = path.join(dir, "settings.local.json");
  const priorText = JSON.stringify({ model: "x", permissions: { allow: ["Read"] } }, null, 2) + "\n";
  await fs.writeFile(settingsPath, priorText, "utf8");

  const backup = await SW.injectHook({ settingsPath, port: 45678 });

  assert.equal(backup.existed, true, "backup must record the file existed");
  assert.equal(backup.priorBytes?.toString("utf8"), priorText, "backup must carry the EXACT prior bytes");

  // The write is durable: read it back from disk after the promise resolved.
  const onDisk = JSON.parse(await fs.readFile(settingsPath, "utf8"));
  assert.equal(onDisk.model, "x", "user key preserved on disk");
  const pre = onDisk.hooks.PreToolUse as unknown[];
  assert.ok(pre.some((g) => SW.isForkHookGroup(g)), "the fork hook is present on disk");
  const forkGroup = pre.find((g) => SW.isForkHookGroup(g)) as { hooks: { url: string }[] };
  assert.match(forkGroup.hooks[0].url, /127\.0\.0\.1:45678/, "the on-disk hook targets the given port");
});

test("3.1 absent file: backup records absence and the file is created with only the hook", async (t) => {
  const dir = await tmpDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const settingsPath = path.join(dir, "settings.local.json");

  const backup = await SW.injectHook({ settingsPath, port: 51000 });

  assert.equal(backup.existed, false, "backup must record the file did NOT exist");
  assert.equal(backup.priorBytes, null, "no prior bytes for an absent file");

  const onDisk = JSON.parse(await fs.readFile(settingsPath, "utf8"));
  assert.deepEqual(Object.keys(onDisk), ["hooks"], "a minimal file with only hooks is created");
  const pre = onDisk.hooks.PreToolUse as unknown[];
  assert.equal(pre.length, 1);
  assert.equal(SW.isForkHookGroup(pre[0]), true);
});

test("3.1 the merged file is valid JSON observable on disk BEFORE resolve (durability)", async (t) => {
  const dir = await tmpDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const settingsPath = path.join(dir, "settings.local.json");

  await SW.injectHook({ settingsPath, port: 49999 });
  // If the promise resolved, the bytes are already flushed — parsing must succeed immediately.
  const raw = await fs.readFile(settingsPath, "utf8");
  assert.doesNotThrow(() => JSON.parse(raw), "the on-disk file must be valid JSON right after resolve");
});

test("3.1 a user's own PreToolUse hook in an existing file is preserved through inject", async (t) => {
  const dir = await tmpDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const settingsPath = path.join(dir, "settings.local.json");
  const userHook = { matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] };
  await fs.writeFile(settingsPath, JSON.stringify({ hooks: { PreToolUse: [userHook] } }), "utf8");

  await SW.injectHook({ settingsPath, port: 45678 });

  const onDisk = JSON.parse(await fs.readFile(settingsPath, "utf8"));
  const pre = onDisk.hooks.PreToolUse as unknown[];
  assert.equal(pre.length, 2, "user hook + fork hook on disk");
  assert.deepEqual(pre[0], userHook, "the user's own hook survives inject verbatim");
});
