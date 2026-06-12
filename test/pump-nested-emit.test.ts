// Story 041 / Group 2 (task 2.2) — the pump hydrates `Turn.nested` from the sidechain sourcing module
// (`sourceSubagentRows`) and emits each nested sub-agent row UNDER its spawning Task `tool_call`, with
// per-row dedup DECOUPLED from the parent-turn `emitted` gate (a NEW `session.emittedNested` set). The
// detector/guard/gate still consume the UN-merged main chain only (R4.1 structural) — sub-agent rows
// reach ONLY `forLinearize`. node:test runner:
//   node --experimental-strip-types --test test/pump-nested-emit.test.ts   (run `npm run build` first).
//
// Coverage: R3.1 (nested rows render under the Task id), R2.3 (idempotent across overlapping re-reads),
// R5.1 (reduced 6-field shape), R5.2 (no-subagent session emits identically to today — the cheap path).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeAcpAgent } from "../dist/acp-agent.js";

type Subagents = Record<string, unknown[]>;

/**
 * Build an agent whose pump reads `mainChain` for the main transcript and resolves sidechain rows from
 * `subagents` (agentId → its reduced SessionMessage[]) via the injected `listSubagents`/`getSubagentMessages`
 * seams — the SAME 4th-arg `AgentDeps` injection style as `getMessages`. `listCalls` counts the R5.2
 * cheap-path probe so a no-Task corpus can assert 0 invocations.
 */
function makeAgent(mainChain: unknown[], subagents: Subagents = {}) {
  const captured: any[] = [];
  const listCalls: string[] = [];
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
  const getMessages = async () => mainChain as never;
  const listSubagents = async (sessionId: string) => {
    listCalls.push(sessionId);
    return Object.keys(subagents);
  };
  const getSubagentMessages = async (_sessionId: string, agentId: string) =>
    (subagents[agentId] ?? []) as never;
  const agent: any = new ClaudeAcpAgent(client, undefined, undefined, {
    startEngine: fakeStartEngine,
    getMessages,
    listSubagents,
    getSubagentMessages,
  });
  return { agent, captured, listCalls };
}

async function freshSession(agent: any): Promise<string> {
  const r = await agent.createSession({ cwd: "/work", mcpServers: [] });
  return r.sessionId;
}

const txt = (uuid: string, role: string, text: string) => ({
  uuid,
  type: role,
  message: { role, content: [{ type: "text", text }] },
});

/** A main-chain assistant turn whose `tool_use` block spawns a Task sidechain (id `toolu_T`). */
const taskSpawn = (uuid: string, id: string) => ({
  uuid,
  type: "assistant",
  message: { role: "assistant", content: [{ type: "tool_use", id, name: "Task", input: { description: "sub" } }] },
});

/** A sub-agent (sidechain) row claimed by the spawning Task id via `parent_tool_use_id`. */
const subRow = (uuid: string, parentId: string, text: string) => ({
  uuid,
  type: "assistant",
  parent_tool_use_id: parentId,
  message: { role: "assistant", content: [{ type: "text", text }] },
});

const nestedUpdatesOn = (captured: any[], toolCallId: string) =>
  captured.filter((c) => c.update?.sessionUpdate === "tool_call_update" && c.update?.toolCallId === toolCallId);

// R3.1 — the sub-agent's rows are sourced + merged + linearized onto the spawning turn's `nested`, then
// emitted as `tool_call_update`s targeting the spawning Task's `tool_use.id` (nested UNDER the Task).
test("nested sub-agent rows emit as tool_call_update under the spawning Task id (R3.1)", async (t) => {
  const mainChain = [txt("m1", "assistant", "first"), taskSpawn("m2", "toolu_T")];
  const subagents: Subagents = {
    agentA: [subRow("s1", "toolu_T", "subagent work")],
  };
  const { agent, captured } = makeAgent(mainChain, subagents);
  t.after(() => agent.dispose());
  const sessionId = await freshSession(agent);

  await agent.pumpUpdates(sessionId);

  const nested = nestedUpdatesOn(captured, "toolu_T");
  assert.ok(nested.length >= 1, "at least one tool_call_update is emitted on the spawning Task id");
  // The sub-agent's text rendered as nested content WITHIN the parent Task tool_call.
  const flat = JSON.stringify(nested);
  assert.ok(flat.includes("subagent work"), "the sub-agent's content is nested under the Task id");
});

