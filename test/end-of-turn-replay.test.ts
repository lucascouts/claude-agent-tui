// Story 024 / Task 5 — recorded multi-turn replay acceptance (ROADMAP Degrau-1 aceite, §14/§16).
//
// Replays a recorded, sanitized multi-turn JSONL through the detector with a fake clock and asserts
// exactly one end-of-turn per turn at the E3 Δt, that no tool_use mid-turn pause fires a boundary,
// that the queued back-to-back pair yields two DISTINCT resolutions (not merged), and that each fire
// resolves one PromptResponse with the expected mapped stopReason. Task 5.2 adds the no-signal case.
//
// This is an ACCEPTANCE/regression guard over the runtime delivered by Task groups 1–4 (the detector
// already exists and passes its unit suites) — its Red here is the absent fixture, proving the test
// drives the real recorded transcript + the real detector.
//
// node:test runner: `node --experimental-strip-types --test test/end-of-turn-replay.test.ts`
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createEndOfTurnDetector,
  createTurnResolver,
  isTerminalStop,
  DELTA_T_MS,
  TURN_WATCHDOG_MS,
  TurnTimeoutError,
  type StopReasonEvent,
} from "../dist/end-of-turn.js";
import { mapStopReason } from "../dist/stop-reason-map.js";

function loadJsonl(relPath: string): StopReasonEvent[] {
  const path = fileURLToPath(new URL(relPath, import.meta.url));
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as StopReasonEvent);
}

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

const stopReasonOf = (e: StopReasonEvent) =>
  mapStopReason((e.message as { stop_reason?: unknown })?.stop_reason);

test("multi-turn fixture: exactly one end-of-turn per turn, queued pair not merged, mapped stopReasons", () => {
  const events = loadJsonl("./fixtures/multi-turn.jsonl");
  const turnCount = events.filter((e) => isTerminalStop(e)).length;
  assert.equal(turnCount, 3, "fixture has three terminal-stop turns (end_turn, max_tokens, end_turn)");

  const resolved: string[] = [];
  const { schedule, advance } = makeClock();
  const d = createEndOfTurnDetector({
    onEndOfTurn: (b) => resolved.push(stopReasonOf(b)),
    schedule,
  });

  // Turn 1 (events 0–3) — confirmed by Δt QUIESCENCE; the tool_use pause (event 1) must NOT fire.
  d.observe(events[0]); // user prompt
  d.observe(events[1]); // assistant tool_use (mid-turn pause)
  d.observe(events[2]); // user tool_result
  d.observe(events[3]); // assistant end_turn (terminal)
  advance(DELTA_T_MS); // quiescence → boundary 1
  assert.equal(resolved.length, 1, "tool_use pause did not fire; quiescence confirmed turn 1");

  // Turn 2 (events 4–5) then Turn 3 queued (events 6–7): event 6 arrives < Δt → confirms turn 2 now.
  d.observe(events[4]); // user prompt
  d.observe(events[5]); // assistant max_tokens (terminal)
  d.observe(events[6]); // user QUEUED prompt (< Δt) → confirms turn 2 immediately (not merged)
  assert.equal(resolved.length, 2, "the queued follow-up confirmed turn 2 at once");
  d.observe(events[7]); // assistant end_turn (terminal)
  advance(DELTA_T_MS); // quiescence → boundary 3

  assert.equal(resolved.length, turnCount, "endOfTurnCount === turnCount (one per turn)");
  assert.deepEqual(
    resolved,
    ["end_turn", "max_tokens", "end_turn"],
    "each fire resolved one PromptResponse with the expected mapped stopReason",
  );
});

// === Task 5.2 — no-signal case trips the watchdog (R5.2, R2.1) ===================================

test("no-signal fixture: trips the 5583ms watchdog, surfaces TurnTimeoutError, fires zero end-of-turns", () => {
  const events = loadJsonl("./fixtures/no-signal.jsonl");
  assert.equal(
    events.filter((e) => isTerminalStop(e)).length,
    0,
    "the fixture never reaches a terminal stop",
  );

  let endOfTurns = 0;
  let err: unknown = null;
  const { schedule, advance } = makeClock();
  const d = createEndOfTurnDetector({
    onEndOfTurn: () => endOfTurns++,
    onTurnTimeout: (e) => {
      err = e;
    },
    sessionId: "sess-no-signal",
    schedule,
    // Story 034 made the DEFAULT the generous stall window; the E3 window is pinned explicitly —
    // this test proves the timeout MECHANISM (typed error, zero end-of-turns), not the default.
    watchdogMs: TURN_WATCHDOG_MS,
  });
  d.beginTurn();
  for (const e of events) d.observe(e);
  advance(TURN_WATCHDOG_MS); // past the turn watchdog under the fake clock — no hang
  assert.ok(err instanceof TurnTimeoutError, "a TurnTimeoutError is surfaced at the watchdog");
  assert.equal((err as TurnTimeoutError).elapsedMs, 5583);
  assert.equal(endOfTurns, 0, "zero end-of-turn signals on a no-signal turn");
});

test("no-signal fixture via the resolver: the pending prompt rejects with the surfaced error (no hang)", async () => {
  const events = loadJsonl("./fixtures/no-signal.jsonl");
  const { schedule, advance } = makeClock();
  const { detector, promise } = createTurnResolver({
    schedule,
    sessionId: "sess-no-signal",
    watchdogMs: TURN_WATCHDOG_MS, // E3 window pinned — the default is the story-034 stall window
  });
  detector.beginTurn();
  for (const e of events) detector.observe(e);
  advance(TURN_WATCHDOG_MS);
  let outcome = "";
  await promise.then(
    () => {
      outcome = "resolved";
    },
    (e: Error) => {
      outcome = "rejected:" + e.name;
    },
  );
  assert.equal(outcome, "rejected:TurnTimeoutError", "the prompt rejects with the surfaced error");
});
