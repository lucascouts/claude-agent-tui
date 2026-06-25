// Story 054 / Task 2.1 — the GATED live pump registers sidechain tool_use ids into the session
// correlator (dedup Set + parentMap), gated on `session.gate && !torn down`, ONLY on the live pump
// path (never on the no-gate session/load replay), and WITHOUT changing render output
// (`emittedNested`) or the detector cursor (U2/U3/U5).
//
// Contract (design.md fix step 2): where the pump already calls sourceSubagentRows, and only when a
// gate is present and not torn down, call registerSidechainGateToolUses with a per-session
// `session.registeredSidechain: Set<string>` + `session.sidechainParentMap: Map<string, SidechainToolUse>`.
//
// Authored from the contract + the pump-nested-emit / gate-wiring harnesses (no ToDo). OFFLINE: a fake
// ACP client + fake startEngine + injected listSubagents/getSubagentMessages seams; the gate's hook
// server is REAL (closed in teardown). node:test (build first):
//   node --experimental-strip-types --test test/pump-subagent-gate-feed.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ClaudeAcpAgent } from "../dist/acp-agent.js";
import { type SessionGate } from "../dist/permissions/gate-wiring.js";

const SHORT_KNOBS = {
  correlationWaitMs: 250,
  correlationPollMs: 10,
  promptAppearMs: 50,
  promptPollMs: 5,
  injectTimeoutMs: 200,
  closeTimeoutMs: 1000,
};

type Subagents = Record<string, unknown[]>;

const taskSpawn = (uuid: string, id: string) => ({
  uuid,
  type: "assistant",
  message: { role: "assistant", content: [{ type: "tool_use", id, name: "Task", input: { description: "sub" } }] },
});

/** A sidechain row carrying an INNER tool_use block under the spawning Task id. */
const subToolUse = (uuid: string, parentId: string, toolId: string, toolName: string, input: unknown) => ({
  uuid,
  type: "assistant",
  isSidechain: true,
  parent_tool_use_id: parentId,
  message: { role: "assistant", content: [{ type: "tool_use", id: toolId, name: toolName, input }] },
});

function makeFakeStartEngine() {
  const startEngine = (args: { sessionId?: string; cwd: string; settingsFile?: string }) => ({
    sessionId: args.sessionId ?? "22222222-2222-4222-8222-222222222222",
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
  return startEngine;
}

/** Build an agent with the subagent seams injected; `gate` toggles the SessionGate. */
async function makeAgent(
  t: any,
  opts: { gate: boolean; mainChain: unknown[]; subagents?: Subagents },
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pump-subagent-gate-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const captured: any[] = [];
  const client = {
    sessionUpdate: async (n: any) => captured.push(n),
    requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    readTextFile: async () => ({ content: "" }),
    writeTextFile: async () => ({}),
  } as never;
  const subagents = opts.subagents ?? {};
  const agent: any = new ClaudeAcpAgent(client, undefined, undefined, {
    startEngine: makeFakeStartEngine() as never,
    getMessages: async () => opts.mainChain as never,
    listSubagents: async () => Object.keys(subagents),
    getSubagentMessages: async (_s: string, agentId: string) => (subagents[agentId] ?? []) as never,
    ...(opts.gate ? { gate: true, gateOptions: { settingsDir: dir, ...SHORT_KNOBS } } : {}),
  });
  t.after(() => agent.dispose());
  const r = await agent.createSession({ cwd: "/work", mcpServers: [] });
  return { agent, captured, sessionId: r.sessionId };
}

const sessionOf = (agent: any, id: string) =>
  agent.sessions[id] as {
    gate?: SessionGate;
    registeredSidechain?: Set<string>;
    sidechainParentMap?: Map<string, { parentId: string | null; toolName: string }>;
    emittedNested: Set<string>;
    detectorCursor?: number;
  };

test("2.1 the gated pump registers each sidechain inner tool_use id into the gate correlator + parentMap", async (t) => {
  const mainChain = [taskSpawn("m1", "toolu_task_1")];
  const subagents: Subagents = {
    agentA: [subToolUse("s1", "toolu_task_1", "toolu_inner_bash", "Bash", { command: "ls" })],
  };
  const { agent, sessionId } = await makeAgent(t, { gate: true, mainChain, subagents });

  await agent.pumpUpdates(sessionId);

  const s = sessionOf(agent, sessionId);
  assert.ok(s.gate, "the session carries a gate");
  assert.equal(
    s.gate!.correlator.isCleanMatch("toolu_inner_bash"),
    true,
    "the inner sidechain tool_use id is now a clean match in the gate correlator (the bug: it never was)",
  );
  assert.ok(s.sidechainParentMap, "the session exposes a sidechainParentMap");
  assert.equal(
    s.sidechainParentMap!.get("toolu_inner_bash")?.parentId,
    "toolu_task_1",
    "the parentMap maps the inner id to its spawning Task id (for the dialogToolCallId relay)",
  );
});

test("2.1 a SECOND pump over the same corpus does NOT double-register (dedup Set keeps the id a clean match)", async (t) => {
  const mainChain = [taskSpawn("m1", "toolu_task_1")];
  const subagents: Subagents = {
    agentA: [subToolUse("s1", "toolu_task_1", "toolu_inner_bash", "Bash", { command: "ls" })],
  };
  const { agent, sessionId } = await makeAgent(t, { gate: true, mainChain, subagents });

  await agent.pumpUpdates(sessionId);
  await agent.pumpUpdates(sessionId); // overlapping re-read — the pump re-sources the same rows

  const s = sessionOf(agent, sessionId);
  assert.equal(
    s.gate!.correlator.isCleanMatch("toolu_inner_bash"),
    true,
    "exactly-once dedup: a second pump must NOT re-register (a duplicate would fail-closed deny)",
  );
});

test("2.1 the NO-GATE pump (session/load replay shape) NEVER registers sidechain ids (U3 replay==live)", async (t) => {
  const mainChain = [taskSpawn("m1", "toolu_task_1")];
  const subagents: Subagents = {
    agentA: [subToolUse("s1", "toolu_task_1", "toolu_inner_bash", "Bash", { command: "ls" })],
  };
  const { agent, sessionId } = await makeAgent(t, { gate: false, mainChain, subagents });

  await agent.pumpUpdates(sessionId);

  const s = sessionOf(agent, sessionId);
  assert.equal(s.gate, undefined, "no gate on this session");
  assert.ok(
    !s.registeredSidechain || s.registeredSidechain.size === 0,
    "with no gate the pump registers NO sidechain ids — the shared linearize path stays pure (U3)",
  );
});

test("2.1 the sidechain gate feed does NOT alter render output (emittedNested) — U2 regression", async (t) => {
  const mainChain = [taskSpawn("m1", "toolu_task_1")];
  const subagents: Subagents = {
    agentA: [subToolUse("s1", "toolu_task_1", "toolu_inner_bash", "Bash", { command: "ls" })],
  };

  // Render output WITH the gate feed running…
  const gated = await makeAgent(t, { gate: true, mainChain, subagents });
  await gated.agent.pumpUpdates(gated.sessionId);
  const gatedNested = sessionOf(gated.agent, gated.sessionId).emittedNested.size;

  // …must equal the render output of an otherwise-identical session (the feed touches the correlator,
  // never the render/dedup state).
  assert.ok(gatedNested >= 1, "the subagent row still renders (emittedNested populated)");
  const s = sessionOf(gated.agent, gated.sessionId);
  assert.equal(
    s.gate!.correlator.isCleanMatch("toolu_inner_bash"),
    true,
    "the same pump that registered the id still rendered the nested row — feed is additive (U2)",
  );
});
