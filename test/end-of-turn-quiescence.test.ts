// Story 024 / Task 2.1 — Δt = 200 ms quiescence window + per-turn `fired` latch.
//
// E3 binding decision 2: a terminal candidate (Task 1) is CONFIRMED only after Δt = 200 ms of
// quiescence with no further user/assistant write. The detector arms a Δt timer on the candidate
// and emits exactly one end-of-turn on expiry; a `fired` latch keyed on the event uuid prevents the
// same terminal event from firing twice. Timing is driven by an injected schedule seam (fake clock),
// never real time — mirrors test/lin-eot-cadence.test.ts.
//
// node:test runner: `node --experimental-strip-types --test test/end-of-turn-quiescence.test.ts`
// (run `npm run build` first — the behavioral import resolves against ../dist).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createEndOfTurnDetector, DELTA_T_MS } from "../dist/end-of-turn.js";

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

const asst = (stop_reason: unknown, uuid: string) => ({
  type: "assistant",
  uuid,
  message: { stop_reason },
});

test("DELTA_T_MS is the E3 binding quiescence window (200 ms)", () => {
  assert.equal(DELTA_T_MS, 200);
});

test("a terminal candidate + 200 ms of silence confirms exactly one boundary", () => {
  const fired: unknown[] = [];
  const { schedule, advance } = makeClock();
  const d = createEndOfTurnDetector({ onEndOfTurn: (b) => fired.push(b), schedule });
  const boundary = asst("end_turn", "u1");
  d.observe(boundary);
  advance(199);
  assert.equal(fired.length, 0, "must not confirm before Δt elapses");
  advance(1); // total 200 ms
  assert.equal(fired.length, 1, "confirms exactly once at Δt");
  assert.equal(fired[0], boundary, "the boundary is the terminal candidate");
});

test("silence shorter than Δt does not yet confirm", () => {
  const fired: unknown[] = [];
  const { schedule, advance } = makeClock();
  const d = createEndOfTurnDetector({ onEndOfTurn: (b) => fired.push(b), schedule });
  d.observe(asst("end_turn", "u1"));
  advance(199);
  assert.equal(fired.length, 0);
});

test("a tool_use pause does not arm the quiescence timer", () => {
  const fired: unknown[] = [];
  const { schedule, advance } = makeClock();
  const d = createEndOfTurnDetector({ onEndOfTurn: (b) => fired.push(b), schedule });
  d.observe(asst("tool_use", "u1"));
  advance(1000);
  assert.equal(fired.length, 0, "mid-turn pause is not a boundary");
});

test("the fired latch prevents the same terminal event from firing twice", () => {
  const fired: unknown[] = [];
  const { schedule, advance } = makeClock();
  const d = createEndOfTurnDetector({ onEndOfTurn: (b) => fired.push(b), schedule });
  const boundary = asst("end_turn", "u1");
  d.observe(boundary);
  advance(200);
  assert.equal(fired.length, 1);
  // the same terminal event (same uuid) observed again must NOT re-fire
  d.observe(boundary);
  advance(200);
  assert.equal(fired.length, 1, "an already-fired uuid does not re-fire");
});
