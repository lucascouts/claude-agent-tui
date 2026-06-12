// Story 024 / Task 3.2 — surface a typed TurnTimeoutError on a no-signal turn (R5.1, R5.2).
//
// When no end-of-turn is detected within the 5583 ms turn watchdog, the turn is failed LOUDLY: a
// typed TurnTimeoutError carrying the elapsed window, the last-seen event .type/stop_reason and the
// sessionId is surfaced to the prompt loop AND logged for R2 runtime telemetry — never silently
// swallowed, never an end-of-turn signal.
//
// node:test runner: `node --experimental-strip-types --test test/turn-watchdog-timeout.test.ts`
import { test } from "node:test";
import assert from "node:assert/strict";
import { createEndOfTurnDetector, TurnTimeoutError } from "../dist/end-of-turn.js";

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
        t.cancelled = true;
        t.fn();
      }
    }
  };
  return { schedule, advance };
}

const asst = (stop_reason: unknown, uuid: string) => ({
  type: "assistant",
  uuid,
  message: { stop_reason },
});

test("a no-terminal-stop turn surfaces a typed TurnTimeoutError at 5583ms with last-seen diagnostics", () => {
  let err: unknown = null;
  const fired: unknown[] = [];
  const { schedule, advance } = makeClock();
  const d = createEndOfTurnDetector({
    onEndOfTurn: (b) => fired.push(b),
    onTurnTimeout: (e) => {
      err = e;
    },
    sessionId: "sess-123",
    schedule,
    // Story 034 made the DEFAULT the generous stall window; these tests pin the E3 window —
    // they prove the timeout DIAGNOSTICS (typed error, last-seen event, telemetry), not the default.
    watchdogMs: 5583,
  });
  d.beginTurn();
  d.observe(asst("tool_use", "u1")); // mid-turn pause
  d.observe({ type: "user", uuid: "u2", message: { content: "tool result" } }); // last event seen
  advance(5583);
  assert.ok(err instanceof TurnTimeoutError, "a typed TurnTimeoutError is surfaced");
  assert.equal((err as TurnTimeoutError).elapsedMs, 5583);
  assert.equal((err as TurnTimeoutError).lastEventType, "user");
  assert.equal((err as TurnTimeoutError).sessionId, "sess-123");
  assert.equal(fired.length, 0, "no end-of-turn fired on a no-signal turn");
});

test("the error carries the last stop_reason when the last event is an assistant pause", () => {
  let err: TurnTimeoutError | null = null;
  const { schedule, advance } = makeClock();
  const d = createEndOfTurnDetector({
    onEndOfTurn: () => {},
    onTurnTimeout: (e) => {
      err = e;
    },
    schedule,
    watchdogMs: 5583, // E3 window pinned — the default is the story-034 stall window
  });
  d.beginTurn();
  d.observe(asst("tool_use", "u1"));
  advance(5583);
  assert.equal(err!.lastEventType, "assistant");
  assert.equal(err!.lastStopReason, "tool_use");
});

test("the stall is logged for R2 telemetry (never silently swallowed)", () => {
  const logs: unknown[][] = [];
  const { schedule, advance } = makeClock();
  const d = createEndOfTurnDetector({
    onEndOfTurn: () => {},
    onTurnTimeout: () => {},
    logger: { error: (...a: unknown[]) => logs.push(a) },
    schedule,
    watchdogMs: 5583, // E3 window pinned — the default is the story-034 stall window
  });
  d.beginTurn();
  d.observe(asst("tool_use", "u1"));
  advance(5583);
  assert.equal(logs.length, 1, "the timeout is logged exactly once");
});
