// Story 026 / R3 remediation (validate 2026-06-08): `session/load` MUST emit the structuredPatch diff
// on the REAL replay path (loadSession → replaySessionHistory), not only on the live tail pump.
//
// The validate of story 026 found R3 unmet on the real path: replaySessionHistory emitted the tool_call
// + a generic tool_result update but NEVER the `{type:'diff'}` content, because the diff-emission block
// lived ONLY in pumpUpdates (the live tail), which never fires on a replay-only load (watcher/engine
// undefined). The pre-existing "diff" tests were green only because they drove `pumpUpdates`, not the
// real `loadSession`. This test drives the REAL `loadSession` and asserts the diff — Edit (oldText from
// hunks) and Write (type:create ⇒ oldText:null), the story-021 mapping, so loaded == live (R3.1-R3.3).
//
// node:test: `node --experimental-strip-types --test test/load-replay-diff.test.ts` (build first).
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
  // Replay-only engine: locate-but-do-not-spawn — watcher/engine undefined, so the live pump never
  // fires. The ONLY emitter on this load is replaySessionHistory (exactly the real Degrau-1 load).
  const fakeStartEngine = (args: { sessionId?: string; cwd: string }) => ({
    sessionId: args.sessionId ?? "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    pty: { onExit: () => ({ dispose() {} }), onData: () => ({ dispose() {} }), resize() {}, write() {}, kill() {} } as never,
    watcher: undefined,
    engine: undefined,
    cwd: args.cwd,
  });
  const getMessages = async () => messages as never;
  const agent: any = new ClaudeAcpAgent(client, undefined, undefined, { startEngine: fakeStartEngine, getMessages });
  const diffs = () =>
    captured
      .filter(
        (c) =>
          c.update?.sessionUpdate === "tool_call_update" &&
          Array.isArray(c.update?.content) &&
          c.update.content[0]?.type === "diff",
      )
      .map((c) => c.update.content[0]);
  return { agent, captured, diffs };
}

const EDIT_THREAD = [
  { uuid: "e1", type: "user", message: { role: "user", content: [{ type: "text", text: "fix x.ts" }] } },
  {
    uuid: "e2",
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_E", name: "Edit", input: { file_path: "/abs/x.ts", old_string: "old", new_string: "neu" } }] },
  },
  {
    uuid: "e3",
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
];

const WRITE_THREAD = [
  { uuid: "w1", type: "user", message: { role: "user", content: [{ type: "text", text: "create f.txt" }] } },
  {
    uuid: "w2",
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_W", name: "Write", input: { file_path: "/abs/f.txt", content: "hello\n" } }] },
  },
  {
    uuid: "w3",
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_W", content: "ok" }] },
    // Real Write (type:create) toolUseResult shape (story 021 §12): the new-file body in `content`
    // with an EMPTY structuredPatch — the reused translator synthesises the all-additions hunk and
    // yields oldText:null. (Not a non-empty structuredPatch + originalFile, which is the Edit shape.)
    toolUseResult: {
      filePath: "/abs/f.txt",
      content: "hello\n",
      structuredPatch: [],
    },
  },
];

test("session/load emits the structuredPatch diff on the REAL loadSession path — Edit (R3.1/R3.3)", async (t) => {
  const { agent, diffs } = makeAgent(EDIT_THREAD);
  t.after(() => agent.dispose());

  await agent.loadSession({ sessionId: "11111111-1111-4111-8111-111111111111", cwd: "/proj", mcpServers: [] });

  const d = diffs();
  assert.equal(d.length, 1, "loadSession must emit exactly one diff for the replayed Edit (got none = the validate-026 gap)");
  assert.equal(d[0].path, "/abs/x.ts", "the Edit diff carries the file path");
  assert.ok(typeof d[0].oldText === "string" && d[0].oldText.includes("old"), "the Edit diff carries the old text (from the hunks)");
  assert.ok(typeof d[0].newText === "string" && d[0].newText.includes("neu"), "the Edit diff carries the new text");
});

test("session/load emits the structuredPatch diff on the REAL loadSession path — Write ⇒ oldText:null (R3.2)", async (t) => {
  const { agent, diffs } = makeAgent(WRITE_THREAD);
  t.after(() => agent.dispose());

  await agent.loadSession({ sessionId: "22222222-2222-4222-8222-222222222222", cwd: "/proj", mcpServers: [] });

  const d = diffs();
  assert.equal(d.length, 1, "loadSession must emit exactly one diff for the replayed Write");
  assert.equal(d[0].path, "/abs/f.txt", "the Write diff carries the file path");
  assert.equal(d[0].oldText, null, "a Write (new file, type:create) has oldText:null");
});
