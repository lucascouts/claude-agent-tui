// Story 023 / Group 5 (task 5.1) — end-to-end of the rewritten orchestration. A fake ACP client
// drives createSession (PTY engine + watcher spin up via the injected seam), then a recorded TUI-style
// multi-block JSONL turn (text / thinking / tool_use Edit / Edit-diff tool_result / text) is replayed
// through the pump. Asserts the captured stream is ORDERED (linear), DEDUPED (each uuid once), carries
// a {type:'diff'} block from structuredPatch, and references no SDK `query` symbol.
// (The Degrau-1 read-only assertion that session/prompt wrote NOTHING was retired by story 030,
//  which enables ACP-side input; the Degrau-2 submit/resolve contract lives in
//  test/prompt-submit-endofturn.test.ts.)
// node:test runner: `node --experimental-strip-types --test test/rewrite-e2e.test.ts` (build first).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ClaudeAcpAgent } from "../dist/acp-agent.js";

const here = dirname(fileURLToPath(import.meta.url));
const agentSrc = readFileSync(join(here, "..", "src", "acp-agent.ts"), "utf8");

// A recorded TUI-style turn: assistant text → thinking → Edit tool_use → Edit tool_result (+diff) → text.
const TURN = [
  { uuid: "t1", type: "assistant", entrypoint: "cli", message: { role: "assistant", content: [{ type: "text", text: "let me look" }] } },
  { uuid: "t2", type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: "reasoning…", signature: "sig" }] } },
  {
    uuid: "t3",
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_E", name: "Edit", input: { file_path: "/abs/x.ts", old_string: "old", new_string: "neu" } }],
    },
  },
  {
    uuid: "t4",
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_E", content: "ok" }] },
    toolUseResult: {
      filePath: "/abs/x.ts",
      originalFile: "const a = 1\nconst old = 2\n",
      structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [" const a = 1", "-const old = 2", "+const neu = 2"] }],
    },
  },
  { uuid: "t5", type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
];

function makeAgent(messages: unknown[]) {
  const captured: any[] = [];
  const ptyWrites: unknown[] = [];
  const client = {
    sessionUpdate: async (n: any) => {
      captured.push(n);
    },
    requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    readTextFile: async () => ({ content: "" }),
    writeTextFile: async () => ({}),
  } as never;
  const fakeStartEngine = (args: { sessionId?: string; cwd: string }) => ({
    sessionId: args.sessionId ?? "ffffffff-ffff-4fff-8fff-ffffffffffff",
    pty: {
      onExit: () => ({ dispose() {} }),
      onData: () => ({ dispose() {} }),
      resize() {},
      write: (d: unknown) => ptyWrites.push(d), // record any PTY injection
      kill() {},
    } as never,
    watcher: { stop() {}, notifyEndOfTurn() {} },
    cwd: args.cwd,
  });
  const getMessages = async () => messages as never;
  const agent: any = new ClaudeAcpAgent(client, undefined, undefined, { startEngine: fakeStartEngine, getMessages });
  return { agent, captured, ptyWrites };
}

test("createSession + a TUI-driven turn surfaces an ordered, deduped session/update stream to a fake ACP client", async (t) => {
  const { agent, captured } = makeAgent(TURN);
  t.after(() => agent.dispose());

  // createSession spins up the PTY engine + watcher via the injected seam.
  const { sessionId } = await agent.createSession({ cwd: "/work", mcpServers: [] });
  assert.ok(sessionId, "createSession returns a sessionId");

  // The mirrored TUI turn is ingested by the pump (the watcher's signal, simulated by a direct pump).
  await agent.pumpUpdates(sessionId);

  const kinds = captured.map((c) => c.update.sessionUpdate);
  // Ordered: text → thought → tool_call → (tool_call_update status + diff) → text.
  assert.deepEqual(
    [kinds[0], kinds[1], kinds[2], kinds[kinds.length - 1]],
    ["agent_message_chunk", "agent_thought_chunk", "tool_call", "agent_message_chunk"],
    "the stream is in linear turn order",
  );
  assert.equal(captured[0].update.content.text, "let me look");
  assert.equal(captured[captured.length - 1].update.content.text, "done");

  // A {type:'diff'} block sourced from structuredPatch (story 021) attached to the open Edit tool call.
  const diff = captured.find(
    (c) => c.update.sessionUpdate === "tool_call_update" && Array.isArray(c.update.content) && c.update.content[0]?.type === "diff",
  );
  assert.ok(diff, "an Edit diff is emitted from structuredPatch");
  assert.equal(diff.update.toolCallId, "toolu_E");
  assert.equal(diff.update.content[0].path, "/abs/x.ts");

  // Deduped: re-pumping the SAME transcript emits nothing new (idempotent re-parse, R3.4).
  const afterFirst = captured.length;
  await agent.pumpUpdates(sessionId);
  assert.equal(captured.length, afterFirst, "re-pumping the same transcript emits no duplicates");

  // No SDK `query` symbol is referenced on the rewritten engine path (comments may still NAME it).
  const codeOnly = agentSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.ok(!/\bsession\.query\b/.test(codeOnly), "no session.query reference survives in the engine");
});
