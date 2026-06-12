// Story 044 / Task 5.1 — KEYSTONE repro (R1.1, R1.2, R1.3, R5.1): the live false-stall and its fix.
//
// The story-041 live acceptance (claude 2.1.173) hit this gap: a turn spawns a `Task`/`Agent`
// sub-agent that works for minutes; ALL its rows land in `subagents/agent-*.jsonl` — the MAIN
// transcript stays silent — so the stall watchdog saw no activity and tripped
// (`end-of-turn not detected within 120000ms`), wrongly aborting a HEALTHY turn.
//
//   Case A models the gap exactly: a silent main chain with NO liveness source → the watchdog
//          trips (the bug, and — for a genuinely dead turn — the contract that must survive).
//   Case B adds the Option-B sub-agent watcher: it polls the story-041 SDK readers, observes a
//          fresh sub-agent row each tick, and feeds the detector's `noteActivity()` seam → the
//          SAME span of silence no longer trips, and the turn still resolves normally once the
//          real `tool_result` + terminal stop arrive (no over-hold).
//   R1.3   the `FORK_TURN_WATCHDOG_MS` override stays the window liveness composes with: a
//          sub-agent that STOPS emitting (hung) still trips at the override window.
//
// One injected fake clock drives detector + watcher — never real time (mirrors
// test/end-of-turn-inflight-task.test.ts). node:test runner:
//   node --experimental-strip-types --test test/subagent-watchdog-repro.test.ts
// (run `npm run build` first — the behavioral imports resolve against ../dist).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createEndOfTurnDetector,
  TurnTimeoutError,
  TURN_WATCHDOG_MS,
} from "../dist/end-of-turn.js";
import { createSubagentWatcher } from "../dist/subagent-watcher.js";

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

/** Drain the async poll body (sourceSubagentRows → onActivity) queued by a clock tick. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Reduced-shape main-chain assistant row whose `tool_use` spawns a Task sub-agent (kept OPEN). */
const taskSpawn = (uuid: string, id: string) => ({
  uuid,
  type: "assistant",
  message: {
    role: "assistant",
    stop_reason: "tool_use",
    content: [{ type: "tool_use", id, name: "Task", input: { description: "sub" } }],
  },
});

/** A sub-agent (sidechain) row as the SDK readers return it — fresh work each poll tick. */
const subRow = (uuid: string, parentId: string, text: string) => ({
  uuid,
  type: "assistant",
  parent_tool_use_id: parentId,
  message: { role: "assistant", content: [{ type: "text", text }] },
});

/** A main-chain user `tool_result` that closes the Task tool_use `id`. */
const taskToolResult = (id: string, uuid: string) => ({
  type: "user",
  uuid,
  message: { content: [{ type: "tool_result", tool_use_id: id, content: "subagent done" }] },
});

/** A main-chain terminal assistant boundary. */
const asst = (stop_reason: unknown, uuid: string) => ({
  type: "assistant",
  uuid,
  message: { stop_reason },
});

// === Case A — the live gap (baseline): no liveness source → the silent turn trips ================
test("Case A — silent main chain, sub-agent liveness invisible: the stall watchdog trips (the live gap)", () => {
  const fired: unknown[] = [];
  let timedOut: TurnTimeoutError | undefined;
  const { schedule, advance } = makeClock();
  const d = createEndOfTurnDetector({
    onEndOfTurn: (b) => fired.push(b),
    onTurnTimeout: (e) => {
      timedOut = e;
    },
    schedule,
    watchdogMs: TURN_WATCHDOG_MS, // pin the window so the fake clock is deterministic
  });
  d.beginTurn();
  // The sub-agent works the whole window, but its rows land ONLY in subagents/ — the detector
  // observes NOTHING (the openTaskIds hold never engaged in the live run: the gap). Pure silence.
  advance(TURN_WATCHDOG_MS);
  assert.ok(
    timedOut instanceof TurnTimeoutError,
    "without a liveness source, the silent turn trips the stall watchdog (the live bug / dead-turn contract)",
  );
  assert.equal(fired.length, 0, "no end-of-turn fired for the tripped turn");
});

