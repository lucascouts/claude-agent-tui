// Story 023 / Group 3 (task 3.2) — the pump sources Edit/Write diffs from the JSONL `toolUseResult`
// (structuredPatch + originalFile) via story 021's diff-source, NOT the SDK PostToolUse hook (which
// is gone in the PTY path). An Edit tool_result emits a `tool_call_update` carrying a {type:'diff'}
// content block attached to the open tool call (story 019 seam), with the reused tools.ts translator.
// node:test runner: `node --experimental-strip-types --test test/pump-translate-diff.test.ts` (build first).
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

test("an Edit tool_result emits a tool_call_update with a {type:'diff'} block from structuredPatch", async (t) => {
  const messages = [
    // 1) the Edit tool_use — caches `toolu_E` → name "Edit" in the per-session toolUseCache.
    {
      uuid: "m1",
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_E",
            name: "Edit",
            input: { file_path: "/abs/x.ts", old_string: "const old = 2", new_string: "const neu = 2" },
          },
        ],
      },
    },
    // 2) the tool_result, carrying the JSONL `toolUseResult` (structuredPatch + originalFile).
    {
      uuid: "m2",
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_E", content: "ok" }],
      },
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

  const diffUpdate = captured.find(
    (c) => c.update?.sessionUpdate === "tool_call_update" && Array.isArray(c.update?.content) && c.update.content[0]?.type === "diff",
  );
  assert.ok(diffUpdate, "a tool_call_update carrying a {type:'diff'} block is emitted for the Edit");
  assert.equal(diffUpdate.update.toolCallId, "toolu_E", "the diff attaches to the OPEN tool call (story 019 seam)");
  const diff = diffUpdate.update.content[0];
  assert.equal(diff.path, "/abs/x.ts");
  assert.equal(diff.oldText, "const a = 1\nconst old = 2");
  assert.equal(diff.newText, "const a = 1\nconst neu = 2");
});
