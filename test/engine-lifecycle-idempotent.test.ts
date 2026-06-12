// Story 014 / Task 1.2 — cleanup runs exactly once and leaves no residual handles (R1.2, R1.3).
// node:test runner: `node --experimental-strip-types --test test/engine-lifecycle-idempotent.test.ts`
// (run `npm run build` first — behavioral imports resolve against ../dist).
//
// Scope note: the resize-debounce timer is wired in Task 2; the "armed timer is cleared on
// cleanup" audit lives in engine-resize-debounce.test.ts (which owns requestResize). Here the
// residual-handle proof is behavioral: a second teardown trigger (onExit after an explicit
// cleanup) tears nothing down again — no watcher re-stop, no session-map churn.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionEngine } from "../dist/engine-lifecycle.js";
import { makeFakePty, makeFakeWatcher } from "./lifecycle-fakes.ts";

test("cleanup is idempotent: the teardown body runs once across two calls (R1.2)", () => {
  const { pty } = makeFakePty();
  const { watcher, stopCount } = makeFakeWatcher();
  const sessions = new Map<string, SessionEngine>();
  let bodyCount = 0;

  const eng = new SessionEngine({
    handle: { sessionId: "S1", pty },
    watcher,
    sessions,
    onCleanup: () => {
      bodyCount++;
    },
  });

  eng.cleanup();
  eng.cleanup(); // second call (e.g. explicit kill then onExit) must be a no-op

  assert.equal(bodyCount, 1, "the cleanup body executed exactly once");
  assert.equal(stopCount(), 1, "the watcher was stopped exactly once");
  assert.equal(sessions.has("S1"), false, "the session-map entry was deleted");
  assert.equal(eng.isDisposed, true, "the engine reports disposed after cleanup");
});

test("cleanup is a no-op when onExit fires AFTER an explicit cleanup (R1.2)", () => {
  const { pty, fireExit } = makeFakePty();
  const { watcher, stopCount } = makeFakeWatcher();
  let bodyCount = 0;

  const eng = new SessionEngine({
    handle: { sessionId: "S1", pty },
    watcher,
    onCleanup: () => {
      bodyCount++;
    },
  });

  eng.cleanup(); // explicit teardown
  fireExit({ exitCode: 0, signal: 9 }); // subsequent process exit

  assert.equal(bodyCount, 1, "onExit after an explicit cleanup does not re-run the body");
  assert.equal(stopCount(), 1, "the watcher is not stopped twice");
});

test("no residual handles: a second onExit after teardown tears nothing down again (R1.3)", () => {
  const { pty, fireExit } = makeFakePty();
  const { watcher, stopCount } = makeFakeWatcher();
  const sessions = new Map<string, SessionEngine>();
  let bodyCount = 0;

  const eng = new SessionEngine({
    handle: { sessionId: "S1", pty },
    watcher,
    sessions,
    onCleanup: () => {
      bodyCount++;
    },
  });

  fireExit({ exitCode: 0, signal: 0 }); // first exit → full teardown
  assert.equal(sessions.has("S1"), false, "the session entry is released on first teardown");

  // A second exit signal must find nothing left to release.
  assert.doesNotThrow(() => fireExit({ exitCode: 0, signal: 0 }));
  assert.equal(bodyCount, 1, "the cleanup body never runs a second time");
  assert.equal(stopCount(), 1, "no residual watcher subscription to stop again");
  assert.equal(eng.isDisposed, true);
});
