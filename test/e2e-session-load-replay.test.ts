// Story 027 / Task 5.1 — E2E: session/load reopens a prior thread and replays it in full,
// chronological order (R3.1).
//
// Reopening a prior session replays the FULL thread (text / thinking / tools / diffs) into the
// panel through the REUSED replay path (replaySessionHistory + getSessionMessages, §4/§11) — no
// custom parser, the §6 REUSE-live decision. This exercises the replay/translator path via the
// injectable pump point (the story-025 load-burst precedent: replaySessionHistory and the pump
// share toAcpNotifications; the SDK getSessionMessages used by the real session/load is not
// injectable, so the live session/load + panel render is the manual acceptance step). Asserts the
// emitted session/update stream reproduces every turn in chronological order with no drop.
//
// node:test runner: `node --experimental-strip-types --test test/e2e-session-load-replay.test.ts` (build first).
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

// A prior thread mixing every read-only content kind: user prompt, thinking, text, a tool
// round-trip with an Edit diff, a re-prompt, and a final answer.
const PRIOR_THREAD = [
  { uuid: "p1", type: "user", message: { role: "user", content: [{ type: "text", text: "fix the bug in x.ts" }] } },
  { uuid: "p2", type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: "inspecting x.ts" }] } },
  { uuid: "p3", type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "I'll edit x.ts." }] } },
  {
    uuid: "p4",
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_E", name: "Edit", input: { file_path: "/abs/x.ts", old_string: "old", new_string: "neu" } }] },
  },
  {
    uuid: "p5",
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_E", content: "ok" }] },
    toolUseResult: {
      filePath: "/abs/x.ts",
      originalFile: "const a = 1\nold\n",
      oldString: "old",
      newString: "neu",
      structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [" const a = 1", "-old", "+neu"] }],
    },
  },
  { uuid: "p6", type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Done." }] } },
];

test("session/load replays the full prior thread in chronological order via the reused path (R3.1)", async (t) => {
  const { agent, captured } = makeAgent(PRIOR_THREAD);
  t.after(() => agent.dispose());
  const sessionId = await agent.createSession({ cwd: "/proj", mcpServers: [] }).then((r: any) => r.sessionId);

  await agent.pumpUpdates(sessionId);

  const kinds = captured.map((c) => c.update?.sessionUpdate);
  // Every content kind of the prior thread is reproduced.
  assert.ok(kinds.includes("user_message_chunk"), "the prior user prompt replays");
  assert.ok(kinds.includes("agent_thought_chunk"), "the prior thinking replays");
  assert.ok(kinds.includes("agent_message_chunk"), "the prior assistant text replays");
  assert.ok(kinds.includes("tool_call"), "the prior tool call replays");
  assert.ok(kinds.includes("tool_call_update"), "the prior tool result/diff replays");

  // Chronological order: the first user prompt precedes the thinking, which precedes the final answer.
  const texts = captured.filter((c) => c.update?.content?.type === "text").map((c) => c.update.content.text);
  assert.deepEqual(
    texts,
    ["fix the bug in x.ts", "inspecting x.ts", "I'll edit x.ts.", "Done."],
    "text/thinking turns replay in chronological order, no drop or reorder",
  );
});

test("session/load replay carries the structuredPatch diff (full thread, §12)", async (t) => {
  const { agent, captured } = makeAgent(PRIOR_THREAD);
  t.after(() => agent.dispose());
  const sessionId = await agent.createSession({ cwd: "/proj", mcpServers: [] }).then((r: any) => r.sessionId);

  await agent.pumpUpdates(sessionId);

  const diff = captured.find(
    (c) => c.update?.sessionUpdate === "tool_call_update" && Array.isArray(c.update?.content) && c.update.content[0]?.type === "diff",
  );
  assert.ok(diff, "the reopened thread re-renders the Edit diff from structuredPatch");
  assert.equal(diff.update.content[0].path, "/abs/x.ts");
});