// === Case B — the fix: the sub-agent watcher feeds noteActivity() → no trip, normal resolve ======
test("Case B — same silence + sub-agent watcher feeding noteActivity(): no trip, then a normal resolve (R1.1/R1.2/R5.1)", async () => {
  const fired: unknown[] = [];
  let timedOut: TurnTimeoutError | undefined;
  const { schedule, advance } = makeClock();
  const d = createEndOfTurnDetector({
    onEndOfTurn: (b) => fired.push(b),
    onTurnTimeout: (e) => {
      timedOut = e;
    },
    schedule,
    watchdogMs: TURN_WATCHDOG_MS,
  });

  // The Option-B watcher polls the story-041 SDK readers; the main chain carries the OPEN Task
  // spawn (no tool_result yet) so the spawn guard arms the probe. A HEALTHY sub-agent appends a
  // fresh row each tick — every poll observes a new uuid and fires onActivity → noteActivity().
  const subRows: unknown[] = [];
  const watcher = createSubagentWatcher({
    sessionId: "sess-repro",
    mainChain: [taskSpawn("m1", "toolu_T")] as never,
    listSubagents: async () => ["agentA"],
    getSubagentMessages: async () => [...subRows] as never,
    onActivity: () => {
      d.noteActivity();
    },
    schedule,
    pollMs: 1000,
  });

  d.beginTurn();
  // 8 poll ticks × 1000 ms = 8000 ms of main-chain silence — well past the 5583 ms window. The
  // detector observes NOTHING on the main chain the whole time; only the watcher sees progress.
  for (let i = 0; i < 8; i++) {
    subRows.push(subRow(`s-${i}`, "toolu_T", `sub-agent step ${i}`));
    advance(1000);
    await flush();
  }
  assert.equal(timedOut, undefined, "an ACTIVE sub-agent keeps the silent main chain alive (R1.2)");
  assert.equal(fired.length, 0, "the turn stays OPEN while the sub-agent works");

  // The sub-agent finishes: the main chain resumes with the closing tool_result + terminal stop —
  // the turn resolves NORMALLY (no over-hold; liveness never blocks a real resolution).
  d.observe(taskToolResult("toolu_T", "u-result"));
  const boundary = asst("end_turn", "u-final");
  d.observe(boundary);
  advance(200); // Δt quiescence confirms the boundary
  assert.equal(fired.length, 1, "the real terminal stop still resolves the turn exactly once");
  assert.equal(fired[0], boundary, "the boundary is the real main-chain terminal stop");
  assert.equal(timedOut, undefined, "a normal resolution, not a watchdog timeout");
  watcher.stop();
});

// === R1.3 — the FORK_TURN_WATCHDOG_MS override composes with liveness (and a hung sub-agent trips)
test("R1.3 — FORK_TURN_WATCHDOG_MS stays the stall window: liveness composes with it; a hung sub-agent still trips at it", async () => {
  const prev = process.env.FORK_TURN_WATCHDOG_MS;
  process.env.FORK_TURN_WATCHDOG_MS = "3000"; // override window — far below the 120 s default
  try {
    const fired: unknown[] = [];
    let timedOut: TurnTimeoutError | undefined;
    const { schedule, advance } = makeClock();
    // NO explicit watchdogMs: the detector must resolve the env override as the window (R1.3).
    const d = createEndOfTurnDetector({
      onEndOfTurn: (b) => fired.push(b),
      onTurnTimeout: (e) => {
        timedOut = e;
      },
      schedule,
    });
    const subRows: unknown[] = [];
    const watcher = createSubagentWatcher({
      sessionId: "sess-override",
      mainChain: [taskSpawn("m1", "toolu_T")] as never,
      listSubagents: async () => ["agentA"],
      getSubagentMessages: async () => [...subRows] as never,
      onActivity: () => {
        d.noteActivity();
      },
      schedule,
      pollMs: 1000,
    });
    d.beginTurn();

    // Phase 1 — healthy sub-agent: fresh row each tick for 5 ticks (5000 ms > the 3000 ms window):
    // liveness composes with the OVERRIDE window — no trip.
    for (let i = 0; i < 5; i++) {
      subRows.push(subRow(`o-${i}`, "toolu_T", `step ${i}`));
      advance(1000);
      await flush();
    }
    assert.equal(timedOut, undefined, "liveness re-arms the OVERRIDE window, not a hardcoded one");

    // Phase 2 — the sub-agent HANGS (no new rows ever again): no-change polls feed NO liveness, so
    // the turn trips after exactly the override window of real silence — the "fail a dead turn
    // loudly" contract survives Option B, at the env-resolved window (R1.3).
    advance(3001);
    await flush();
    assert.ok(
      timedOut instanceof TurnTimeoutError,
      "a HUNG sub-agent (no observed progress) still trips at the FORK_TURN_WATCHDOG_MS window",
    );
    assert.equal(timedOut?.elapsedMs, 3000, "the tripped window IS the env override (R1.3)");
    assert.equal(fired.length, 0, "no end-of-turn fired for the hung turn");
    watcher.stop();
  } finally {
    if (prev === undefined) delete process.env.FORK_TURN_WATCHDOG_MS;
    else process.env.FORK_TURN_WATCHDOG_MS = prev;
  }
});
