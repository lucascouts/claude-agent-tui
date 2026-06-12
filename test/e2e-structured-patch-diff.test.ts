// Story 027 / Task 4.4 — E2E: file diffs render from the JSONL `toolUseResult.structuredPatch`
// (+ originalFile), NOT from `file-history-snapshot` (§12, R2.4). A fixture turn editing a file
// (structuredPatch) and a fixture Write (new file) are fed through the live read path
// (createSession → pumpUpdates → getSessionMessages re-read → diff-source → reused
// toolUpdateFromDiffToolResponse → session/update). Asserts:
//   - Edit → a {type:'diff'} block sourced from structuredPatch (+ originalFile).
//   - Write → a {type:'diff'} block with oldText:null (new-file body from `content`).
//
// 🧪 (story 021 open) RESOLVED in-product here: toolUpdateFromDiffToolResponse does NOT need a
// shim for the JSONL structuredPatch shape — story 021's diff-source normalises Edit (hunks) and
// Write (synthetic all-additions hunk) into the SAME reused translator input. No file-history is
// read: the diff is keyed entirely off the JSONL toolUseResult.
//
// node:test runner: `node --experimental-strip-types --test test/e2e-structured-patch-diff.test.ts` (build first).
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

const diffBlocks = (captured: any[]) =>
  captured.filter(
    (c) =>
      c.update?.sessionUpdate === "tool_call_update" &&
      Array.isArray(c.update?.content) &&
      c.update.content[0]?.type === "diff",
  );

test("an Edit renders a diff sourced from structuredPatch (+ originalFile), not file-history (§12)", async (t) => {
  const messages = [
    {
      uuid: "e1",
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_E", name: "Edit", input: { file_path: "/abs/x.ts", old_string: "const old = 2", new_string: "const neu = 2" } },
        ],
      },
    },
    {
      uuid: "e2",
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_E", content: "ok" }] },
      toolUseResult: {
        filePath: "/abs/x.ts",
        originalFile: "const a = 1\nconst old = 2\n",
        oldString: "const old = 2",
        newString: "const neu = 2",
        structuredPatch: [
          { oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [" const a = 1", "-const old = 2", "+const neu = 2"] },
        ],
      },
    },
  ];
  const { agent, captured } = makeAgent(messages);
  t.after(() => agent.dispose());
  const sessionId = await agent.createSession({ cwd: "/w", mcpServers: [] }).then((r: any) => r.sessionId);

  await agent.pumpUpdates(sessionId);

  const [diffUpdate] = diffBlocks(captured);
  assert.ok(diffUpdate, "an Edit emits a tool_call_update carrying a {type:'diff'} block");
  assert.equal(diffUpdate.update.toolCallId, "toolu_E", "the diff attaches to the open tool call (story 019 seam)");
  const diff = diffUpdate.update.content[0];
  assert.equal(diff.path, "/abs/x.ts");
  assert.equal(diff.oldText, "const a = 1\nconst old = 2", "oldText comes from the structuredPatch/originalFile, not file-history");
  assert.equal(diff.newText, "const a = 1\nconst neu = 2");
});

test("a Write (new file) renders a diff with oldText:null sourced from `content` (R2.4)", async (t) => {
  const body = "export const greeting = 'hi';\nexport const count = 3;";
  const messages = [
    {
      uuid: "w1",
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_W", name: "Write", input: { file_path: "/abs/new.ts", content: body } }],
      },
    },
    {
      uuid: "w2",
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_W", content: "ok" }] },
      toolUseResult: { filePath: "/abs/new.ts", content: body, structuredPatch: [] },
    },
  ];
  const { agent, captured } = makeAgent(messages);
  t.after(() => agent.dispose());
  const sessionId = await agent.createSession({ cwd: "/w", mcpServers: [] }).then((r: any) => r.sessionId);

  await agent.pumpUpdates(sessionId);

  const [diffUpdate] = diffBlocks(captured);
  assert.ok(diffUpdate, "a Write emits a {type:'diff'} block");
  const diff = diffUpdate.update.content[0];
  assert.equal(diff.path, "/abs/new.ts");
  assert.equal(diff.oldText, null, "a new file renders with oldText:null (literal null, the whole body added)");
  assert.equal(diff.newText, body, "newText is the new-file content");
});
