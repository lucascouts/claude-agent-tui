// Story 027 / Task 4.5 — E2E: the in-app turn watchdog settles each turn (R2.5, R5.3).
//
// The panel must settle on a COMPLETED turn via the story-024 E3 detector (terminal
// assistant.stop_reason + Δt = 200 ms quiescence) and a STUCK turn must fault at the
// 5583 ms TURN watchdog — kept DISTINCT from the 2000 ms FILE-DISCOVERY watchdog (story
// 015/jsonl.ts). Every value is consumed VERBATIM from the binding decisions (story 024 /
// experiments/DEGRAU0-RESULTS.md), never re-derived here. Driven synthetically with an
// injected clock so the 5583 ms window is exercised deterministically (no real wall-clock,
// no claude spawn) — the live panel-settle observation is the manual acceptance step.
//
// node:test runner: `node --experimental-strip-types --test test/e2e-turn-settles.test.ts` (build first).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createEndOfTurnDetector,
  DELTA_T_MS,
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

const asst = (stop_reason: unknown, uuid: string) => ({ type: "assistant", uuid, message: { stop_reason } });

test("a completed turn SETTLES via the E3 detector after the terminal stop + Δt quiescence (R2.5)", () => {
  const fired: unknown[] = [];
  const { schedule, advance } = makeClock();
  const d = createEndOfTurnDetector({ onEndOfTurn: (b) => fired.push(b), schedule });
  d.beginTurn();
  d.observe(asst("end_turn", "u1")); // terminal candidate → arms the Δt timer
  assert.equal(fired.length, 0, "not settled until Δt of quiescence elapses");
  advance(DELTA_T_MS); // 200 ms quiescence
  assert.equal(fired.length, 1, "the turn settles once Δt quiescence confirms the terminal stop");
  advance(10_000); // long past the turn watchdog
  assert.equal(fired.length, 1, "exactly one end-of-turn — a settled turn does not re-fire or hang");
});

test("a STUCK turn faults at the 5583 ms TURN watchdog, NOT the 2000 ms discovery watchdog (R5.3)", () => {
  let timedOut: unknown = null;
  const { schedule, advance } = makeClock();
  const d = createEndOfTurnDetector({
    onTurnTimeout: (e: unknown) => {
      timedOut = e;
    },
    schedule,
    // Story 034 made the DEFAULT the generous stall window; the E3 window is pinned explicitly
    // here because what this test proves is the 5583-vs-2000 window DISTINCTION, not the default.
    watchdogMs: TURN_WATCHDOG_MS,
  });
  d.beginTurn(); // arms the turn watchdog; no terminal stop ever arrives
  advance(FILE_DISCOVERY_WATCHDOG_MS); // 2000 ms — the DISCOVERY window
  assert.equal(timedOut, null, "the turn does NOT fault at the 2000 ms discovery watchdog — windows are distinct");
  advance(TURN_WATCHDOG_MS - FILE_DISCOVERY_WATCHDOG_MS); // reach 5583 ms total
  assert.ok(timedOut, "the stuck turn faults at the 5583 ms turn watchdog rather than hanging the panel");
});

test("the TURN watchdog (5583) and the FILE-DISCOVERY watchdog (2000) are observably distinct constants", () => {
  assert.equal(TURN_WATCHDOG_MS, 5583, "turn watchdog is the binding 5583 ms (story 024 / E3)");
  assert.equal(FILE_DISCOVERY_WATCHDOG_MS, 2000, "file-discovery watchdog is the binding 2000 ms (story 015)");
  assert.notEqual(TURN_WATCHDOG_MS, FILE_DISCOVERY_WATCHDOG_MS, "the two watchdog windows must stay distinct");
});
