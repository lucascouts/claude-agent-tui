// Story 044 / Task 4.1 (R1.1, R1.3, R2.2, R2.3, R3.1, R3.2) — the pump arms/refreshes/tears down the
// Option-B sub-agent watcher, and its onActivity feeds BOTH liveness and the incremental render.
//
// The arm decision rides the MAIN-CHAIN spawn signal (`hasSubagentSpawn` + `spawnIdsOpen` — NOT the
// detector's `openTaskIds`, which is the inference that failed live in the 041 acceptance):
//   - a pumped chain with an OPEN Task/Agent spawn arms ONE watcher per session (flag ON);
//   - each pump refreshes the watcher (`update`); a chain whose every spawn id is CLOSED tears it
//     down (R2.2) — and `teardownSession` / turn-resolve / cancel also stop it (R2.3, no leaks);
//   - `onActivity` (fired by the watcher on a NEW sub-agent row) calls the in-flight detector's
//     `noteActivity()` AND re-runs the shared `emitLinearizedWithNested`, so the nested row renders
//     incrementally — while the Agent runs, with NO main-chain write — exactly once (R3.1/R3.2,
//     the unchanged per-row `emittedNested` dedup);
//   - with the flag OFF (the constructor default — the entrypoint is what defaults it ON), and on
//     a no-subagent turn, NOTHING arms: zero extra sub-agent IO (R4.2/R5.2).
//
// Fixture mirrors test/pump-nested-emit.test.ts (story 041) + the injected `schedule` fake clock
// (story 030 seam) so the SAME clock drives sendPrompt, the detector, and the watcher.
// node:test runner: `node --experimental-strip-types --test test/pump-subagent-watcher.test.ts`
// (run `npm run build` first — imports resolve against ../dist).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeAcpAgent } from "../dist/acp-agent.js";
import { SUBAGENT_POLL_MS } from "../dist/subagent-watcher.js";

type Subagents = Record<string, unknown[]>;

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

/** Drain the async poll/emit bodies queued by a clock tick. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/** One watcher tick: advance a poll interval, then drain. */
async function tick(clock: { advance: (ms: number) => void }, ms = SUBAGENT_POLL_MS) {
  clock.advance(ms);
  await flush();
}

/**
 * Build an agent whose pump reads a MUTABLE main chain (`chain.rows`) and resolves sidechain rows
 * from `subagents` via the injected story-041 seams — the pump-nested-emit fixture plus the
 * story-030 `schedule` fake clock and the story-044 `liveSubagentWatch` constructor flag.
 */
function makeAgent(opts: {
  rows: unknown[];
  subagents?: Subagents;
  liveSubagentWatch?: boolean;
  schedule: (fn: () => void, ms: number) => () => void;
}) {
  const captured: any[] = [];
  const listCalls: string[] = [];
  const chain = { rows: opts.rows };
  const subagents = opts.subagents ?? {};
  const client = {
    sessionUpdate: async (n: any) => {
      captured.push(n);
    },
    requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    readTextFile: async () => ({ content: "" }),
    writeTextFile: async () => ({}),
  } as never;
  const fakeStartEngine = (args: { sessionId?: string; cwd: string }) => ({
    sessionId: args.sessionId ?? "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    pty: {
      onExit: () => ({ dispose() {} }),
      onData: () => ({ dispose() {} }),
      resize() {},
      write() {},
      kill() {},
    } as never,
    watcher: { stop() {}, notifyEndOfTurn() {} },
    cwd: args.cwd,
  });
  const agent: any = new ClaudeAcpAgent(client, undefined, undefined, {
    startEngine: fakeStartEngine,
    getMessages: async () => [...chain.rows] as never,
    listSubagents: async (sessionId: string) => {
      listCalls.push(sessionId);
      return Object.keys(subagents);
    },
    getSubagentMessages: async (_s: string, agentId: string) => (subagents[agentId] ?? []) as never,
    schedule: opts.schedule,
    ...(opts.liveSubagentWatch === undefined ? {} : { liveSubagentWatch: opts.liveSubagentWatch }),
  });
  return { agent, captured, listCalls, chain, subagents };
}

async function freshSession(agent: any): Promise<string> {
  const r = await agent.createSession({ cwd: "/work", mcpServers: [] });
  return r.sessionId;
}

/** Main-chain assistant row whose `tool_use` spawns a Task sub-agent. */
const taskSpawn = (uuid: string, id: string) => ({
  uuid,
  type: "assistant",
  message: {
    role: "assistant",
    stop_reason: "tool_use",
    content: [{ type: "tool_use", id, name: "Task", input: { description: "sub" } }],
  },
});

/** Main-chain user row whose `tool_result` closes the spawning tool_use. */
const taskClose = (uuid: string, id: string) => ({
  uuid,
  type: "user",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "done" }] },
});

