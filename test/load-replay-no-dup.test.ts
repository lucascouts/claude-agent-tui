// Story 027 live-acceptance regression: session/load must replay the prior thread EXACTLY ONCE.
//
// Caught in-Zed (2026-06-07): reopening a thread rendered every turn TWICE. Root cause — loadSession
// runs replaySessionHistory AND arms the live tail pump (via getOrCreateSession's resume engine).
// The resume engine's first JSONL touch fires pumpUpdates; because replay never seeded
// `session.emitted`, the pump re-emitted the whole history and the Agent Panel painted it twice.
// The offline e2e-session-load-replay test missed it because it drives pumpUpdates alone (one
// emitter) — only the real resume engine exposes the replay+pump double-emission.
//
// Contract: after replaySessionHistory emits the history, a subsequent tail pump over the SAME
// transcript must add NOTHING (the history is already emitted; only genuinely new post-load turns
// may stream).
//
// node:test: `node --experimental-strip-types --test test/load-replay-no-dup.test.ts` (build first).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeAcpAgent } from "../dist/acp-agent.js";

const RENDER_KINDS = new Set([
  "user_message_chunk",
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
]);

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
  // Fake engine: never launches a real `claude` PTY. The real resume engine arms a watcher that
  // fires onEvent (→ pumpUpdates) on the first JSONL touch; the test fires pumpUpdates explicitly
  // to model that, deterministically.
  const fakeStartEngine = (args: { sessionId?: string; cwd: string }) => ({
    sessionId: args.sessionId ?? "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    pty: { onExit: () => ({ dispose() {} }), onData: () => ({ dispose() {} }), resize() {}, write() {}, kill() {} } as never,
    watcher: { stop() {}, notifyEndOfTurn() {} },
    cwd: args.cwd,
  });
  const getMessages = async () => messages as never;
  const agent: any = new ClaudeAcpAgent(client, undefined, undefined, { startEngine: fakeStartEngine, getMessages });
  const renderCount = () => captured.filter((c) => RENDER_KINDS.has(c.update?.sessionUpdate)).length;
  return { agent, captured, renderCount };
}

// A prior thread mixing every read-only content kind: user prompt, thinking, text, a Write tool
// round-trip with a structuredPatch diff, and a final answer.
const PRIOR_THREAD = [
  { uuid: "p1", type: "user", message: { role: "user", content: [{ type: "text", text: "create degrau1.txt" }] } },
  { uuid: "p2", type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: "writing the file" }] } },
  {
    uuid: "p3",
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_W", name: "Write", input: { file_path: "/abs/degrau1.txt", content: "Degrau 1 render OK\n" } }] },
  },
  {
    uuid: "p4",
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_W", content: "ok" }] },
    toolUseResult: {
      filePath: "/abs/degrau1.txt",
      originalFile: null,
      structuredPatch: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ["+Degrau 1 render OK"] }],
    },
  },
  { uuid: "p5", type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Criei o arquivo degrau1.txt." }] } },
];

test("session/load replays the prior thread exactly once — a tail pump after replay re-emits nothing (027 regression)", async (t) => {
  const { agent, captured, renderCount } = makeAgent(PRIOR_THREAD);
  t.after(() => agent.dispose());

  // The real Zed path: session/load → replaySessionHistory emits the history AND getOrCreateSession
  // arms the resume engine whose first JSONL touch fires the tail pump.
  await agent.loadSession({ sessionId: "11111111-1111-4111-8111-111111111111", cwd: "/proj", mcpServers: [] });

  const afterReplay = renderCount();
  assert.ok(afterReplay >= 5, `loadSession must replay the full prior thread (got ${afterReplay} render updates)`);

  // Simulate the resume engine touching the transcript → the live tail pump fires.
  await agent.pumpUpdates("11111111-1111-4111-8111-111111111111");

  assert.equal(
    renderCount(),
    afterReplay,
    `a tail pump after replay must NOT re-emit the already-replayed history; ` +
      `replay emitted ${afterReplay} render updates, the pump added ${renderCount() - afterReplay} (duplication)`,
  );

  // No rendered text/thinking turn is duplicated.
  const texts = captured
    .filter((c) => c.update?.content?.type === "text")
    .map((c) => c.update.content.text);
  assert.deepEqual([...new Set(texts)], texts, `no text turn is rendered twice (got: ${JSON.stringify(texts)})`);
});
