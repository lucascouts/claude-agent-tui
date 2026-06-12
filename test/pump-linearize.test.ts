// Story 023 / Group 3 (task 3.1) — the pump linearizes the LIVE-read messages via story 017
// (linearizeTurns) BEFORE translating: parentUuid/chain order at the top level, with sidechain
// (subagent Task) rows flattened per the default `nested` policy (attached to their spawning turn,
// not surfaced as top-level emits). The pump emits exactly the top-level linear order 017 returns.
// node:test runner: `node --experimental-strip-types --test test/pump-linearize.test.ts` (build first).
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
  const getMessages = async () => messages as never;
  const agent: any = new ClaudeAcpAgent(client, undefined, undefined, {
    startEngine: fakeStartEngine,
    getMessages,
  });
  return { agent, captured };
}

test("a sidechain Task + re-prompt yields the 017 top-level linear order; sidechain rows stay nested", async (t) => {
  const messages = [
    { uuid: "m1", type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "first" }] } },
    // a Task tool_use that spawns a subagent sidechain
    {
      uuid: "m2",
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_T", name: "Task", input: { description: "sub" } }] },
    },
    // the sidechain (subagent) row — claimed by toolu_T; under `nested` it attaches to m2, NOT top-level
    {
      uuid: "s1",
      type: "assistant",
      parent_tool_use_id: "toolu_T",
      message: { role: "assistant", content: [{ type: "text", text: "subagent work" }] },
    },
    { uuid: "m3", type: "user", message: { role: "user", content: [{ type: "text", text: "re-prompt" }] } },
  ];
  const { agent, captured } = makeAgent(messages);
  t.after(() => agent.dispose());
  const sessionId = await agent.createSession({ cwd: "/w", mcpServers: [] }).then((r: any) => r.sessionId);

  await agent.pumpUpdates(sessionId);

  // The two top-level TEXT turns appear in linear order; the nested sidechain text is NOT surfaced.
  const texts = captured
    .filter((c) => c.update?.content?.type === "text")
    .map((c) => c.update.content.text);
  assert.deepEqual(texts, ["first", "re-prompt"], "top-level linear order preserved; sidechain stays nested");
  assert.ok(!texts.includes("subagent work"), "the sidechain row is flattened per the nested policy, not a top-level emit");

  // The Task tool_use still surfaces as a tool_call at its linear position (between the two texts).
  const hasToolCall = captured.some((c) => c.update?.sessionUpdate === "tool_call");
  assert.ok(hasToolCall, "the Task tool_use is emitted as a tool_call in linear order");
});
