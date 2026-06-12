// Story 033 / Task 4.2 — the hook is injected via a SCRATCH `--settings <file>` and the user's REAL
// `~/.claude/settings.json` / `settings.local.json` are only READ, never written (R6.2).
//
// This is the non-destructive-settings guarantee the whole gate rests on (blocker c, SOLVED in
// Degrau 0 / story 032): a permission gate that corrupted the user's real config would be worse than
// no gate. The injector is `injectHook` (story 032 settings-writer), which mutates ONLY the path it is
// handed. Here we (1) plant a fake $HOME/.claude with realistic settings.json + settings.local.json,
// (2) inject the fork hook into a SCRATCH file under a separate scratch dir, and (3) assert the two
// real files are byte-for-byte AND mtime unchanged. If a write to the real config were ever detected,
// the mtime/bytes assertions fail the validation (the §16/R6.2 contract).
//
// Fully OFFLINE — temp dirs, a real free port via story-032 findFreePort, no claude spawn, no Zed.
//
// node:test: build first, then
//   node --experimental-strip-types --test test/settings-nondestructive.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { injectHook, restore, isForkHookGroup } from "../dist/gate/settings-writer.js";
import { findFreePort } from "../dist/gate/port.js";

/** A fresh temp dir per test, cleaned up in `t.after`. */
async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** A realistic user `~/.claude/settings.json` (global) — several keys + the user's own hook. */
function realGlobalSettings() {
  return {
    model: "claude-sonnet-4",
    permissions: { allow: ["Read", "Bash(npm run lint)"], deny: ["Read(./.env)"], defaultMode: "default" },
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo user-global-pre" }] }],
    },
  };
}

/** A realistic user `~/.claude/settings.local.json` (project-local) — distinct keys + its own hook. */
function realLocalSettings() {
  return {
    env: { FOO: "bar" },
    enableAllProjectMcpServers: false,
    hooks: {
      PreToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "echo user-local-pre" }] }],
    },
  };
}

/** Plant the two REAL user config files in a fake $HOME/.claude and return their paths + snapshots. */
async function plantRealConfig(home: string): Promise<{
  globalPath: string;
  localPath: string;
  globalBytes: Buffer;
  localBytes: Buffer;
  globalMtimeMs: number;
  localMtimeMs: number;
}> {
  const claudeDir = path.join(home, ".claude");
  await fs.mkdir(claudeDir, { recursive: true });
  const globalPath = path.join(claudeDir, "settings.json");
  const localPath = path.join(claudeDir, "settings.local.json");
  await fs.writeFile(globalPath, JSON.stringify(realGlobalSettings(), null, 2) + "\n", "utf8");
  await fs.writeFile(localPath, JSON.stringify(realLocalSettings(), null, 2) + "\n", "utf8");
  const globalBytes = await fs.readFile(globalPath);
  const localBytes = await fs.readFile(localPath);
  const globalStat = await fs.stat(globalPath);
  const localStat = await fs.stat(localPath);
  return {
    globalPath,
    localPath,
    globalBytes,
    localBytes,
    globalMtimeMs: globalStat.mtimeMs,
    localMtimeMs: localStat.mtimeMs,
  };
}