// R2.3 — overlapping re-reads (same corpus pumped twice) emit each nested row EXACTLY once. Dedup is the
// new per-row `emittedNested` set; the parent-turn `emitted` gate is independent.
test("nested rows are idempotent across overlapping re-reads — each emits exactly once (R2.3)", async (t) => {
  const mainChain = [taskSpawn("m2", "toolu_T")];
  const subagents: Subagents = {
    agentA: [subRow("s1", "toolu_T", "alpha")],
  };
  const { agent, captured } = makeAgent(mainChain, subagents);
  t.after(() => agent.dispose());
  const sessionId = await freshSession(agent);

  await agent.pumpUpdates(sessionId);
  const afterFirst = nestedUpdatesOn(captured, "toolu_T").length;
  await agent.pumpUpdates(sessionId); // identical re-read

  assert.ok(afterFirst >= 1, "first pump emits the nested row(s)");
  assert.equal(
    nestedUpdatesOn(captured, "toolu_T").length,
    afterFirst,
    "the second pump over the same corpus emits NO duplicate nested rows",
  );
});

// DECOUPLED-DEDUP PROOF — a sub-agent row that ARRIVES LATE (after the parent turn was already emitted in
// an earlier pump) must still emit. First pump: Task spawn present, NO sub-agent rows yet → the parent
// turn lands in `session.emitted`. Second pump: the sub-agent row now exists → it must emit DESPITE the
// parent uuid already being in `emitted` (the nested pass is decoupled from the `emitted` gate).
test("late-arriving sub-agent rows emit even though the parent turn is already in `emitted`", async (t) => {
  const mainChain = [taskSpawn("m2", "toolu_T")];
  const subagents: Subagents = {}; // first pump: NO sidechain rows yet
  const { agent, captured } = makeAgent(mainChain, subagents);
  t.after(() => agent.dispose());
  const sessionId = await freshSession(agent);

  await agent.pumpUpdates(sessionId);
  assert.equal(
    nestedUpdatesOn(captured, "toolu_T").length,
    0,
    "no nested rows yet — the parent Task turn is emitted, parent uuid now in `emitted`",
  );

  // The sub-agent transcript appears LATER (the live sidechain stream caught up). Mutate the corpus the
  // injected `listSubagents`/`getSubagentMessages` close over so the second pump now resolves it.
  subagents.agentA = [subRow("s1", "toolu_T", "late work")];
  await agent.pumpUpdates(sessionId);

  const nested = nestedUpdatesOn(captured, "toolu_T");
  assert.ok(nested.length >= 1, "the late sub-agent row emits despite the parent already in `emitted`");
  assert.ok(JSON.stringify(nested).includes("late work"), "the late nested content is surfaced");
});

// R5.2 — a no-subagent session emits IDENTICALLY to the pre-change pump. With NO Task/Agent tool_use in
// the main chain, `sourceSubagentRows` short-circuits and never calls `listSubagents` (the cheap path),
// and the emitted notifications byte-match the un-merged `linearizeTurns(messages)` path.
test("no-subagent session emits identically to today, and never probes listSubagents (R5.2)", async (t) => {
  const mainChain = [txt("u1", "assistant", "hello"), txt("u2", "user", "hi back")];
  const { agent, captured, listCalls } = makeAgent(mainChain, {});
  t.after(() => agent.dispose());
  const sessionId = await freshSession(agent);

  await agent.pumpUpdates(sessionId);

  assert.equal(listCalls.length, 0, "the cheap path: no Task/Agent tool_use → listSubagents never called");
  // Byte-for-byte the pre-change behavior: exactly the two top-level chunks, no tool_call_update at all.
  assert.equal(captured.length, 2, "exactly one chunk per text message — identical to the pre-change pump");
  assert.equal(captured[0].update.sessionUpdate, "agent_message_chunk");
  assert.deepEqual(captured[0].update.content, { type: "text", text: "hello" });
  assert.equal(captured[1].update.sessionUpdate, "user_message_chunk");
  assert.deepEqual(captured[1].update.content, { type: "text", text: "hi back" });
  assert.ok(
    !captured.some((c) => c.update?.sessionUpdate === "tool_call_update"),
    "no nested tool_call_update is emitted for a no-subagent session",
  );
});
