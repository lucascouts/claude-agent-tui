// Story 017 / Task 3.3 — Bind the live re-parse cadence to the end-of-turn signal.
//
// `bindEndOfTurnReparse` CONSUMES the story-024 end-of-turn signal (terminal stop_reason + Δt=200ms
// quiescence — detected elsewhere) and re-invokes the re-parse (readOrderedTurns) EXACTLY ONCE per
// detected end-of-turn, NOT on a fixed poll. If the signal never fires within the 5583ms turn
// watchdog, it re-parses ONCE on the watchdog as a safety net. The detector itself is story 024 — this
// only subscribes to its event.
//
// node:test runner: `node --experimental-strip-types --test test/lin-eot-cadence.test.ts`
import { test } from "node:test";
import assert from "node:assert/strict";
import { bindEndOfTurnReparse, TURN_WATCHDOG_MS } from "../dist/linearize.js";

/** A deterministic schedule seam: capture timers; fire/cancel them manually (no real timing). */
function makeSchedule() {
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  const schedule = (fn: () => void, ms: number) => {
    const t = { fn, ms, cancelled: false };
    timers.push(t);
    return () => {
      t.cancelled = true;
    };
  };
  return { schedule, timers };
}

test("each end-of-turn signal triggers exactly one re-parse (debounced by the detector)", () => {
  let count = 0;
  const { schedule } = makeSchedule();
  const binding = bindEndOfTurnReparse({ reparse: () => void count++, schedule });
  binding.notifyEndOfTurn();
  binding.notifyEndOfTurn();
  binding.notifyEndOfTurn();
  assert.equal(count, 3);
  binding.stop();
});

test("the turn watchdog fires a single safety-net re-parse when no signal arrives", () => {
  let count = 0;
  const { schedule, timers } = makeSchedule();
  const binding = bindEndOfTurnReparse({ reparse: () => void count++, schedule });
  // The first armed watchdog timer fires (no end-of-turn signal happened).
  const armed = timers.find((t) => !t.cancelled);
  assert.ok(armed, "a watchdog must be armed");
  assert.equal(armed!.ms, TURN_WATCHDOG_MS);
  armed!.fn();
  assert.equal(count, 1); // exactly one safety-net re-parse
  binding.stop();
});

test("a real end-of-turn signal cancels the pending watchdog (no double re-parse)", () => {
  let count = 0;
  const { schedule, timers } = makeSchedule();
  const binding = bindEndOfTurnReparse({ reparse: () => void count++, schedule });
  const firstWatchdog = timers[0];
  binding.notifyEndOfTurn(); // re-parse #1 AND cancels the armed watchdog
  assert.equal(count, 1);
  assert.equal(firstWatchdog.cancelled, true);
  binding.stop();
});

test("stop() is idempotent and suppresses further re-parses", () => {
  let count = 0;
  const { schedule } = makeSchedule();
  const binding = bindEndOfTurnReparse({ reparse: () => void count++, schedule });
  binding.stop();
  binding.stop();
  binding.notifyEndOfTurn();
  assert.equal(count, 0);
});
