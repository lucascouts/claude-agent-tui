// Story 046 (R3.4 LIVE FIX) — the in-place re-spawn must DEFER transcript discovery.
//
// THE BUG (observed live, Zed.log 2026-06-17): a `default_config_options.mode = bypassPermissions`
// makes Zed send set_config_option(configId:"mode") at BOOT, before the first interaction. bypass is
// not on the Shift+Tab cycle, so the fork re-spawns in place (respawnSession → startEngine resume).
// The resume branch awaited discovery with the DEFAULT 2000ms FATAL watchdog — but the freshly
// re-spawned claude has NOT written its transcript yet (the TUI writes it only on the first
// interaction). So discovery threw "Transcript not found after 2048ms", the re-spawn failed, and the
// next prompt stalled until the 120000ms turn watchdog tripped.
//
// THE FIX: the re-spawn is flagged `inPlaceRespawn: true`. The resume branch then mirrors the fresh
// path (story 028): return as soon as the PTY is live and DISCOVER in the BACKGROUND under
// watchdogMs:Infinity, arming the watcher + firing onEvent when the transcript appears — never
// tripping the blocking 2000ms watchdog. The fork/resume path (no flag) is UNCHANGED — its 2000ms
// fatal watchdog is locked by resume-discovery-unchanged.test.ts (R2.1), which must stay green.
//
// This drives the REAL defaultStartEngine (no fake startEngine, no stubbed resolveWatchTarget — either
// would re-mask the bug). It injects only a fake `spawn` (no real claude) and the `glob` seam. The
// background poll uses the REAL clock/sleep (~50ms cadence), so the glob is made to APPEAR after the
// resolves-while-absent evidence is captured, letting the poll terminate so node:test can exit.
//
// node:test runner: `node --experimental-strip-types --test test/respawn-defer-discovery.test.ts`
// (run `npm run build` first — behavioral imports resolve against ../dist).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultStartEngine } from "../dist/acp-agent.js";

/** A fake PTY handle — mirrors the existing createSession/resume discovery tests. */
function makeFakePty() {
  return {
    onExit: () => ({ dispose() {} }),
    onData: () => ({ dispose() {} }),
    resize: () => {},
    write: () => {},
    kill: () => {},
  } as never;
}

/** A fake node-pty spawn so spawnResumePty launches NO real `claude`. */
function makeFakeSpawn() {
  return (() => makeFakePty()) as never;
}

/**
 * A controllable glob stub: starts `[]` (the re-spawned claude has not written its transcript yet —
 * the boot-bypass reality), flip via `appear(path)` to simulate the first interaction materialising it.
 */
function makeControllableGlob() {
  let result: string[] = [];
  const glob = (_sessionId: string): string[] => result;
  return { glob, appear: (path: string) => (result = [path]) };
}

/** Write a real tmp transcript carrying a `.cwd`-bearing JSONL line (so the watcher arms on content). */
function makeFixtureTranscript(sessionId: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "respawn-defer-"));
  const path = join(dir, `${sessionId}.jsonl`);
  const line = JSON.stringify({
    type: "assistant",
    uuid: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    cwd: "/runtime/cwd/from/inside",
    message: { role: "assistant", content: [{ type: "text", text: "re-spawned transcript" }] },
  });
  writeFileSync(path, line + "\n");
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("in-place re-spawn with NO transcript yet DEFERS discovery — never trips the 2000ms watchdog (R3.4 boot bypass)", { timeout: 12000 }, async () => {
  // RED DRIVER: against the pre-fix code `inPlaceRespawn` is ignored, so the resume branch blocks on
  // the DEFAULT 2000ms watchdog and — glob() === [] — REJECTS with not-found (the live stall). With
  // the deferred fix, discovery is backgrounded under watchdogMs:Infinity, so defaultStartEngine
  // RESOLVES immediately with the watcher not yet armed, arming it when the transcript appears.
  const sessionId = "77777777-7777-4777-8777-777777777777";
  const g = makeControllableGlob(); // [] → transcript absent (re-spawn before the first interaction)

  let resolveArmed!: () => void;
  const armed = new Promise<void>((res) => (resolveArmed = res));

  const started = await defaultStartEngine({
    resume: true,
    inPlaceRespawn: true,
    sessionId,
    cwd: "/host/work/dir",
    spawn: makeFakeSpawn(),
    sessions: new Map(),
    onEvent: () => resolveArmed(),
    locateOptions: { glob: g.glob }, // REAL clock/sleep — the background poll yields ~50ms
  });

  // Captured while glob() is STILL [] — the re-spawn returned WITHOUT waiting for the transcript.
  assert.ok(started, "in-place re-spawn resolved without waiting for the transcript");
  assert.equal(started.sessionId, sessionId, "the re-spawn keeps the requested sessionId");
  assert.equal(started.watcher, undefined, "watcher deferred — NOT armed synchronously (transcript absent)");
  assert.ok(started.engine, "the owning SessionEngine is returned");
  assert.equal(started.cwd, "/host/work/dir", "deferred return falls back to the known host cwd");

  // First interaction: the transcript appears → the background poll arms the watcher + fires onEvent.
  const fixture = makeFixtureTranscript(sessionId);
  try {
    g.appear(fixture.path);
    await armed; // the background poll found it and armed the watcher → loop ended
    assert.ok(started.engine?.watcher, "the watcher is armed once the transcript appears");
    started.engine?.cleanup();
    started.engine?.kill();
  } finally {
    fixture.cleanup();
  }
});

test("in-place re-spawn with an EXISTING transcript arms the watcher in the background (idle mid-session switch)", { timeout: 12000 }, async () => {
  // A mode/effort switch AFTER the first interaction: the transcript already exists. The deferred path
  // discovers it on the first background poll and arms the watcher (asynchronously, not synchronously).
  const sessionId = "88888888-8888-4888-8888-888888888888";
  const fixture = makeFixtureTranscript(sessionId);

  let resolveArmed!: () => void;
  const armed = new Promise<void>((res) => (resolveArmed = res));

  try {
    const started = await defaultStartEngine({
      resume: true,
      inPlaceRespawn: true,
      sessionId,
      cwd: "/host/work/dir",
      spawn: makeFakeSpawn(),
      sessions: new Map(),
      onEvent: () => resolveArmed(),
      locateOptions: { glob: () => [fixture.path] }, // already present → first poll matches
    });

    assert.equal(started.sessionId, sessionId, "the re-spawn keeps the requested sessionId");
    await armed; // background poll matched immediately and armed
    assert.ok(started.engine?.watcher, "watcher armed against the existing transcript");
    started.engine?.cleanup();
    started.engine?.kill();
  } finally {
    fixture.cleanup();
  }
});
