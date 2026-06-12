// Story 028 / Sub-task 2.1 — background-defer the fresh-path transcript discovery.
//
// THE BUG: defaultStartEngine's fresh branch used to `await resolveWatchTarget(engine.sessionId)`
// with the DEFAULT 2000ms FATAL file-discovery watchdog. The Claude Code TUI writes
// `<sessionId>.jsonl` only on the user's FIRST interaction, so for a fresh session the transcript is
// absent at create time and the blocking await THROWS not-found after 2000ms → every new Zed session
// aborts. The fix: don't block — return as soon as the PTY is live, discover the transcript in the
// BACKGROUND under `watchdogMs: Infinity` (cancellable via a signal), and arm the watcher + fire the
// first onEvent only when the transcript appears.
//
// This drives the REAL defaultStartEngine (NOT a fake startEngine, and WITHOUT stubbing
// resolveWatchTarget — either would re-mask the bug). It injects only (1) a fake `spawn` so no real
// `claude` launches and (2) the `glob` seam (via locateOptions) so we control when the transcript
// "appears". It uses the REAL clock/sleep so the background poll yields the event loop every ~50ms
// (an injected immediate-sleep under Infinity with an always-empty glob would busy-loop and hang).
//
// node:test runner: `node --experimental-strip-types --test test/createsession-deferred-discovery.test.ts`
// (run `npm run build` first — behavioral imports resolve against ../dist).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultStartEngine } from "../dist/acp-agent.js";

/** A fake PTY handle — mirrors makeFakePty in the existing createSession tests. */
function makeFakePty() {
  return {
    onExit: () => ({ dispose() {} }),
    onData: () => ({ dispose() {} }),
    resize: () => {},
    write: () => {},
    kill: () => {},
  } as never;
}

/**
 * A fake `node-pty` spawn: returns a fake PTY handle so defaultStartEngine spawns NO real `claude`.
 * `createSessionEngine` calls `spawnClaudePty({ spawn })`; `spawnResumePty({ spawn })` calls it too —
 * both forward our fake here. The returned object only needs the IPty surface the engine touches.
 */
function makeFakeSpawn() {
  let spawnCount = 0;
  const spawn = (() => {
    spawnCount++;
    return makeFakePty();
  }) as never;
  return { spawn, spawnCount: () => spawnCount };
}

/**
 * A controllable glob stub for the locateTranscript seam. Starts returning `[]` (transcript absent —
 * the fresh-session reality before the first interaction); flip it via `appear(path)` to simulate the
 * TUI writing the transcript on the user's first interaction. Records how many times it was polled.
 */
function makeControllableGlob() {
  let result: string[] = [];
  let polls = 0;
  const glob = (_sessionId: string): string[] => {
    polls++;
    return result;
  };
  return {
    glob,
    polls: () => polls,
    appear: (path: string) => {
      result = [path];
    },
  };
}

