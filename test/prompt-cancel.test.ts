// Story 024 / Task 4.3 — single-resolution cancel seam markCancelled() (R3.4, R5.3; read-only).
//
// markCancelled() is the seam the Degrau-2 story 030 calls. It sets the single-resolution latch and
// clears BOTH the Δt timer and the turn watchdog, so the detector cannot also fire an end-of-turn
// (no double-resolve) for the cancelled turn. It does NOT resolve the ACP session/prompt here — the
// session/cancel → PromptResponse{stopReason:'cancelled'} resolution and its §8 wiring are story 030.
// Degrau-1 stays read-only: no ACP-side input is added.
//
// node:test runner: `node --experimental-strip-types --test test/prompt-cancel.test.ts`
import { test } from "node:test";
import assert from "node:assert/strict";
import { createEndOfTurnDetector, createTurnResolver } from "../dist/end-of-turn.js";

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

test("markCancelled clears both timers — no end-of-turn and no watchdog timeout fire afterwards", () => {
  const fired: unknown[] = [];
  let timedOut = false;
  const { schedule, advance } = makeClock();
  const d = createEndOfTurnDetector({
    onEndOfTurn: (b) => fired.push(b),
    onTurnTimeout: () => {
      timedOut = true;
    },
    schedule,
  });
  d.beginTurn(); // arms the watchdog
  d.observe(asst("end_turn", "u1")); // arms the Δt timer
  d.markCancelled();
  advance(10000); // past both Δt and the 5583ms watchdog
  assert.equal(fired.length, 0, "the Δt timer was cleared — no end-of-turn");
  assert.equal(timedOut, false, "the watchdog was cleared — no timeout");
});

test("after markCancelled a later terminal event cannot re-open the turn (no double-resolve)", () => {
  const fired: unknown[] = [];
  const { schedule, advance } = makeClock();
  const d = createEndOfTurnDetector({ onEndOfTurn: (b) => fired.push(b), schedule });
  d.beginTurn();
  d.markCancelled();
  d.observe(asst("end_turn", "u1")); // arrives after cancel
  advance(200);
  assert.equal(fired.length, 0, "a cancelled detector suppresses any subsequent end-of-turn");
});

test("markCancelled does NOT resolve the ACP prompt (read-only — cancelled resolution is story 030)", async () => {
  const { schedule, advance } = makeClock();
  const { detector, promise } = createTurnResolver({ schedule });
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  detector.beginTurn();
  detector.observe(asst("end_turn", "u1"));
  detector.markCancelled();
  advance(10000);
  await Promise.resolve(); // flush microtasks
  assert.equal(settled, false, "the prompt stays pending — story 030 owns the cancelled resolution");
});
