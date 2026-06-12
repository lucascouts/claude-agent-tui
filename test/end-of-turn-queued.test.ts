// Story 024 / Task 2.2 — queued / back-to-back prompt confirmation (R4).
//
// E3 binding decision 2 (queued-prompt case): when a user/assistant write follows a terminal
// candidate BEFORE Δt elapses, the prior boundary is confirmed IMMEDIATELY (the Δt timer is
// cancelled) and a fresh detection cycle begins — two back-to-back turns must fire exactly twice,
// never merged into one boundary.
//
// node:test runner: `node --experimental-strip-types --test test/end-of-turn-queued.test.ts`
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
const user = (uuid: string) => ({ type: "user", uuid, message: { content: "next" } });

test("a user write within Δt confirms the prior boundary immediately (timer cancelled)", () => {
  const fired: unknown[] = [];
  const { schedule, advance } = makeClock();
  const d = createEndOfTurnDetector({ onEndOfTurn: (b) => fired.push(b), schedule });
  const boundary = asst("end_turn", "u1");
  d.observe(boundary);
  advance(50); // < Δt
  assert.equal(fired.length, 0);
  d.observe(user("u2")); // queued follow-up
  assert.equal(fired.length, 1, "queued follow-up confirms the prior boundary at once");
  assert.equal(fired[0], boundary);
  advance(200); // the cancelled Δt timer must NOT double-fire
  assert.equal(fired.length, 1);
});

test("two back-to-back turns fire exactly twice, never merged", () => {
  const fired: unknown[] = [];
  const { schedule, advance } = makeClock();
  const d = createEndOfTurnDetector({ onEndOfTurn: (b) => fired.push(b), schedule });
  const t1 = asst("end_turn", "u1");
  const t2 = asst("max_tokens", "u3");
  d.observe(t1);
  d.observe(user("u2")); // queued prompt before Δt → confirms t1 immediately
  assert.equal(fired.length, 1);
  d.observe(t2); // second turn reaches its terminal
  advance(200); // quiesces
  assert.equal(fired.length, 2, "two distinct boundaries, not merged into one");
  assert.deepEqual(fired, [t1, t2]);
});

test("a new turn's assistant write within Δt also confirms the prior boundary", () => {
  const fired: unknown[] = [];
  const { schedule } = makeClock();
  const d = createEndOfTurnDetector({ onEndOfTurn: (b) => fired.push(b), schedule });
  const t1 = asst("end_turn", "u1");
  d.observe(t1);
  // next turn's first assistant block (a non-terminal tool_use) arrives quickly
  d.observe(asst("tool_use", "u2"));
  assert.equal(fired.length, 1, "the prior boundary is confirmed by the new assistant write");
  assert.equal(fired[0], t1);
});
