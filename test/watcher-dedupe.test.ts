// Story 015 / Task 3.2 — dedupe emitted events by `uuid` across re-reads. Each LIVE re-read returns
// the full monotonic ordered superset; the per-uuid Set guard means each `uuid` is forwarded to
// onEvent at most once, and only the newly-appended messages surface on a later superset re-read,
// preserving chronological order (R4.1, R4.2).
// node:test runner: `node --experimental-strip-types --test test/watcher-dedupe.test.ts`
// (run `npm run build` first — behavioral imports resolve against ../dist).
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
  return { schedule, flush };
}

/** A tail stub that captures the wired onRecord so a test can fire write signals on demand. */
function makeTailStub() {
  let onRecord: (() => void) | undefined;
  const tail = (_path: string, opts: { onRecord: () => void }) => {
    onRecord = opts.onRecord;
    return { stop: () => {} };
  };
  return { tail, signal: (): void => onRecord?.() };
}

test("a superset re-read emits only the NEW uuids, each exactly once, in chronological order (R4.1, R4.2)", async () => {
  // Two successive results: the 2nd is a strict superset of the 1st (the SDK reader is monotonic).
  const first = [
    { uuid: "m1", seq: 1 },
    { uuid: "m2", seq: 2 },
  ];
  const second = [
    { uuid: "m1", seq: 1 }, // overlap — already emitted
    { uuid: "m2", seq: 2 }, // overlap — already emitted
    { uuid: "m3", seq: 3 }, // NEW
    { uuid: "m4", seq: 4 }, // NEW
  ];
  const supersets = [first, second];
  let idx = 0;

  const sched = makeScheduler();
  const tailStub = makeTailStub();
  const emitted: Array<{ uuid?: string; seq?: number }> = [];

  const watcher = createJsonlWatcher({
    sessionId: "sess-dedupe",
    transcriptPath: "/virtual/sess-dedupe.jsonl",
    onEvent: (m) => emitted.push(m),
    getMessages: () => supersets[Math.min(idx++, supersets.length - 1)],
    tail: tailStub.tail,
    schedule: sched.schedule,
  });

  // First re-read: both messages are new → both emitted in order.
  tailStub.signal();
  sched.flush();
  await Promise.resolve();
  assert.deepEqual(
    emitted.map((m) => m.uuid),
    ["m1", "m2"],
    "first superset emits its two new uuids in order",
  );

  // Second re-read: the overlapping uuids are suppressed; only m3, m4 surface, in order.
  tailStub.signal();
  sched.flush();
  await Promise.resolve();
  assert.deepEqual(
    emitted.map((m) => m.uuid),
    ["m1", "m2", "m3", "m4"],
    "the superset re-read appends ONLY the new uuids (m3, m4), preserving chronological order",
  );

  // Each uuid appears exactly once across the whole emit stream.
  const counts = new Map<string, number>();
  for (const m of emitted) counts.set(m.uuid!, (counts.get(m.uuid!) ?? 0) + 1);
  assert.deepEqual(
    [...counts.values()],
    [1, 1, 1, 1],
    "every uuid is emitted exactly once across re-reads (R4.1)",
  );

  watcher.stop();
});

test("re-reading an UNCHANGED/overlapping superset emits nothing for already-seen uuids (R4.1)", async () => {
  const sameSuperset = [{ uuid: "x1" }, { uuid: "x2" }, { uuid: "x3" }];
  let calls = 0;

  const sched = makeScheduler();
  const tailStub = makeTailStub();
  const emitted: Array<{ uuid?: string }> = [];

  const watcher = createJsonlWatcher({
    sessionId: "sess-unchanged",
    transcriptPath: "/virtual/sess-unchanged.jsonl",
    onEvent: (m) => emitted.push(m),
    getMessages: () => {
      calls++;
      return sameSuperset;
    }, // identical array every call
    tail: tailStub.tail,
    schedule: sched.schedule,
  });

  // First re-read: all three are new.
  tailStub.signal();
  sched.flush();
  await Promise.resolve();
  assert.deepEqual(
    emitted.map((m) => m.uuid),
    ["x1", "x2", "x3"],
    "first read emits all three uuids",
  );

  // Three more re-reads of the SAME superset → zero further emits.
  for (let i = 0; i < 3; i++) {
    tailStub.signal();
    sched.flush();
    await Promise.resolve();
  }
  assert.equal(calls, 4, "the reader was re-invoked on every signal (4 total)");
  assert.deepEqual(
    emitted.map((m) => m.uuid),
    ["x1", "x2", "x3"],
    "re-reads of the unchanged superset emit NOTHING for already-seen uuids",
  );

  watcher.stop();
});

test("a message with no uuid is emitted (cannot dedupe) — documented fallback", async () => {
  // In-corpus every message carries a uuid; this guards the documented fallback: a uuid-less message
  // is forwarded rather than silently dropped (it just cannot be deduped).
  const result = [
    { uuid: "k1", n: 1 },
    { n: 2 }, // no uuid
    { uuid: "k3", n: 3 },
  ];

  const sched = makeScheduler();
  const tailStub = makeTailStub();
  const emitted: Array<{ uuid?: string; n?: number }> = [];

  const watcher = createJsonlWatcher({
    sessionId: "sess-nouuid",
    transcriptPath: "/virtual/sess-nouuid.jsonl",
    onEvent: (m) => emitted.push(m),
    getMessages: () => result,
    tail: tailStub.tail,
    schedule: sched.schedule,
  });

  tailStub.signal();
  sched.flush();
  await Promise.resolve();

  assert.deepEqual(
    emitted.map((m) => m.n),
    [1, 2, 3],
    "all three messages forward, in order (uuid-less one included)",
  );

  watcher.stop();
});