/** Plain text main-chain row (no spawn). */
const txt = (uuid: string, role: string, text: string) => ({
  uuid,
  type: role,
  message: { role, content: [{ type: "text", text }] },
});

/** A sub-agent (sidechain) row claimed by the spawning Task id. */
const subRow = (uuid: string, parentId: string, text: string) => ({
  uuid,
  type: "assistant",
  parent_tool_use_id: parentId,
  message: { role: "assistant", content: [{ type: "text", text }] },
});

const nestedUpdatesOn = (captured: any[], toolCallId: string) =>
  captured.filter(
    (c) => c.update?.sessionUpdate === "tool_call_update" && c.update?.toolCallId === toolCallId,
  );

// === R1.1 + R3.1 + R3.2 — arm on spawn; activity renders the nested row ONCE with no main write ===
test("an open Task spawn arms the watcher; a mid-turn sub-agent row renders incrementally, exactly once (R1.1/R3.1/R3.2)", async (t) => {
  const clock = makeClock();
  const { agent, captured, listCalls, subagents } = makeAgent({
    rows: [taskSpawn("m1", "toolu_T")],
    liveSubagentWatch: true,
    schedule: clock.schedule,
  });
  t.after(() => agent.dispose());
  const sid = await freshSession(agent);

  await agent.pumpUpdates(sid); // emits the Task tool_call; arms the watcher (spawn is OPEN)
  const callsAfterPump = listCalls.length;

  await tick(clock); // empty sidechain poll — no activity, but PROVES the watcher is armed
  assert.ok(listCalls.length > callsAfterPump, "the armed watcher polls the sidechain readers");
  assert.equal(nestedUpdatesOn(captured, "toolu_T").length, 0, "no sidechain rows yet → nothing nested");

  // The sub-agent makes progress: a NEW row appears with NO main-chain write and NO pump call.
  subagents.agentA = [subRow("s1", "toolu_T", "incremental sub-agent work")];
  await tick(clock);

  const nested = nestedUpdatesOn(captured, "toolu_T");
  assert.ok(nested.length >= 1, "the new sub-agent row rendered incrementally — no main-chain write needed (R3.1)");
  assert.ok(JSON.stringify(nested).includes("incremental sub-agent work"), "the nested content surfaced");

  // The SAME row polled again must not re-emit (per-row emittedNested dedup — R3.2).
  const countAfterFirst = nestedUpdatesOn(captured, "toolu_T").length;
  await tick(clock);
  await tick(clock);
  assert.equal(
    nestedUpdatesOn(captured, "toolu_T").length,
    countAfterFirst,
    "no-change polls re-emit NOTHING — at-most-once per nested row (R3.2)",
  );
});

// === onActivity feeds the in-flight detector's noteActivity() (R1.1 liveness wiring) ==============
test("watcher activity calls the in-flight turnDetector.noteActivity() (R1.1)", async (t) => {
  const clock = makeClock();
  const { agent, listCalls, subagents } = makeAgent({
    rows: [taskSpawn("m1", "toolu_T")],
    liveSubagentWatch: true,
    schedule: clock.schedule,
  });
  t.after(() => agent.dispose());
  const sid = await freshSession(agent);

  // Stand-in for the story-030 in-flight detector: only noteActivity is expected to be touched.
  let kicks = 0;
  agent.sessions[sid].turnDetector = {
    beginTurn() {},
    observe() {},
    noteActivity() {
      kicks += 1;
    },
    markCancelled() {},
    stop() {},
  };

  await agent.pumpUpdates(sid); // arms (spawn open)
  assert.ok(listCalls.length >= 1, "sanity: the spawn-carrying pump sourced the sidechain");

  subagents.agentA = [subRow("s1", "toolu_T", "alive")];
  await tick(clock);
  assert.ok(kicks >= 1, "observed sub-agent progress kicked noteActivity() — liveness without a main-chain write");

  subagents.agentA = [subRow("s1", "toolu_T", "alive"), subRow("s2", "toolu_T", "more")];
  await tick(clock);
  assert.ok(kicks >= 2, "each progress-bearing poll kicks liveness again");

  const kicksAfterProgress = kicks;
  await tick(clock); // no-change poll
  assert.equal(kicks, kicksAfterProgress, "a no-change poll feeds NO liveness (a hung sub-agent still trips)");
});

// === R5.2 — a no-subagent pump never arms anything: zero sub-agent IO ==============================
test("a no-subagent pump never arms the watcher — zero listSubagents calls ever (R5.2)", async (t) => {
  const clock = makeClock();
  const { agent, listCalls } = makeAgent({
    rows: [txt("u1", "assistant", "hello"), txt("u2", "user", "hi")],
    liveSubagentWatch: true,
    schedule: clock.schedule,
  });
  t.after(() => agent.dispose());
  const sid = await freshSession(agent);

  await agent.pumpUpdates(sid);
  await tick(clock);
  await tick(clock);
  await tick(clock);
  assert.equal(listCalls.length, 0, "no Task/Agent spawn → the cheap path holds AND no watcher ever polls");
});

