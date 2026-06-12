// Story 015 / Task 3.1 — REUSE-live: the watcher obtains events by RE-INVOKING the SDK reader
// `getSessionMessages(sessionId, { dir })`, NOT by hand-parsing `message.content`. It re-reads on
// the debounced write signal (live streaming) AND forces one final re-read on the story-024
// end-of-turn signal, forwarding the reader's chronological order UNCHANGED (R5.1, R5.3).
// node:test runner: `node --experimental-strip-types --test test/watcher-reuse.test.ts`
// (run `npm run build` first — behavioral imports resolve against ../dist).
//
// Determinism: we ALWAYS inject `getMessages` (a scripted stub returning a growing ordered
// superset) and `schedule` (a controllable scheduler whose pending fn we fire manually via
// flush()), plus a `tail` stub that captures the wired onRecord. No real fs.watch / SDK / timers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createJsonlWatcher } from "../dist/engine-watcher.js";

/** A controllable debounce scheduler: capture the pending fn; `flush()` fires it synchronously. */
function makeScheduler() {
  let pending: (() => void) | undefined;
  const schedule = (fn: () => void, _ms: number): (() => void) => {
    pending = fn;
    return () => {
      if (pending === fn) pending = undefined;
    };
  };
  const flush = (): void => {
    const fn = pending;
    pending = undefined;
    fn?.();
  };
  return {
    schedule,
    flush,
    get pending() {
      return pending !== undefined;
    },
  };
}

/** A tail stub that captures the wired onRecord so a test can fire write signals on demand. */
function makeTailStub() {
  let onRecord: (() => void) | undefined;
  let stopped = false;
  const tail = (_path: string, opts: { onRecord: () => void }) => {
    onRecord = opts.onRecord;
    return {
      stop: () => {
        stopped = true;
      },
    };
  };
  return {
    tail,
    signal: (): void => onRecord?.(),
    get stopped() {
      return stopped;
    },
  };
}

test("watcher RE-INVOKES getSessionMessages on the debounced write signal (no hand-parse) (R5.1)", async () => {
  const scriptedSupersets: Array<Array<{ uuid: string; text: string }>> = [
    [{ uuid: "a", text: "first" }],
    [
      { uuid: "a", text: "first" },
      { uuid: "b", text: "second" },
    ],
  ];
  const calls: Array<{ sessionId: string; dir?: string }> = [];
  let callIdx = 0;

  const sched = makeScheduler();
  const tailStub = makeTailStub();
  const emitted: Array<{ uuid?: string }> = [];

  const watcher = createJsonlWatcher({
    sessionId: "sess-1",
    transcriptPath: "/virtual/sess-1.jsonl",
    dir: "/work/dir",
    onEvent: (m) => emitted.push(m),
    getMessages: (sessionId, opts) => {
      calls.push({ sessionId, dir: opts?.dir });
      // Return a growing ordered superset on successive calls (cap at the last script entry).
      return scriptedSupersets[Math.min(callIdx++, scriptedSupersets.length - 1)];
    },
    tail: tailStub.tail,
    schedule: sched.schedule,
  });

  // No re-read until a write signal is debounced.
  assert.equal(calls.length, 0, "no getMessages call before any write signal");

  // Fire a write signal (a complete line landed in the tail) → arms the debounce.
  tailStub.signal();
  assert.equal(calls.length, 0, "still no call: the debounce timer is armed but not yet fired");
  assert.ok(sched.pending, "a debounce timer is pending after the write signal");

  // Flush the debounce → exactly one re-read runs.
  sched.flush();
  await Promise.resolve(); // let the async re-read body settle (await getMessages + emit loop).

  assert.equal(calls.length, 1, "getSessionMessages invoked exactly once on the debounced signal");
  assert.deepEqual(
    calls[0],
    { sessionId: "sess-1", dir: "/work/dir" },
    "invoked with the session id and { dir } — the SDK reader signature, not a hand-parse",
  );
  assert.deepEqual(
    emitted.map((m) => m.uuid),
    ["a"],
    "the first superset's single new message is emitted",
  );

  watcher.stop();
});

test("watcher forces a FINAL re-read on the end-of-turn signal, bypassing debounce (R5.1)", async () => {
  const scriptedSupersets: Array<Array<{ uuid: string }>> = [
    [{ uuid: "a" }],
    [{ uuid: "a" }, { uuid: "b" }],
  ];
  let callIdx = 0;
  const calls: number[] = [];

  const sched = makeScheduler();
  const tailStub = makeTailStub();
  const emitted: Array<{ uuid?: string }> = [];

  const watcher = createJsonlWatcher({
    sessionId: "sess-2",
    transcriptPath: "/virtual/sess-2.jsonl",
    onEvent: (m) => emitted.push(m),
    getMessages: () => {
      calls.push(Date.now());
      return scriptedSupersets[Math.min(callIdx++, scriptedSupersets.length - 1)];
    },
    tail: tailStub.tail,
    schedule: sched.schedule,
  });

  // Live debounced re-read first.
  tailStub.signal();
  sched.flush();
  await Promise.resolve();
  assert.equal(calls.length, 1, "one live re-read on the debounced signal");
  assert.deepEqual(
    emitted.map((m) => m.uuid),
    ["a"],
    "first superset emitted [a]",
  );

  // End-of-turn fires: a FORCED final re-read happens immediately, NOT via the debounce scheduler.
  watcher.notifyEndOfTurn();
  await Promise.resolve();
  assert.equal(calls.length, 2, "end-of-turn forces a second (final) re-read");
  assert.equal(
    sched.pending,
    false,
    "the forced re-read did NOT arm the debounce scheduler (it bypassed it)",
  );
  assert.deepEqual(
    emitted.map((m) => m.uuid),
    ["a", "b"],
    "the final superset's newly-appended message [b] is ingested, completing the turn",
  );

  watcher.stop();
});

test("watcher forwards getSessionMessages chronological order UNCHANGED — no second-parser path (R5.3)", async () => {
  // A single re-read returns a multi-message ordered superset; the watcher must forward EXACTLY that
  // array order (no reordering, no re-derivation from message.content — there is only one parser).
  const ordered = [
    { uuid: "u1", parentUuid: null, marker: 1 },
    { uuid: "u2", parentUuid: "u1", marker: 2 },
    { uuid: "u3", parentUuid: "u2", marker: 3 },
    { uuid: "u4", parentUuid: "u3", marker: 4 },
  ];
  let getCalls = 0;

  const sched = makeScheduler();
  const tailStub = makeTailStub();
  const emitted: Array<{ uuid?: string; marker?: number }> = [];

  const watcher = createJsonlWatcher({
    sessionId: "sess-3",
    transcriptPath: "/virtual/sess-3.jsonl",
    onEvent: (m) => emitted.push(m),
    getMessages: () => {
      getCalls++;
      return ordered;
    },
    tail: tailStub.tail,
    schedule: sched.schedule,
  });

  tailStub.signal();
  sched.flush();
  await Promise.resolve();

  assert.equal(getCalls, 1, "exactly one reader invocation produced all events (single source)");
  assert.deepEqual(
    emitted.map((m) => m.uuid),
    ["u1", "u2", "u3", "u4"],
    "emitted order is byte-for-byte the getSessionMessages array order (R5.3 — linearization deferred to 017)",
  );
  assert.deepEqual(
    emitted.map((m) => m.marker),
    [1, 2, 3, 4],
    "every forwarded object is the reader's object, surfaced opaque (not re-parsed from content)",
  );

  watcher.stop();
});