/** Write a real tmp transcript carrying a `.cwd`-bearing JSONL line (so the watcher arms on content). */
function makeFixtureTranscript(sessionId: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "deferred-discovery-"));
  const path = join(dir, `${sessionId}.jsonl`);
  // A content line: a real assistant message carrying `.cwd` so readCwdFromInside resolves it.
  const line = JSON.stringify({
    type: "assistant",
    uuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    cwd: "/runtime/cwd/from/inside",
    message: { role: "assistant", content: [{ type: "text", text: "hello from the transcript" }] },
  });
  writeFileSync(path, line + "\n");
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("fresh createSession RESOLVES while the transcript is still absent, watcher undefined (R1.1/R1.2)", async () => {
  // RED DRIVER: against the pre-fix BLOCKING fresh path this REJECTS with not-found after the
  // file-discovery watchdog. With the deferred fix, the discovery is backgrounded under
  // watchdogMs:Infinity, so defaultStartEngine RESOLVES immediately even though glob() === [].
  const { spawn } = makeFakeSpawn();
  const g = makeControllableGlob(); // starts [] → transcript absent at create time (fresh reality)
  const sessions = new Map();

  // Capture the (later) background arm so the test can WAIT for the poll to terminate before exiting.
  // cleanup() does NOT abort the poll yet (that is sub-task 3.1), so an always-empty glob would leave
  // an unbounded poll spinning every ~50ms and the node:test process would never exit. We therefore
  // let the glob EVENTUALLY appear AFTER capturing the resolves-while-absent evidence — the poll then
  // resolves and the event loop drains.
  let resolveArmed!: () => void;
  const armed = new Promise<void>((res) => {
    resolveArmed = res;
  });

  const started = await defaultStartEngine({
    cwd: "/host/work/dir",
    spawn,
    sessions,
    onEvent: () => resolveArmed(),
    locateOptions: { glob: g.glob },
  });

  // THE RED-DRIVER ASSERTIONS — captured while glob() is STILL [] (the transcript has not appeared):
  // the fresh path returned WITHOUT waiting for the transcript, with no watcher armed.
  assert.ok(started, "fresh defaultStartEngine resolved without waiting for the transcript");
  assert.ok(started.sessionId, "a spawn-generated sessionId is returned");
  assert.equal(started.watcher, undefined, "the watcher is NOT armed yet (transcript absent)");
  assert.ok(started.engine, "the owning SessionEngine is returned");
  assert.equal(started.cwd, "/host/work/dir", "fresh return falls back to the known host cwd");
  assert.equal(g.polls() >= 0, true); // (the background poll is running; appearance is below)

  // Let the transcript appear so the dangling background poll terminates (process can then exit).
  const fixture = makeFixtureTranscript(started.sessionId);
  try {
    g.appear(fixture.path);
    await armed; // the background poll found it and armed the watcher → loop ended
    started.engine?.cleanup();
    started.engine?.kill();
  } finally {
    fixture.cleanup();
  }
});

test("on first interaction the transcript appears → watcher arms + onEvent fires once (R1.3)", async () => {
  const { spawn } = makeFakeSpawn();
  const g = makeControllableGlob();
  const sessions = new Map();

  // A promise that resolves the moment our injected onEvent fires, carrying the emitted sessionId.
  let resolveEvent!: (sid: string) => void;
  const eventFired = new Promise<string>((res) => {
    resolveEvent = res;
  });
  let eventCount = 0;
  const onEvent = (sid: string) => {
    eventCount++;
    resolveEvent(sid);
  };

  const started = await defaultStartEngine({
    cwd: "/host/work/dir",
    spawn,
    sessions,
    onEvent,
    locateOptions: { glob: g.glob },
  });

  // Fresh path returned immediately: transcript absent, watcher not yet armed.
  assert.equal(started.watcher, undefined, "watcher absent until the transcript appears");

  // Simulate the user's FIRST interaction: the TUI now writes a real transcript carrying content.
  const fixture = makeFixtureTranscript(started.sessionId);
  try {
    g.appear(fixture.path);

    // The background poll (real ~50ms cadence) should now find it, arm the watcher, and fire onEvent.
    const emittedSid = await eventFired;

    assert.equal(emittedSid, started.sessionId, "onEvent fired with the engine's sessionId");
    assert.equal(eventCount, 1, "onEvent fired exactly once on appearance (the initial-content pump)");
    assert.ok(started.engine?.watcher, "the engine's watcher is now armed against the real transcript");
  } finally {
    started.engine?.cleanup();
    started.engine?.kill();
    fixture.cleanup();
  }
});

test("resume STILL resolves synchronously with the watcher armed (R2 — unchanged)", async () => {
  // Resume keeps the DEFAULT 2000ms fatal watchdog and awaits discovery on the create path. With a
  // glob whose FIRST poll already matches the (already-existing) transcript, it resolves at once.
  const { spawn } = makeFakeSpawn();
  const sessionId = "33333333-3333-4333-8333-333333333333";
  const fixture = makeFixtureTranscript(sessionId);
  try {
    const started = await defaultStartEngine({
      resume: true,
      sessionId,
      cwd: "/host/work/dir",
      spawn,
      locateOptions: { glob: () => [fixture.path] },
    });

    assert.equal(started.sessionId, sessionId, "resume keeps the requested sessionId");
    assert.ok(started.watcher, "resume arms the watcher SYNCHRONOUSLY (first glob already matches)");
    assert.equal(
      started.cwd,
      "/runtime/cwd/from/inside",
      "resume reads the runtime cwd from inside the existing transcript",
    );

    started.engine?.cleanup();
    started.engine?.kill();
  } finally {
    fixture.cleanup();
  }
});
