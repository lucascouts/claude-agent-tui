import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeAcpAgent } from "../dist/acp-agent.js";

// Story 025 / Task 5.1 (R3.3, §13 R8) — when the usageUpdate flag is ON and the user's Zed
// REJECTS the UNSTABLE usage_update notification (an ACP client error = the R8 detection
// signal), the pump must: catch the rejection (never re-throw it into the turn loop), latch
// usage OFF for that session so no further usage_update is attempted, and keep the surrounding
// text/thinking/tool-call session/update stream flowing in order. Unit test over the pump with
// a stub Zed client that throws on usage_update and accepts everything else.

function makeRejectingAgent(messages: unknown[]) {
  const captured: any[] = [];
  const usageAttempts: any[] = [];
  const errors: any[] = [];
  const client = {
    sessionUpdate: async (n: any) => {
      if (n?.update?.sessionUpdate === "usage_update") {
        usageAttempts.push(n);
        throw new Error("Zed rejects UNSTABLE usage_update"); // R8 client rejection
      }
      captured.push(n);
    },
    requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    readTextFile: async () => ({ content: "" }),
    writeTextFile: async () => ({}),
  } as never;
  const logger = { log: () => {}, error: (...a: any[]) => errors.push(a.join(" ")) } as never;
  const fakeStartEngine = (args: { sessionId?: string; cwd: string }) => ({
    sessionId: args.sessionId ?? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    pty: { onExit: () => ({ dispose() {} }), onData: () => ({ dispose() {} }), resize() {}, write() {}, kill() {} } as never,
    watcher: { stop() {}, notifyEndOfTurn() {} },
    cwd: args.cwd,
  });
  const getMessages = async () => messages as never;
  // flag ON — opt into usage_update so the rejection path is exercised
  const agent: any = new ClaudeAcpAgent(client, logger, undefined, {
    startEngine: fakeStartEngine,
    getMessages,
    usageUpdate: true,
  });
  return { agent, captured, usageAttempts, errors };
}

async function freshSession(agent: any): Promise<string> {
  const r = await agent.createSession({ cwd: "/work", mcpServers: [] });
  return r.sessionId;
}

// two assistant turns, each carrying text + usage tokens (usage lives on the Anthropic message)
const messages = [
  {
    uuid: "a1",
    type: "assistant",
    entrypoint: "cli",
    message: { role: "assistant", content: [{ type: "text", text: "t1" }], usage: { input_tokens: 10, output_tokens: 5 } },
  },
  {
    uuid: "a2",
    type: "assistant",
    entrypoint: "cli",
    message: { role: "assistant", content: [{ type: "text", text: "t2" }], usage: { input_tokens: 20, output_tokens: 8 } },
  },
];

test("usage-reject: a client rejection is caught and never escapes the turn loop (R3.3)", async (t) => {
  const { agent } = makeRejectingAgent(messages);
  t.after(() => agent.dispose());
  const sessionId = await freshSession(agent);

  let threw = false;
  try {
    await agent.pumpUpdates(sessionId);
  } catch {
    threw = true;
  }
  assert.equal(threw, false, "the usage_update client rejection must not escape into the turn loop");
});

test("usage-reject: further usage_update is suppressed after the first rejection (latch, R3.3)", async (t) => {
  const { agent, usageAttempts } = makeRejectingAgent(messages);
  t.after(() => agent.dispose());
  const sessionId = await freshSession(agent);

  await agent.pumpUpdates(sessionId);
  assert.equal(usageAttempts.length, 1, "only the first usage_update is attempted; the latch suppresses the rest");
});

test("usage-reject: the surrounding text stream is delivered in order, unaffected (R3.3)", async (t) => {
  const { agent, captured, errors } = makeRejectingAgent(messages);
  t.after(() => agent.dispose());
  const sessionId = await freshSession(agent);

  await agent.pumpUpdates(sessionId);
  assert.deepEqual(
    captured.map((c) => c.update.sessionUpdate),
    ["agent_message_chunk", "agent_message_chunk"],
    "both text chunks still delivered despite the usage rejection",
  );
  assert.deepEqual(
    captured.map((c) => c.update.content.text),
    ["t1", "t2"],
    "text stream stays in order after the rejection",
  );
  assert.equal(errors.length, 1, "the rejection is logged exactly once for drift telemetry");
});
