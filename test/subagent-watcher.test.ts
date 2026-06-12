// Story 044 / Task 3.2 (R1.1, R2.1, R5.2) — the poll-based sub-agent watcher.
//
// `createSubagentWatcher` polls the story-041 SDK readers (via `sourceSubagentRows`'s injected
// seams) while a turn has a `Task`/`Agent` spawn in flight, and fires `onActivity` ONLY when a poll
// observes at least one NEW sub-agent row (a uuid not seen before). The contract pinned here:
//   - progress-gated: a fresh uuid fires exactly once; an EMPTY poll and a NO-CHANGE (all-seen)
//     poll fire nothing (a hung sub-agent must still let the stall watchdog trip — R5.2);
//   - cheap path: while `mainChain` carries no Task/Agent spawn, the poll never calls
//     `listSubagents` (no sub-agent IO on a no-subagent turn — R5.2), and `update()` refreshes
//     that guard so a spawn appearing later arms the probe (the class-028 late-discovery shape:
//     readers simply return [] until the sidechain materializes — R2.1);
//   - `stop()` cancels the poll (no further reader calls) and is idempotent;
//   - a row with no `uuid` is skipped (never counts as progress) without crashing the poll.
//
// One injected fake clock; polls are async, so each tick is advance(pollMs) + a microtask flush.
// node:test runner: `node --experimental-strip-types --test test/subagent-watcher.test.ts`
// (run `npm run build` first — imports resolve against ../dist/subagent-watcher.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSubagentWatcher, SUBAGENT_POLL_MS } from "../dist/subagent-watcher.js";

/** A deterministic fake clock: `schedule` captures timers; `advance(ms)` fires the due ones. */
function makeClock() {
  let now = 0;
  const timers: Array<{ at: number; fn: () => void; cancelled: boolean }> = [];
  const schedule = (fn: () => void, ms: number) => {
    const t = { at: now + ms, fn, cancelled: false };
    timers.push(t);
    return () => {
      t.cancelled = true;
    };
  };
  const advance = (ms: number) => {
    now += ms;
    for (const t of [...timers].sort((a, b) => a.at - b.at)) {
      if (!t.cancelled && t.at <= now) {
        t.cancelled = true; // one-shot
        t.fn();
      }
    }
  };
  return { schedule, advance };
}

/** Drain the async poll body queued by a clock tick. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/** One advance of a poll interval + drain — a single watcher tick. */
async function tick(clock: { advance: (ms: number) => void }, ms = SUBAGENT_POLL_MS) {
  clock.advance(ms);
  await flush();
}

/** Reduced-shape main-chain assistant row whose `tool_use` spawns a Task sub-agent. */
const taskSpawn = (uuid: string, id: string) => ({
  uuid,
  type: "assistant",
  message: { role: "assistant", content: [{ type: "tool_use", id, name: "Task", input: {} }] },
});

/** A plain no-spawn main-chain row. */
const txt = (uuid: string) => ({
  uuid,
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
});

/** A sub-agent row keyed by uuid (the dedup key). */
const subRow = (uuid: string) => ({
  uuid,
  type: "assistant",
  parent_tool_use_id: "toolu_T",
  message: { role: "assistant", content: [{ type: "text", text: `row ${uuid}` }] },
});

/** Harness: a watcher over injectable stub readers + spy counters. */
function makeWatcher(opts?: {
  mainChain?: unknown[];
  rows?: () => unknown[];
  agentIds?: string[];
}) {
  const clock = makeClock();
  const listCalls: string[] = [];
  let activityCount = 0;
  const rows = opts?.rows ?? (() => []);
  const watcher = createSubagentWatcher({
    sessionId: "sess-watch",
    dir: "/work",
    mainChain: (opts?.mainChain ?? [taskSpawn("m1", "toolu_T")]) as never,
    listSubagents: async (sessionId: string) => {
      listCalls.push(sessionId);
      return opts?.agentIds ?? ["agentA"];
    },
    getSubagentMessages: async () => rows() as never,
    onActivity: () => {
      activityCount += 1;
    },
    schedule: clock.schedule,
    pollMs: SUBAGENT_POLL_MS,
  });
  return { watcher, clock, listCalls, activity: () => activityCount };
}

