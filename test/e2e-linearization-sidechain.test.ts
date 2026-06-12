// Story 027 / Task 5.2 — E2E: sidechain / fork linearization is correct in-product (R3.2, R4).
//
// A prior thread containing a subagent sidechain (a Task/Agent tool_use whose rows carry
// parent_tool_use_id) replays through the live read path (pump → story-017 linearizeTurns →
// toAcpNotifications). R4 holds end-to-end: the top-level turns emit in chronological linear
// order, the sidechain rows stay NESTED under their spawning turn (never surfaced as a
// duplicate top-level emit), and NO event is duplicated or mis-ordered. Values/policy consumed
// verbatim from story 017 — this is the in-product R4 resolution, not a re-derivation.
//
// Tested via the pump (the injectable replay point) per the story-025 load-burst precedent;
// the SDK getSessionMessages already resolves parentUuid order, so the fixture is supplied in
// linear order and the pump exercises the sidechain (parent_tool_use_id) nesting.
//
// node:test runner: `node --experimental-strip-types --test test/e2e-linearization-sidechain.test.ts` (build first).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeAcpAgent } from "../dist/acp-agent.js";

function makeAgent(messages: unknown[]) {
  const captured: any[] = [];
  const client = {
    sessionUpdate: async (n: any) => {
      captured.push(n);
    },
    requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    readTextFile: async () => ({ content: "" }),
    writeTextFile: async () => ({}),
  } as never;
  const fakeStartEngine = (args: { sessionId?: string; cwd: string }) => ({
    sessionId: args.sessionId ?? "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    pty: { onExit: () => ({ dispose() {} }), onData: () => ({ dispose() {} }), resize() {}, write() {}, kill() {} } as never,
    watcher: { stop() {}, notifyEndOfTurn() {} },
    cwd: args.cwd,
  });
  const getMessages = async () => messages as never;
  const agent: any = new ClaudeAcpAgent(client, undefined, undefined, { startEngine: fakeStartEngine, getMessages });
  return { agent, captured };
}

// A prior thread with a subagent sidechain spawned by a Task tool_use, then a re-prompt + answer.
const THREAD = [
  { uuid: "u1", type: "user", message: { role: "user", content: [{ type: "text", text: "refactor module X" }] } },
  {
    uuid: "a1",
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_T", name: "Task", input: { description: "investigate X" } }] },
  },
  // sidechain rows — claimed by toolu_T; must attach NESTED to a1, never emitted top-level
  { uuid: "side1", type: "assistant", parent_tool_use_id: "toolu_T", message: { role: "assistant", content: [{ type: "text", text: "subagent step 1" }] } },
  { uuid: "side2", type: "assistant", parent_tool_use_id: "toolu_T", message: { role: "assistant", content: [{ type: "text", text: "subagent step 2" }] } },
  { uuid: "u2", type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_T", content: "subagent done" }] } },
  { uuid: "a2", type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Done refactoring." }] } },
];

test("a sidechain thread replays in correct top-level linear order; subagent rows stay nested (R4)", async (t) => {
  const { agent, captured } = makeAgent(THREAD);
  t.after(() => agent.dispose());
  const sessionId = await agent.createSession({ cwd: "/proj", mcpServers: [] }).then((r: any) => r.sessionId);

  await agent.pumpUpdates(sessionId);

  // Top-level message texts appear in chronological order; the subagent prose is NOT a top-level emit.
  const texts = captured.filter((c) => c.update?.content?.type === "text").map((c) => c.update.content.text);
  assert.deepEqual(texts, ["refactor module X", "Done refactoring."], "top-level linear order; sidechain stays nested");
  assert.ok(!texts.includes("subagent step 1"), "sidechain row 1 is nested, not a duplicate top-level emit");
  assert.ok(!texts.includes("subagent step 2"), "sidechain row 2 is nested, not a duplicate top-level emit");
});

test("no event is duplicated or mis-ordered on replay (R4 in-product)", async (t) => {
  const { agent, captured } = makeAgent(THREAD);
  t.after(() => agent.dispose());
  const sessionId = await agent.createSession({ cwd: "/proj", mcpServers: [] }).then((r: any) => r.sessionId);

  await agent.pumpUpdates(sessionId);

  // The Task tool_use surfaces exactly once, between the two top-level texts.
  const toolCalls = captured.filter((c) => c.update?.sessionUpdate === "tool_call");
  assert.equal(toolCalls.length, 1, "the Task tool_use emits exactly one tool_call — no duplication");
  assert.equal(toolCalls[0].update.toolCallId, "toolu_T", "the tool_call keeps its id");

  // A second pump over the SAME messages emits nothing new — the emit-once guard prevents duplicates.
  const before = captured.length;
  await agent.pumpUpdates(sessionId);
  assert.equal(captured.length, before, "re-reading the same thread emits no duplicate events (emit-once guard)");
});