test("4.2 injecting the hook writes the SCRATCH file and leaves the real ~/.claude/settings*.json untouched (bytes + mtime)", async (t) => {
  const home = await tmpDir("fork-perms-home-");
  const scratchDir = await tmpDir("fork-perms-scratch-");
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  t.after(() => fs.rm(scratchDir, { recursive: true, force: true }));

  // (1) Plant realistic REAL user config that MUST NOT be touched.
  const real = await plantRealConfig(home);

  // Pause so any (forbidden) write to the real files would move their mtime measurably.
  await new Promise((r) => setTimeout(r, 25));

  // (2) Inject the fork hook into a SCRATCH `--settings <file>` (NOT the real config path).
  const scratchPath = path.join(scratchDir, "settings.local.json");
  const port = await findFreePort();
  const backup = await injectHook({ settingsPath: scratchPath, port });

  // (3a) The SCRATCH file carries the fork hook targeting the allocated loopback port.
  const scratchOnDisk = JSON.parse(await fs.readFile(scratchPath, "utf8"));
  const scratchPre = scratchOnDisk.hooks.PreToolUse as unknown[];
  assert.ok(scratchPre.some((g) => isForkHookGroup(g)), "the scratch file carries the fork hook");
  const forkGroup = scratchPre.find((g) => isForkHookGroup(g)) as { hooks: { url: string }[] };
  assert.match(forkGroup.hooks[0].url, new RegExp(`127\\.0\\.0\\.1:${port}`), "scratch hook targets the loopback port");

  // (3b) The REAL global + local user config are byte-for-byte UNCHANGED — only READ, never written.
  const globalNow = await fs.readFile(real.globalPath);
  const localNow = await fs.readFile(real.localPath);
  assert.ok(globalNow.equals(real.globalBytes), "the real ~/.claude/settings.json is byte-for-byte unchanged");
  assert.ok(localNow.equals(real.localBytes), "the real ~/.claude/settings.local.json is byte-for-byte unchanged");

  // (3c) mtime is unchanged — a write to the real config (even same-bytes) would have moved it.
  const globalStatNow = await fs.stat(real.globalPath);
  const localStatNow = await fs.stat(real.localPath);
  assert.equal(globalStatNow.mtimeMs, real.globalMtimeMs, "the real settings.json mtime is unchanged (never written)");
  assert.equal(localStatNow.mtimeMs, real.localMtimeMs, "the real settings.local.json mtime is unchanged (never written)");

  // The scratch path the hook lives in is NOT under the real ~/.claude dir.
  assert.ok(!scratchPath.startsWith(path.join(home, ".claude")), "the hook is injected via a scratch file outside ~/.claude");

  // Teardown of the SCRATCH file also never touches the real config.
  await restore(backup);
  const globalAfterRestore = await fs.readFile(real.globalPath);
  const localAfterRestore = await fs.readFile(real.localPath);
  assert.ok(globalAfterRestore.equals(real.globalBytes), "restore() leaves the real settings.json untouched");
  assert.ok(localAfterRestore.equals(real.localBytes), "restore() leaves the real settings.local.json untouched");
  const globalStatAfter = await fs.stat(real.globalPath);
  const localStatAfter = await fs.stat(real.localPath);
  assert.equal(globalStatAfter.mtimeMs, real.globalMtimeMs, "real settings.json mtime still unchanged after restore");
  assert.equal(localStatAfter.mtimeMs, real.localMtimeMs, "real settings.local.json mtime still unchanged after restore");
});

test("4.2 a scratch file that did NOT exist before is created and fully removed on restore (no residue near the real config)", async (t) => {
  const home = await tmpDir("fork-perms-home2-");
  const scratchDir = await tmpDir("fork-perms-scratch2-");
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  t.after(() => fs.rm(scratchDir, { recursive: true, force: true }));

  const real = await plantRealConfig(home);
  await new Promise((r) => setTimeout(r, 25));

  const scratchPath = path.join(scratchDir, "settings.local.json");
  const port = await findFreePort();

  // The scratch file does not exist yet — inject creates it, restore deletes it (it created the file).
  const backup = await injectHook({ settingsPath: scratchPath, port });
  assert.equal(backup.existed, false, "the scratch file did not exist before inject");

  await restore(backup);
  await assert.rejects(fs.access(scratchPath), "the fork-created scratch file is fully removed on restore");

  // The real config is still pristine after the full create→remove cycle on the scratch file.
  const globalNow = await fs.readFile(real.globalPath);
  const localNow = await fs.readFile(real.localPath);
  assert.ok(globalNow.equals(real.globalBytes), "real settings.json untouched across the scratch create→remove cycle");
  assert.ok(localNow.equals(real.localBytes), "real settings.local.json untouched across the scratch create→remove cycle");
  const globalStatNow = await fs.stat(real.globalPath);
  assert.equal(globalStatNow.mtimeMs, real.globalMtimeMs, "real settings.json mtime unchanged across the cycle");
});
