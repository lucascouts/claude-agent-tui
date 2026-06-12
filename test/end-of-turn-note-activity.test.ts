// Story 044 / Task 1.1 (R1.2) — the detector's `noteActivity()` liveness seam.
//
// Option B's sub-agent watcher needs a way to tell the end-of-turn detector "the turn is still
// alive" WITHOUT feeding it a synthetic main-chain event (which would corrupt boundary detection,
// openTaskIds, and watchdog diagnostics). `noteActivity()` is that seam: it re-arms the stall
// watchdog IFF a turn is in flight (the watchdog is armed) and is otherwise a strict no-op — when
// not armed (replay/load never starts a stall clock), after `stop()`, or after `markCancelled()`.
// It registers NO event: a subsequent real terminal stop still resolves the turn normally.
//
// Same injected fake clock as the rest of the end-of-turn suite — never real time. node:test:
//   node --experimental-strip-types --test test/end-of-turn-note-activity.test.ts
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

/** A main-chain assistant `tool_use` that spawns a Task sub-agent (held open until tool_result). */
const taskToolUse = (id: string, uuid: string) => ({
  type: "assistant",
  uuid,
  message: {
    stop_reason: "tool_use",
    content: [{ type: "tool_use", id, name: "Task", input: { prompt: "do work" } }],
  },
});

/** A main-chain user `tool_result` that closes the Task tool_use `id`. */
const taskToolResult = (id: string, uuid: string) => ({
  type: "user",
  uuid,
  message: { content: [{ type: "tool_result", tool_use_id: id, content: "done" }] },
});

/** A main-chain terminal assistant boundary. */
const asst = (stop_reason: unknown, uuid: string) => ({
  type: "assistant",
  uuid,
  message: { stop_reason },
});

test("noteActivity() re-arms the armed stall watchdog — repeated kicks past the window never trip (R1.2)", () => {
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
  // 10 kicks, each just inside the window — total elapsed is ~10× the window with NO main-chain
  // event observed at all: liveness alone must keep the silent turn alive.
  for (let i = 0; i < 10; i++) {
    advance(TURN_WATCHDOG_MS - 1);
    d.noteActivity();
  }
  assert.equal(timedOut, undefined, "liveness kicks re-arm the watchdog — no trip across 10 windows");
  assert.equal(fired.length, 0, "noteActivity never fires an end-of-turn by itself");

  // …and the window still applies once the kicks stop: a genuinely dead turn trips loudly.
  advance(TURN_WATCHDOG_MS);
  assert.ok(
    timedOut instanceof TurnTimeoutError,
    "once liveness stops, the SAME window still fails a dead turn loudly (no unconditional hold)",
  );
});

test("noteActivity() is a no-op when not armed — it never STARTS a stall clock (replay/load)", () => {
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
  // NO beginTurn: replay/load paths observe without an in-flight turn — a liveness kick here must
  // not arm anything.
  d.noteActivity();
  advance(TURN_WATCHDOG_MS * 4);
  assert.equal(timedOut, undefined, "noteActivity outside a turn never starts a stall clock");
  assert.equal(fired.length, 0);
});

test("noteActivity() is a no-op after stop()", () => {
  let timedOut: TurnTimeoutError | undefined;
  const { schedule, advance } = makeClock();
  const d = createEndOfTurnDetector({
    onEndOfTurn: () => {},
    onTurnTimeout: (e) => {
      timedOut = e;
    },
    schedule,
    watchdogMs: TURN_WATCHDOG_MS,
  });
  d.beginTurn();
  d.stop(); // teardown clears the watchdog
  d.noteActivity(); // must NOT re-arm a cleared watchdog
  advance(TURN_WATCHDOG_MS * 4);
  assert.equal(timedOut, undefined, "a stopped detector stays silent — noteActivity cannot revive it");
});

test("noteActivity() is a no-op after markCancelled()", () => {
  let timedOut: TurnTimeoutError | undefined;
  const fired: unknown[] = [];
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
  d.markCancelled(); // story-030 cancel latch clears Δt + watchdog
  d.noteActivity(); // must NOT re-arm for a cancelled turn
  advance(TURN_WATCHDOG_MS * 4);
  assert.equal(timedOut, undefined, "a cancelled turn stays cancelled — noteActivity cannot re-arm it");
  assert.equal(fired.length, 0);
});

test("noteActivity() registers no event: boundary detection and openTaskIds semantics stay intact", () => {
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
  // A real main-chain open Task engages the R4.2 hold as before…
  d.observe(taskToolUse("toolu_1", "u-task"));
  // …liveness kicks interleave without touching openTaskIds or queuing any boundary…
  d.noteActivity();
  advance(1000);
  d.noteActivity();
  // …then the REAL close + terminal stop resolve the turn exactly once, exactly as without kicks.
  d.observe(taskToolResult("toolu_1", "u-result"));
  const boundary = asst("end_turn", "u-final");
  d.observe(boundary);
  advance(200); // Δt quiescence
  assert.equal(fired.length, 1, "the real terminal stop still resolves exactly once");
  assert.equal(fired[0], boundary, "the boundary is the observed terminal stop, never a synthetic one");
  assert.equal(timedOut, undefined);
});