// === R4.2 — constructor flag OFF (the default) → never arms, pull-only path byte-for-byte =========
test("flag OFF (constructor default) → the watcher never arms even with an open spawn (R4.2)", async (t) => {
  const clock = makeClock();
  const { agent, listCalls, subagents } = makeAgent({
    rows: [taskSpawn("m1", "toolu_T")],
    // liveSubagentWatch intentionally OMITTED → the constructor seam defaults OFF (042/043 shape)
    schedule: clock.schedule,
  });
  t.after(() => agent.dispose());
  const sid = await freshSession(agent);
  subagents.agentA = [subRow("s1", "toolu_T", "pull-only")];

  await agent.pumpUpdates(sid); // today's pull path: the EMIT sources the sidechain once
  const callsAfterPump = listCalls.length;
  assert.ok(callsAfterPump >= 1, "the story-041 pull-on-pump path still sources the sidechain");

  await tick(clock);
  await tick(clock);
  await tick(clock);
  assert.equal(listCalls.length, callsAfterPump, "flag OFF → NO watcher polls between pumps (pull-only, R4.2)");
});

// === R2.2 — a closed spawn tears the watcher down on the next pump ================================
test("once every spawn id is closed, the next pump stops the watcher (R2.2)", async (t) => {
  const clock = makeClock();
  const { agent, listCalls, chain } = makeAgent({
    rows: [taskSpawn("m1", "toolu_T")],
    liveSubagentWatch: true,
    schedule: clock.schedule,
  });
  t.after(() => agent.dispose());
  const sid = await freshSession(agent);

  await agent.pumpUpdates(sid); // arms (open spawn)
  await tick(clock);
  assert.ok(listCalls.length >= 2, "armed: the watcher polled at least once beyond the pump's own sourcing");

  // The Task completes on the main chain: spawn id now CLOSED → the pump must stop the watcher.
  chain.rows = [taskSpawn("m1", "toolu_T"), taskClose("m2", "toolu_T")];
  await agent.pumpUpdates(sid);
  const callsAfterClose = listCalls.length;

  await tick(clock);
  await tick(clock);
  await tick(clock);
  assert.equal(listCalls.length, callsAfterClose, "closed spawn → watcher stopped: no further polls (R2.2)");
});

// === R2.3 — teardownSession stops the watcher (no leaked timer/poll) ===============================
test("teardownSession (closeSession) stops the watcher — no polls after teardown (R2.3)", async (t) => {
  const clock = makeClock();
  const { agent, listCalls } = makeAgent({
    rows: [taskSpawn("m1", "toolu_T")],
    liveSubagentWatch: true,
    schedule: clock.schedule,
  });
  t.after(() => agent.dispose());
  const sid = await freshSession(agent);

  await agent.pumpUpdates(sid); // arms
  await tick(clock);
  assert.ok(listCalls.length >= 2, "armed before teardown");

  await agent.closeSession({ sessionId: sid });
  const callsAfterTeardown = listCalls.length;
  await tick(clock);
  await tick(clock);
  await tick(clock);
  assert.equal(listCalls.length, callsAfterTeardown, "a torn-down session never polls again (R2.3)");
});

// === R2.3 — cancel (markCancelled → turn resolve) stops the watcher via the prompt() finally ======
test("session/cancel resolves the turn and stops the watcher (R2.3, turn-resolve/markCancelled path)", async (t) => {
  const clock = makeClock();
  const { agent, listCalls } = makeAgent({
    rows: [taskSpawn("m1", "toolu_T")],
    liveSubagentWatch: true,
    schedule: clock.schedule,
  });
  t.after(() => agent.dispose());
  const sid = await freshSession(agent);

  // A real in-flight turn: prompt() registers the detector + cancel handle (story 030/031 wiring).
  const turn = agent.prompt({ sessionId: sid, prompt: [{ type: "text", text: "go" }] });
  await agent.pumpUpdates(sid); // arms the watcher while the turn is in flight
  await tick(clock);
  assert.ok(listCalls.length >= 2, "armed during the in-flight turn");

  await agent.cancel({ sessionId: sid }); // story-031 latch → PromptResponse{cancelled}
  const res = await turn;
  assert.equal(res.stopReason, "cancelled", "the cancel path resolved the prompt");

  const callsAfterCancel = listCalls.length;
  await tick(clock);
  await tick(clock);
  await tick(clock);
  assert.equal(listCalls.length, callsAfterCancel, "a cancelled turn leaves NO live watcher behind (R2.3)");
});