test("fires onActivity exactly once per poll that observes a NEW uuid (R1.1)", async () => {
  const pool: unknown[] = [subRow("s1")];
  const { watcher, clock, activity } = makeWatcher({ rows: () => [...pool] });

  await tick(clock); // poll 1: s1 is fresh → one activity
  assert.equal(activity(), 1, "first poll with a new uuid fires exactly once");

  pool.push(subRow("s2"));
  await tick(clock); // poll 2: s2 is fresh → one more
  assert.equal(activity(), 2, "each subsequent poll with a NEW uuid fires exactly once more");

  watcher.stop();
});

test("an EMPTY poll fires nothing (R1.1)", async () => {
  const { watcher, clock, listCalls, activity } = makeWatcher({ rows: () => [] });

  await tick(clock);
  await tick(clock);
  assert.ok(listCalls.length >= 1, "the armed watcher does poll the readers");
  assert.equal(activity(), 0, "no rows → no activity (liveness only on observed progress)");

  watcher.stop();
});

test("a NO-CHANGE (all-seen) poll fires nothing — a hung sub-agent still lets the watchdog trip (R5.2)", async () => {
  const pool: unknown[] = [subRow("s1"), subRow("s2")];
  const { watcher, clock, activity } = makeWatcher({ rows: () => [...pool] });

  await tick(clock); // both fresh → one activity for the poll
  assert.equal(activity(), 1, "one poll, one activity — regardless of how many fresh rows it saw");

  await tick(clock); // identical corpus: all uuids already seen
  await tick(clock);
  assert.equal(activity(), 1, "no-change polls fire NOTHING (no unconditional liveness)");

  watcher.stop();
});

test("cheap path: no Task/Agent spawn in mainChain → never calls listSubagents; update() arms it later (R5.2/R2.1)", async () => {
  const pool: unknown[] = [subRow("s1")];
  const { watcher, clock, listCalls, activity } = makeWatcher({
    mainChain: [txt("m1")],
    rows: () => [...pool],
  });

  await tick(clock);
  await tick(clock);
  await tick(clock);
  assert.equal(listCalls.length, 0, "a no-spawn chain pays NO sub-agent IO (spy asserts 0)");
  assert.equal(activity(), 0);

  // The spawn appears later (the live pump refreshes the chain): update() must re-arm the probe.
  watcher.update([txt("m1"), taskSpawn("m2", "toolu_T")] as never);
  await tick(clock);
  assert.ok(listCalls.length >= 1, "after update() with a spawn, the next poll probes the readers");
  assert.equal(activity(), 1, "and the fresh row fires activity");

  watcher.stop();
});

test("stop() cancels the poll — no further reader calls — and is idempotent (R2.3-adjacent)", async () => {
  const pool: unknown[] = [subRow("s1")];
  const { watcher, clock, listCalls, activity } = makeWatcher({ rows: () => [...pool] });

  await tick(clock);
  assert.equal(activity(), 1);
  const callsAtStop = listCalls.length;

  watcher.stop();
  watcher.stop(); // idempotent — a second stop neither throws nor revives anything

  pool.push(subRow("s2"));
  await tick(clock);
  await tick(clock);
  assert.equal(listCalls.length, callsAtStop, "a stopped watcher never polls again");
  assert.equal(activity(), 1, "and fires no further activity");
});

test("a row with no uuid is skipped (never counts as progress) without crashing the poll", async () => {
  const noUuidRow = {
    type: "assistant",
    parent_tool_use_id: "toolu_T",
    message: { role: "assistant", content: [{ type: "text", text: "no uuid" }] },
  };
  const pool: unknown[] = [noUuidRow];
  const { watcher, clock, listCalls, activity } = makeWatcher({ rows: () => [...pool] });

  await tick(clock);
  await tick(clock);
  assert.ok(listCalls.length >= 1, "the poll ran (and did not crash on the uuid-less row)");
  assert.equal(activity(), 0, "a uuid-less row never counts as observed progress");

  // A real (uuid-carrying) row still fires afterwards — the skip is per-row, not fatal.
  pool.push(subRow("s1"));
  await tick(clock);
  assert.equal(activity(), 1, "a subsequent uuid-carrying row still fires normally");

  watcher.stop();
});
