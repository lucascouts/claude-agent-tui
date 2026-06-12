// Story 024 / Task 4.2 — resolve the pending session/prompt once per boundary (R2).
//
// createTurnResolver wraps the detector in an awaitable Promise<PromptResponse> the rewritten
// prompt() loop (story 023) consumes: it stays pending across all mid-turn (tool_use/null) events,
// resolves EXACTLY ONCE with { stopReason: mapStopReason(boundary.message.stop_reason) } on the
// terminal boundary, and rejects with the surfaced TurnTimeoutError on a watchdog trip. A
// single-resolution latch makes a detector/watchdog/cancel race settle the prompt exactly once.
//
// node:test runner: `node --experimental-strip-types --test test/prompt-resolution.test.ts`
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTurnResolver } from "../dist/end-of-turn.js";

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

test("stays pending through tool_use/null mid-turn events, resolves once on the terminal boundary", async () => {
  const { schedule, advance } = makeClock();
  const { detector, promise } = createTurnResolver({ schedule });
  detector.beginTurn();
  detector.observe(asst("tool_use", "u1"));
  detector.observe({ type: "user", uuid: "u2", message: { content: "tool result" } });
  detector.observe(asst(null, "u3"));
  let settled = false;
  void promise.then(() => {
    settled = true;
  });
  await Promise.resolve(); // flush microtasks
  assert.equal(settled, false, "the response stays pending across mid-turn events");
  detector.observe(asst("max_tokens", "u4")); // terminal
  advance(200);
  assert.deepEqual(await promise, { stopReason: "max_tokens" });
});

test("end_turn / stop_sequence boundaries resolve with mapped ACP end_turn", async () => {
  const { schedule, advance } = makeClock();
  const { detector, promise } = createTurnResolver({ schedule });
  detector.beginTurn();
  detector.observe(asst("stop_sequence", "u1"));
  advance(200);
  assert.deepEqual(await promise, { stopReason: "end_turn" });
});

test("a watchdog-then-late-boundary race yields a single resolution (rejects once)", async () => {
  const { schedule, advance } = makeClock();
  const { detector, promise } = createTurnResolver({
    schedule,
    sessionId: "s1",
    watchdogMs: 5583, // E3 window pinned — the default is the story-034 stall window
  });
  detector.beginTurn();
  detector.observe(asst("tool_use", "u1"));
  advance(5583); // watchdog trips first → reject
  let outcome = "";
  await promise.then(
    () => {
      outcome = "resolved";
    },
    (e: Error) => {
      outcome = "rejected:" + e.name;
    },
  );
  assert.equal(outcome, "rejected:TurnTimeoutError");
  // a late boundary after the watchdog must NOT produce a second resolution (detector is stopped)
  detector.observe(asst("end_turn", "u2"));
  advance(200);
  assert.ok(true, "no second settlement / no unhandled rejection");
});
