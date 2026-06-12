// Story 023 / Group 2 (task 2.2) — the tail-driven update pump. On each watcher signal it re-reads
// getSessionMessages LIVE (E5 REUSE-live, billing-free) and emits each message's ACP notification;
// every emitted update is traceable to a JSONL message — there is NO SDK message stream.
// node:test runner: `node --experimental-strip-types --test test/pump-tail-source.test.ts`
// (run `npm run build` first — behavioral imports resolve against ../dist).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeAcpAgent } from "../dist/acp-agent.js";

/** Build an agent whose pump reads the given fixture messages, capturing every sessionUpdate. */
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
    sessionId: args.sessionId ?? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
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

async function freshSession(agent: any): Promise<string> {
  const r = await agent.createSession({ cwd: "/work", mcpServers: [] });
  return r.sessionId;
}

test("pump re-reads the tail and emits one notification per text message, traceable to the JSONL", async (t) => {
  const messages = [
    {
      uuid: "u1",
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
    },
    {
      uuid: "u2",
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "hi back" }] },
    },
  ];
  const { agent, captured } = makeAgent(messages);
  t.after(() => agent.dispose());
  const sessionId = await freshSession(agent);

  await agent.pumpUpdates(sessionId);

  assert.equal(captured.length, 2, "exactly one chunk per text message (no SDK stream, no token split)");
  assert.equal(captured[0].update.sessionUpdate, "agent_message_chunk");
  assert.deepEqual(captured[0].update.content, { type: "text", text: "hello" });
  assert.equal(captured[1].update.sessionUpdate, "user_message_chunk");
  assert.deepEqual(captured[1].update.content, { type: "text", text: "hi back" });
});

test("pump emits only after it is invoked (the signal drives the read; nothing pre-fires)", async (t) => {
  const messages = [
    { uuid: "x1", type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "later" }] } },
  ];
  const { agent, captured } = makeAgent(messages);
  t.after(() => agent.dispose());
  const sessionId = await freshSession(agent);

  assert.equal(captured.length, 0, "no update is emitted before the pump runs");
  await agent.pumpUpdates(sessionId);
  assert.equal(captured.length, 1, "the update appears only after the pump re-reads the tail");
});
