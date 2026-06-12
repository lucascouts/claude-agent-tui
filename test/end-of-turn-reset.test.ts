// Story 024 / Task 2.3 — reset detection state for the next turn (R1.4, R1.3).
//
// After a confirmed boundary the detector clears the recorded candidate, the per-turn fired latch,
// and any armed Δt timer, so the NEXT terminal candidate starts a clean cycle and fires fresh — while
// a replayed/duplicated event (deduped by uuid upstream) can NOT reopen a closed turn (idempotent
// re-entry).
//
// Regression-guard note: the reset + idempotency runtime was delivered by slices 2.1 (firedUuids +
// clearDelta, required by the 2.1 "fired latch" test) and 2.2 (confirmBoundary). This sub-task PINS
// that behavior as a regression guard rather than forcing a synthetic Red (project convention for
// degrau-1 incremental slices) — validated by these assertions + tsc.
//
// node:test runner: `node --experimental-strip-types --test test/end-of-turn-reset.test.ts`
import { test } from "node:test";
import assert from "node:assert/strict";
import { createEndOfTurnDetector } from "../dist/end-of-turn.js";

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

test("a second terminal candidate after a confirmed boundary fires a fresh end-of-turn", () => {
  const fired: unknown[] = [];
  const { schedule, advance } = makeClock();
  const d = createEndOfTurnDetector({ onEndOfTurn: (b) => fired.push(b), schedule });
  d.observe(asst("end_turn", "u1"));
  advance(200); // confirm turn 1 by quiescence
  assert.equal(fired.length, 1);
  d.observe(asst("end_turn", "u2")); // a fresh turn, its own Δt cycle
  advance(200);
  assert.equal(fired.length, 2, "the reset state lets the next terminal fire fresh");
});

test("a duplicate of an already-fired terminal event does not re-fire (idempotent re-entry)", () => {
  const fired: unknown[] = [];
  const { schedule, advance } = makeClock();
  const d = createEndOfTurnDetector({ onEndOfTurn: (b) => fired.push(b), schedule });
  d.observe(asst("end_turn", "u1"));
  advance(200);
  assert.equal(fired.length, 1);
  // a replayed event with the SAME uuid (a different object — upstream dedupe slipped)
  d.observe({ type: "assistant", uuid: "u1", message: { stop_reason: "end_turn" } });
  advance(200);
  assert.equal(fired.length, 1, "a duplicate uuid cannot reopen a closed turn");
});

test("after confirmation the Δt timer is cleared (no stale ghost boundary)", () => {
  const fired: unknown[] = [];
  const { schedule, advance } = makeClock();
  const d = createEndOfTurnDetector({ onEndOfTurn: (b) => fired.push(b), schedule });
  d.observe(asst("end_turn", "u1"));
  advance(200); // confirm + reset
  assert.equal(fired.length, 1);
  advance(10000); // no armed timer remains
  assert.equal(fired.length, 1);
});
