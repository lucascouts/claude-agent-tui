// Story 023 / Group 3 (task 3.3) — the pump emits in linearized order, deduped by event `uuid` via
// the per-session `emitted` set. Re-reading the whole transcript each signal (E5 REUSE-live) must be
// idempotent: a prefix re-parse or a repeated read never re-emits an already-surfaced event (R3.4).
// node:test runner: `node --experimental-strip-types --test test/pump-dedupe.test.ts` (build first).
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
    sessionId: args.sessionId ?? "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
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

const txt = (uuid: string, role: string, text: string) => ({
  uuid,
  type: role,
  message: { role, content: [{ type: "text", text }] },
});

test("re-feeding the SAME transcript twice emits each uuid exactly once", async (t) => {
  const messages = [txt("u1", "assistant", "A"), txt("u2", "user", "B")];
  const { agent, captured } = makeAgent(messages);
  t.after(() => agent.dispose());
  const sessionId = await agent.createSession({ cwd: "/w", mcpServers: [] }).then((r: any) => r.sessionId);

  await agent.pumpUpdates(sessionId);
  const afterFirst = captured.length;
  await agent.pumpUpdates(sessionId); // identical re-read

  assert.equal(afterFirst, 2, "first pump emits both messages");
  assert.equal(captured.length, afterFirst, "the second pump over the same transcript emits NOTHING new");
});

test("a GROWING transcript (prefix re-parse) emits only the newly-appended uuid, in linear order", async (t) => {
  const messages = [txt("g1", "assistant", "first")];
  const { agent, captured } = makeAgent(messages);
  t.after(() => agent.dispose());
  const sessionId = await agent.createSession({ cwd: "/w", mcpServers: [] }).then((r: any) => r.sessionId);

  await agent.pumpUpdates(sessionId);
  assert.equal(captured.length, 1, "the first message is emitted");

  // Append a new message and re-read the FULL transcript (the monotonic E5 superset).
  messages.push(txt("g2", "user", "second"));
  await agent.pumpUpdates(sessionId);

  assert.equal(captured.length, 2, "only the newly-appended message is emitted (the prefix is deduped)");
  const texts = captured.map((c) => c.update.content?.text);
  assert.deepEqual(texts, ["first", "second"], "emission stays in linear order across re-reads");
});
