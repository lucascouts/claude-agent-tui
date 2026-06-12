// Story 014 / Task 2.1 — debounced p.resize with a 120x40 default, dropped after exit (R2.1-R2.3).
// node:test runner: `node --experimental-strip-types --test test/engine-resize-debounce.test.ts`
// (run `npm run build` first — behavioral imports resolve against ../dist).
import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionEngine } from "../dist/engine-lifecycle.js";
import { makeFakePty, makeFakeWatcher, makeFakeTimers } from "./lifecycle-fakes.ts";

function engineWithTimers() {
  const fp = makeFakePty();
  const { watcher } = makeFakeWatcher();
  const timers = makeFakeTimers();
  const eng = new SessionEngine({
    handle: { sessionId: "S1", pty: fp.pty },
    watcher,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });
  return { eng, calls: fp.calls, timers };
}

test("debounce: three requestResize calls coalesce to one p.resize with the LAST size (R2.2)", () => {
  const { eng, calls, timers } = engineWithTimers();

  eng.requestResize(80, 24);
  eng.requestResize(100, 30);
  eng.requestResize(132, 43);

  assert.equal(calls.resize.length, 0, "nothing is applied before the debounce window elapses");
  timers.flush();

  assert.equal(calls.resize.length, 1, "exactly one resize after the window");
  assert.deepEqual(
    calls.resize[0],
    { cols: 132, rows: 43 },
    "only the last requested size applied",
  );
});

test("debounce: no size provided falls back to the 120x40 default (R2.1)", () => {
  const { eng, calls, timers } = engineWithTimers();

  eng.requestResize();
  timers.flush();

  assert.equal(calls.resize.length, 1);
  assert.deepEqual(calls.resize[0], { cols: 120, rows: 40 }, "default geometry is 120x40 (§5)");
});

test("debounce: a resize requested AFTER dispose is dropped without throwing (R2.3)", () => {
  const { eng, calls, timers } = engineWithTimers();

  eng.cleanup();
  assert.doesNotThrow(() => eng.requestResize(80, 24), "post-exit resize must not throw");
  timers.flush();

  assert.equal(calls.resize.length, 0, "no resize is applied after the PTY has exited");
});

test("debounce: cleanup clears an armed resize timer so it never fires post-teardown (R1.3)", () => {
  const { eng, calls, timers } = engineWithTimers();

  eng.requestResize(90, 28); // arm the debounce
  assert.equal(timers.pendingCount(), 1, "a resize timer is armed");

  eng.cleanup(); // must clear it
  assert.equal(timers.pendingCount(), 0, "cleanup cleared the armed resize timer (no residual)");

  timers.flush();
  assert.equal(calls.resize.length, 0, "the cleared timer does not fire after cleanup");
});

test("debounce: a second window after one fired applies the next size (timer re-arms cleanly)", () => {
  const { eng, calls, timers } = engineWithTimers();

  eng.requestResize(100, 30);
  timers.flush();
  eng.requestResize(110, 35);
  timers.flush();

  assert.deepEqual(calls.resize, [
    { cols: 100, rows: 30 },
    { cols: 110, rows: 35 },
  ]);
});
