// Story 041 / Task 4.2 — an in-flight main-chain Task/Agent tool_use holds the turn OPEN (R4.2).
//
// A main-chain `Task`/`Agent` `tool_use` spawns a sub-agent whose work can run silently for a long
// time. While that `tool_use` has NO matching `tool_result` yet (tool_result.tool_use_id === id),
// the turn is IN-FLIGHT: the silence watchdog must NOT trip and no end-of-turn may resolve, however
// long the sub-agent runs. Once the matching `tool_result` arrives AND a real main-chain terminal
// stop follows, the turn resolves normally (no over-holding). A normal turn with no open Task is
// unaffected — it still resolves on the watchdog/terminal stop exactly as before.
//
// The detector feed is main-chain-only (the pump never feeds sidechain rows — story 041 R4.1), so
// the open-Task scan runs over main-chain rows. Timing is the same injected fake clock the rest of
// the end-of-turn suite uses (mirrors test/end-of-turn-quiescence.test.ts), never real time.
//
// node:test runner: `node --experimental-strip-types --test test/end-of-turn-inflight-task.test.ts`
// (run `npm run build` first — the behavioral import resolves against ../dist).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createEndOfTurnDetector,
  TurnTimeoutError,
  TURN_WATCHDOG_MS,
} from "../dist/end-of-turn.js";

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

/** A main-chain assistant `tool_use` that spawns a Task/Agent sub-agent (the open tool_use). */
const taskToolUse = (id: string, uuid: string, name: "Task" | "Agent" = "Task") => ({
  type: "assistant",
  uuid,
  message: {
    stop_reason: "tool_use",
    content: [{ type: "tool_use", id, name, input: { prompt: "do work" } }],
  },
});

/** A main-chain user `tool_result` that closes the Task tool_use `id` (`tool_use_id === id`). */
const taskToolResult = (id: string, uuid: string) => ({
  type: "user",
  uuid,
  parent_tool_use_id: id, // the result row points back at the spawning tool_use
  message: { content: [{ type: "tool_result", tool_use_id: id, content: "subagent done" }] },
});

/** A main-chain terminal assistant boundary. */
const asst = (stop_reason: unknown, uuid: string) => ({
  type: "assistant",
  uuid,
  message: { stop_reason },
});

test("an OPEN main-chain Task tool_use holds the turn: no resolve, no watchdog trip past the window (R4.2)", () => {
  const fired: unknown[] = [];
  let timedOut: TurnTimeoutError | undefined;
  const { schedule, advance } = makeClock();
  const d = createEndOfTurnDetector({
    onEndOfTurn: (b) => fired.push(b),
    onTurnTimeout: (e) => {
      timedOut = e;
    },
    schedule,
    watchdogMs: TURN_WATCHDOG_MS, // pin the E3 cap so the window is deterministic under the clock
  });
  d.beginTurn();
  d.observe(taskToolUse("toolu_task_1", "u-task")); // main-chain Task tool_use, no tool_result yet
  // The sub-agent runs silently far past the watchdog window — this MUST NOT trip the watchdog or
  // resolve the turn, because the spawning Task tool_use is still open.
  advance(TURN_WATCHDOG_MS * 4);
  assert.equal(timedOut, undefined, "an in-flight Task must NOT trip the silence watchdog (R4.2)");
  assert.equal(fired.length, 0, "an in-flight Task must NOT resolve an end-of-turn (R4.2)");
});

test("once the matching tool_result arrives AND a terminal stop follows, the turn resolves normally (no over-hold) (R4.2)", () => {
  const fired: unknown[] = [];
  let timedOut: TurnTimeoutError | undefined;
  const { schedule, advance } = makeClock();
  const d = createEndOfTurnDetector({
    onEndOfTurn: (b) => fired.push(b),
    onTurnTimeout: (e) => {
      timedOut = e;
    },
    schedule,
    watchdogMs: TURN_WATCHDOG_MS,
  });
  d.beginTurn();
  d.observe(taskToolUse("toolu_task_1", "u-task")); // open Task
  advance(TURN_WATCHDOG_MS * 2); // sub-agent runs long — held open, no trip
  assert.equal(fired.length, 0, "still held while the Task is open");
  assert.equal(timedOut, undefined, "still held while the Task is open");

  d.observe(taskToolResult("toolu_task_1", "u-result")); // the matching tool_result closes the Task
  const boundary = asst("end_turn", "u-final"); // a real main-chain terminal stop follows
  d.observe(boundary);
  advance(200); // Δt quiescence → boundary confirms
  assert.equal(fired.length, 1, "with the Task closed + a terminal stop, the turn resolves once");
  assert.equal(fired[0], boundary, "the boundary is the real main-chain terminal stop");
  assert.equal(timedOut, undefined, "a normal resolution, not a watchdog timeout");
});

test("guard: a normal turn with NO open Task still trips the watchdog on silence exactly as before (no regression)", () => {
  const fired: unknown[] = [];
  let timedOut: TurnTimeoutError | undefined;
  const { schedule, advance } = makeClock();
  const d = createEndOfTurnDetector({
    onEndOfTurn: (b) => fired.push(b),
    onTurnTimeout: (e) => {
      timedOut = e;
    },
    sessionId: "sess-guard",
    schedule,
    watchdogMs: TURN_WATCHDOG_MS,
  });
  d.beginTurn();
  // a normal mid-turn tool_use (Bash) is NOT a Task/Agent — it does not hold the turn open
  d.observe({
    type: "assistant",
    uuid: "u-bash",
    message: { stop_reason: "tool_use", content: [{ type: "tool_use", id: "tu_bash", name: "Bash" }] },
  });
  advance(TURN_WATCHDOG_MS); // silence past the window → the watchdog still trips (no regression)
  assert.ok(timedOut instanceof TurnTimeoutError, "a non-Task silent turn still trips the watchdog");
  assert.equal(fired.length, 0, "no end-of-turn fired on the dead turn");
});

test("guard: a normal terminal turn with NO open Task resolves on Δt exactly as before (no regression)", () => {
  const fired: unknown[] = [];
  const { schedule, advance } = makeClock();
  const d = createEndOfTurnDetector({
    onEndOfTurn: (b) => fired.push(b),
    schedule,
    watchdogMs: TURN_WATCHDOG_MS,
  });
  d.beginTurn();
  const boundary = asst("end_turn", "u1");
  d.observe(boundary);
  advance(200);
  assert.equal(fired.length, 1, "a plain terminal turn still confirms at Δt");
  assert.equal(fired[0], boundary);
});
