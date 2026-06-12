// Story 034 (live-acceptance fix) — the turn watchdog is a STALL watchdog, not a total-turn cap.
//
// The G1 live acceptance run (2026-06-11, session 9cedb4c2) faulted a REAL first turn at 5583 ms:
// the E3 window was calibrated on trivial Degrau-0 turns as a TOTAL-duration cap, but live turns
// legitimately exceed it (cold start, thinking, long tool runs) — and the JSONL writes whole blocks,
// so long gaps between writes are normal mid-turn. The corrected semantics: the watchdog re-arms on
// every observed transcript event (activity = liveness) and only trips after `watchdogMs` of total
// SILENCE; the default window is TURN_STALL_WATCHDOG_MS (generous), overridable per-process via the
// FORK_TURN_WATCHDOG_MS env var and per-call via `watchdogMs`. TURN_WATCHDOG_MS (5583, E3/story 017)
// remains exported and usable as an explicit option — it is no longer the detector default.
//
// node:test runner: `node --experimental-strip-types --test test/turn-watchdog-stall.test.ts`
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createEndOfTurnDetector,
  TURN_WATCHDOG_MS,
  TURN_STALL_WATCHDOG_MS,
  TURN_WATCHDOG_ENV,
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

test("transcript activity RE-ARMS the watchdog: a live turn longer than the window never trips while events keep arriving", () => {
  let timedOut = false;
  const { schedule, advance } = makeClock();
  const d = createEndOfTurnDetector({
    onEndOfTurn: () => {},
    onTurnTimeout: () => {
      timedOut = true;
    },
    schedule,
    watchdogMs: 5_000,
  });
  d.beginTurn();
  // 4 mid-turn writes 3s apart: total turn time 12s >> 5s window, but no silent gap reaches 5s.
  for (let i = 0; i < 4; i++) {
    advance(3_000);
    d.observe(asst("tool_use", `u${i}`)); // mid-turn, never terminal
    assert.equal(timedOut, false, `activity at t=+${(i + 1) * 3}s keeps the turn alive (no trip)`);
  }
  // Now true silence: the stall window elapses with no write → the watchdog DOES trip.
  advance(5_000);
  assert.equal(timedOut, true, "5s of total transcript silence after the last write trips the stall watchdog");
});

test("the detector DEFAULT window is TURN_STALL_WATCHDOG_MS — a real turn slower than 5583ms no longer faults", () => {
  let timedOut = false;
  const { schedule, advance } = makeClock();
  const d = createEndOfTurnDetector({
    onEndOfTurn: () => {},
    onTurnTimeout: () => {
      timedOut = true;
    },
    schedule,
  });
  d.beginTurn();
  advance(TURN_WATCHDOG_MS); // the OLD total-turn cap elapses in silence…
  assert.equal(timedOut, false, "5583ms of model latency is NOT a fault under the stall default");
  advance(TURN_STALL_WATCHDOG_MS - TURN_WATCHDOG_MS); // …the stall window is the real boundary
  assert.equal(timedOut, true, "the stall default window trips on genuine silence");
});

test("TURN_STALL_WATCHDOG_MS is a distinct, generous constant; the E3 5583ms stays exported for explicit use", () => {
  assert.equal(TURN_STALL_WATCHDOG_MS, 120_000);
  assert.equal(TURN_WATCHDOG_MS, 5583, "E3 constant unchanged (story 017/024 history)");
  assert.equal(FILE_DISCOVERY_WATCHDOG_MS, 2000);
  assert.ok(TURN_STALL_WATCHDOG_MS > TURN_WATCHDOG_MS, "the stall window is strictly wider than the E3 cap");
});

test(`the ${TURN_WATCHDOG_ENV} env var overrides the default window; invalid values fall back`, () => {
  const prior = process.env[TURN_WATCHDOG_ENV];
  try {
    process.env[TURN_WATCHDOG_ENV] = "9000";
    {
      let timedOut = false;
      const { schedule, advance } = makeClock();
      const d = createEndOfTurnDetector({
        onEndOfTurn: () => {},
        onTurnTimeout: () => {
          timedOut = true;
        },
        schedule,
      });
      d.beginTurn();
      advance(8_999);
      assert.equal(timedOut, false, "below the env-configured window — no trip");
      advance(1);
      assert.equal(timedOut, true, "the env-configured 9000ms window trips");
    }
    for (const bad of ["abc", "-5", "0", ""]) {
      process.env[TURN_WATCHDOG_ENV] = bad;
      let timedOut = false;
      const { schedule, advance } = makeClock();
      const d = createEndOfTurnDetector({
        onEndOfTurn: () => {},
        onTurnTimeout: () => {
          timedOut = true;
        },
        schedule,
      });
      d.beginTurn();
      advance(TURN_STALL_WATCHDOG_MS - 1);
      assert.equal(timedOut, false, `invalid env "${bad}" falls back to the stall default (no early trip)`);
      advance(1);
      assert.equal(timedOut, true, `invalid env "${bad}" still trips at the stall default`);
    }
  } finally {
    if (prior === undefined) delete process.env[TURN_WATCHDOG_ENV];
    else process.env[TURN_WATCHDOG_ENV] = prior;
  }
});

test("observe() WITHOUT an in-flight turn never arms the watchdog (replay/load path stays silent)", () => {
  let timedOut = false;
  const { schedule, advance } = makeClock();
  const d = createEndOfTurnDetector({
    onEndOfTurn: () => {},
    onTurnTimeout: () => {
      timedOut = true;
    },
    schedule,
    watchdogMs: 5_000,
  });
  // No beginTurn: replaying history must not start a stall clock.
  d.observe(asst("tool_use", "r1"));
  advance(60_000);
  assert.equal(timedOut, false, "no in-flight turn → no watchdog, regardless of observed events");
});

test("re-arm does not resurrect a cleared watchdog: after confirmation, later events never trip it", () => {
  let timedOut = false;
  const fired: unknown[] = [];
  const { schedule, advance } = makeClock();
  const d = createEndOfTurnDetector({
    onEndOfTurn: (b) => fired.push(b),
    onTurnTimeout: () => {
      timedOut = true;
    },
    schedule,
    watchdogMs: 5_000,
  });
  d.beginTurn();
  d.observe(asst("end_turn", "u1"));
  advance(200); // Δt quiescence → confirmed, watchdog cleared
  assert.equal(fired.length, 1);
  d.observe(asst("tool_use", "u2")); // a stray post-turn event must NOT re-arm a cleared watchdog
  advance(600_000);
  assert.equal(timedOut, false, "a settled turn cannot time out, even with stray late events");
});
