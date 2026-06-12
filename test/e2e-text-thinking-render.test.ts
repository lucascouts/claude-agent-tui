// Story 027 / Task 4.2 — E2E: assistant `text` and `thinking` render via the REUSED
// translator (R2.2). A fixture turn carrying both a `thinking` and a `text` block is fed
// through the LIVE read path (createSession → pumpUpdates → getSessionMessages re-read →
// linearize → toAcpNotifications → session/update) and the emitted update stream is
// asserted to contain BOTH an agent_message_chunk (text) and an agent_thought_chunk
// (thinking sourced from the `thinking` field, NOT `text`). No translator is re-implemented:
// the pump drives the same toAcpNotifications the unit tests (stories 018) pin.
//
// node:test runner: `node --experimental-strip-types --test test/e2e-text-thinking-render.test.ts` (build first).
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
    sessionId: args.sessionId ?? "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    pty: { onExit: () => ({ dispose() {} }), onData: () => ({ dispose() {} }), resize() {}, write() {}, kill() {} } as never,
    watcher: { stop() {}, notifyEndOfTurn() {} },
    cwd: args.cwd,
  });
  const getMessages = async () => messages as never;
  const agent: any = new ClaudeAcpAgent(client, undefined, undefined, { startEngine: fakeStartEngine, getMessages });
  return { agent, captured };
}

test("a turn with thinking + text emits BOTH an agent_thought_chunk and an agent_message_chunk", async (t) => {
  const messages = [
    {
      uuid: "tt1",
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "let me reason about the request" },
          { type: "text", text: "Here is the answer." },
        ],
      },
    },
  ];
  const { agent, captured } = makeAgent(messages);
  t.after(() => agent.dispose());
  const sessionId = await agent.createSession({ cwd: "/w", mcpServers: [] }).then((r: any) => r.sessionId);

  await agent.pumpUpdates(sessionId);

  const thought = captured.find((c) => c.update?.sessionUpdate === "agent_thought_chunk");
  const message = captured.find((c) => c.update?.sessionUpdate === "agent_message_chunk");
  assert.ok(thought, "a thinking block surfaces as an agent_thought_chunk");
  assert.deepEqual(thought.update.content, { type: "text", text: "let me reason about the request" });
  assert.ok(message, "a text block surfaces as an agent_message_chunk");
  assert.deepEqual(message.update.content, { type: "text", text: "Here is the answer." });
});

test("thinking prose is sourced from the `thinking` field, not `text` (silent-drop guard, in-product)", async (t) => {
  const messages = [
    {
      uuid: "tt2",
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "real thought", text: "DECOY must not render" }],
      },
    },
  ];
  const { agent, captured } = makeAgent(messages);
  t.after(() => agent.dispose());
  const sessionId = await agent.createSession({ cwd: "/w", mcpServers: [] }).then((r: any) => r.sessionId);

  await agent.pumpUpdates(sessionId);

  const thought = captured.find((c) => c.update?.sessionUpdate === "agent_thought_chunk");
  assert.equal(thought.update.content.text, "real thought");
  assert.notEqual(thought.update.content.text, "DECOY must not render");
});
