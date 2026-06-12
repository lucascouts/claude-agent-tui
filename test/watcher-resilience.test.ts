// Story 015 / Task 3 regression — a throwing getSessionMessages must be SWALLOWED inside runReread
// (as scheduleReread's comment promises): no unhandled promise rejection, the watcher does not tear
// down, and the next re-read recovers and emits. Guards the catch-block fix in engine-watcher.ts.
// Runner: node --experimental-strip-types --test test/watcher-resilience.test.ts (build first).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createJsonlWatcher } from "../dist/engine-watcher.js";

test("createJsonlWatcher: a throwing getMessages is swallowed — no unhandled rejection, watcher recovers", async () => {
  let calls = 0;
  const emitted: Array<{ uuid?: string }> = [];
  let fireDebounce: () => void = () => {};
  let writeSignal: () => void = () => {};

  const watcher = createJsonlWatcher({
    sessionId: "s",
    transcriptPath: "/tmp/ignored-because-tail-is-injected.jsonl",
    onEvent: (m) => emitted.push(m),
    // Throw on the FIRST re-read, succeed on the SECOND.
    getMessages: () => {
      calls += 1;
      if (calls === 1) throw new Error("transient SDK read failure");
      return [{ uuid: "u1", type: "assistant" }];
    },
    // Controllable debounce: capture the scheduled fn; the test flushes it synchronously.
    schedule: (fn) => {
      fireDebounce = fn;
      return () => {};
    },
    // Injected tail: capture the write-signal callback (`() => scheduleReread()`) so the test drives it.
    tail: (_p, opts) => {
      writeSignal = opts.onRecord as () => void;
      return { stop() {} };
    },
  });

  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown): void => {
    unhandled.push(e);
  };
  process.on("unhandledRejection", onUnhandled);

  try {
    // 1st write signal → debounce fires → runReread → getMessages THROWS (must be swallowed).
    writeSignal();
    fireDebounce();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(calls, 1, "getMessages was invoked once");
    assert.equal(emitted.length, 0, "nothing is emitted on the failing read");

    // 2nd write signal → runReread → getMessages SUCCEEDS → emits, proving the watcher survived.
    writeSignal();
    fireDebounce();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(
      calls,
      2,
      "getMessages was invoked again after the failure (watcher not torn down)",
    );
    assert.deepEqual(
      emitted,
      [{ uuid: "u1", type: "assistant" }],
      "the watcher recovered and emitted on the next read",
    );

    // Give any stray rejection a tick to surface.
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(unhandled.length, 0, "the swallowed read produced no unhandled promise rejection");
  } finally {
    process.off("unhandledRejection", onUnhandled);
    watcher.stop();
  }
});
