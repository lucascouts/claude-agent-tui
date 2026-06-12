// Story 014 / Task 1.1 — wire p.onExit to a single cleanup routine (R1.1).
// node:test runner: `node --experimental-strip-types --test test/engine-lifecycle-onexit.test.ts`
// (run `npm run build` first — behavioral imports resolve against ../dist).
import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionEngine } from "../dist/engine-lifecycle.js";
import { makeFakePty, makeFakeWatcher } from "./lifecycle-fakes.ts";

test("onExit: firing the captured callback runs cleanup once for the session id (R1.1)", () => {
  const { pty, fireExit, calls } = makeFakePty();
  const { watcher, stopCount } = makeFakeWatcher();
  const sessions = new Map<string, SessionEngine>();
  let cleanedWith: string | undefined;

  new SessionEngine({
    handle: { sessionId: "S1", pty },
    watcher,
    sessions,
    onCleanup: (info) => {
      cleanedWith = info.sessionId;
    },
  });

  assert.equal(calls.onExitCount, 1, "the engine registers exactly one onExit handler");
  assert.equal(sessions.has("S1"), true, "the engine registers itself in the live session map");

  fireExit({ exitCode: 0, signal: 0 });

  assert.equal(cleanedWith, "S1", "cleanup runs with the session id");
  assert.equal(stopCount(), 1, "the JSONL watcher is stopped exactly once");
  assert.equal(sessions.has("S1"), false, "the session-map entry is deleted on cleanup");
});

test("onExit: exitCode/signal are forwarded to the cleanup hook for diagnostics", () => {
  const { pty, fireExit } = makeFakePty();
  const { watcher } = makeFakeWatcher();
  let captured: { exitCode?: number; signal?: number } | undefined;

  new SessionEngine({
    handle: { sessionId: "S2", pty },
    watcher,
    onCleanup: (info) => {
      captured = { exitCode: info.exitCode, signal: info.signal };
    },
  });

  fireExit({ exitCode: 137, signal: 9 });

  assert.deepEqual(captured, { exitCode: 137, signal: 9 }, "diagnostics carry exitCode and signal");
});

test("onExit: cleanup tolerates a session with no watcher attached yet", () => {
  const { pty, fireExit } = makeFakePty();
  const sessions = new Map<string, SessionEngine>();

  new SessionEngine({ handle: { sessionId: "S3", pty }, sessions });

  assert.doesNotThrow(() => fireExit({ exitCode: 0, signal: 0 }), "no watcher must not throw");
  assert.equal(sessions.has("S3"), false, "the session-map entry is still released");
});
