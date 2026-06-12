// Story 024 / Task 3.1 — arm and clear the 5583 ms turn watchdog (R5.1, R5.3).
//
// E3 binding decision 2 pins the turn watchdog = 5583 ms, DISTINCT from the file-discovery watchdog
// (N = 2000 ms, decision 3) — the two must never be conflated. The detector arms the watchdog at
// turn start (beginTurn) and clears it on end-of-turn confirmation (or cancel), so a cleared watchdog
// can never fire for a turn that already resolved.
//
// node:test runner: `node --experimental-strip-types --test test/turn-watchdog-clear.test.ts`
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createEndOfTurnDetector,
  TURN_WATCHDOG_MS,
  FILE_DISCOVERY_WATCHDOG_MS,
} from "../dist/end-of-turn.js";

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

test("TURN_WATCHDOG_MS is 5583 and DISTINCT from the 2000ms file-discovery watchdog", () => {
  assert.equal(TURN_WATCHDOG_MS, 5583);
  assert.equal(FILE_DISCOVERY_WATCHDOG_MS, 2000);
  assert.notEqual(TURN_WATCHDOG_MS, FILE_DISCOVERY_WATCHDOG_MS);
});

test("the armed turn watchdog is cleared when end-of-turn confirms before 5583ms", () => {
  let timedOut = false;
  const fired: unknown[] = [];
  const { schedule, advance } = makeClock();
  const d = createEndOfTurnDetector({
    onEndOfTurn: (b) => fired.push(b),
    onTurnTimeout: () => {
      timedOut = true;
    },
    schedule,
  });
  d.beginTurn(); // arm the watchdog
  d.observe(asst("end_turn", "u1"));
  advance(200); // confirm by quiescence (< 5583)
  assert.equal(fired.length, 1);
  advance(6000); // past the watchdog window
  assert.equal(timedOut, false, "watchdog cleared on confirmation — no ghost timeout");
});

test("the armed watchdog DOES fire when no end-of-turn confirms (the arm is real)", () => {
  let timedOut = false;
  const { schedule, advance } = makeClock();
  const d = createEndOfTurnDetector({
    onEndOfTurn: () => {},
    onTurnTimeout: () => {
      timedOut = true;
    },
    schedule,
    // Story 034 made the DEFAULT the generous stall window; this test pins the E3 window
    // explicitly — what it proves is that an armed watchdog genuinely fires on silence.
    watchdogMs: TURN_WATCHDOG_MS,
  });
  d.beginTurn();
  d.observe(asst("tool_use", "u1")); // mid-turn, never terminal (re-arms the stall clock at t=0)
  advance(TURN_WATCHDOG_MS);
  assert.equal(timedOut, true, "no end-of-turn within the window of silence trips the watchdog");
});
