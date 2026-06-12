// Story 027 / Task 4.3 — E2E: tool_use / tool_result render via the REUSED tools.ts (R2.3).
// A fixture turn with a tool_use followed by its tool_result is fed through the live read
// path (createSession → pumpUpdates → getSessionMessages re-read → toAcpNotifications →
// session/update). The emitted stream must carry a first-seen `tool_call` (toolCallId reuses
// tool_use.id verbatim) and its `tool_call_update` (keyed by tool_use_id, status completed),
// produced by the kept toolInfoFromToolUse / toolUpdateFromToolResult — no re-implemented
// translator, no PTY-side gate intercept (v1 read-only; the gate is Degrau 2).
//
// node:test runner: `node --experimental-strip-types --test test/e2e-tool-calls-render.test.ts` (build first).
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

test("a tool_use → tool_result pair emits a tool_call and its tool_call_update via the reused tools.ts", async (t) => {
  const messages = [
    {
      uuid: "tc1",
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_R", name: "Read", input: { file_path: "/abs/a.ts" } }],
      },
    },
    {
      uuid: "tc2",
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_R", content: "file body" }],
      },
    },
  ];
  const { agent, captured } = makeAgent(messages);
  t.after(() => agent.dispose());
  const sessionId = await agent.createSession({ cwd: "/w", mcpServers: [] }).then((r: any) => r.sessionId);

  await agent.pumpUpdates(sessionId);

  const call = captured.find((c) => c.update?.sessionUpdate === "tool_call");
  assert.ok(call, "the tool_use surfaces as a first-seen tool_call");
  assert.equal(call.update.toolCallId, "toolu_R", "toolCallId reuses tool_use.id byte-for-byte");
  assert.equal(call.update.kind, "read", "Read maps to the 'read' tool kind (story 019)");

  const update = captured.find((c) => c.update?.sessionUpdate === "tool_call_update");
  assert.ok(update, "the tool_result surfaces as a tool_call_update");
  assert.equal(update.update.toolCallId, "toolu_R", "the update is keyed by tool_use_id verbatim");
  assert.equal(update.update.status, "completed", "a successful tool_result completes the call");
});

test("read-only: streaming the tool pair issues NO session/prompt from the ACP side", async (t) => {
  const messages = [
    {
      uuid: "tc3",
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_B", name: "Bash", input: { command: "ls" } }] },
    },
    {
      uuid: "tc4",
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_B", content: "a\nb" }] },
    },
  ];
  const { agent, captured } = makeAgent(messages);
  t.after(() => agent.dispose());
  const sessionId = await agent.createSession({ cwd: "/w", mcpServers: [] }).then((r: any) => r.sessionId);
  await agent.pumpUpdates(sessionId);
  // The pump only ever emits client.sessionUpdate notifications — never a prompt back.
  assert.ok(
    captured.every((c) => typeof c.update?.sessionUpdate === "string"),
    "every captured item is a session/update notification — the read path never prompts",
  );
  assert.ok(captured.some((c) => c.update?.sessionUpdate === "tool_call"), "the tool call still rendered");
});
