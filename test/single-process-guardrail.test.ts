// Story 023 / Group 4 (task 4.1) — single-process host + §10 billing guard-rail (story 022). The PTY
// engine + watcher + pump live in ONE Node process per session (the tail is the single source of
// truth). On the first re-read batch the pump asserts the observed `entrypoint`: a credit/`sdk-*`
// entrypoint ABORTS the session (tears it down, emits nothing); a subscription `cli` entrypoint
// proceeds. The entrypoint is never rewritten (forcing it to 'cli' would be evasion, §10).
// node:test runner: `node --experimental-strip-types --test test/single-process-guardrail.test.ts`.
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
    sessionId: args.sessionId ?? "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
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

const ev = (uuid: string, entrypoint: string) => ({
  uuid,
  type: "assistant",
  entrypoint,
  message: { role: "assistant", content: [{ type: "text", text: "x" }] },
});

test("a first event with a credit `sdk-ts` entrypoint ABORTS the session — torn down, nothing emitted", async (t) => {
  const { agent, captured } = makeAgent([ev("e1", "sdk-ts")]);
  t.after(() => agent.dispose());
  const sessionId = await agent.createSession({ cwd: "/w", mcpServers: [] }).then((r: any) => r.sessionId);

  await agent.pumpUpdates(sessionId);

  assert.equal(captured.length, 0, "no update is emitted for a credit-billed session");
  assert.equal(agent.sessions[sessionId], undefined, "the session is torn down on the guard-rail trip");
});

test("a first event with a subscription `cli` entrypoint PROCEEDS — the turn streams normally", async (t) => {
  const { agent, captured } = makeAgent([ev("c1", "cli")]);
  t.after(() => agent.dispose());
  const sessionId = await agent.createSession({ cwd: "/w", mcpServers: [] }).then((r: any) => r.sessionId);

  await agent.pumpUpdates(sessionId);

  assert.equal(captured.length, 1, "the subscription turn streams its update");
  assert.ok(agent.sessions[sessionId], "the session stays alive on a subscription entrypoint");
});

test("good-faith: a reduced-shape batch with NO entrypoint is allowed (the env-sanitize is the primary guard)", async (t) => {
  const { agent, captured } = makeAgent([
    { uuid: "n1", type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
  ]);
  t.after(() => agent.dispose());
  const sessionId = await agent.createSession({ cwd: "/w", mcpServers: [] }).then((r: any) => r.sessionId);

  await agent.pumpUpdates(sessionId);

  assert.equal(captured.length, 1, "a missing entrypoint is not forced to abort (good-faith, §10)");
  assert.ok(agent.sessions[sessionId], "the session proceeds when the JSONL carries no entrypoint");
});
