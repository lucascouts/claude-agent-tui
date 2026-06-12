// Story 043 / Task 3.1 (R3.1) — REGRESSION GUARD: the `session/load` replay renders the Edit/Write
// live diff IDENTICALLY to the live tail pump for the SAME enriched corpus. With `liveDiff` ON,
// `this.getMessages` is wrapped ONCE in the diff-enriched reader (acp-agent.ts:884), and BOTH the live
// pump (pumpUpdates → readOrderedMessages → emitLinearizedWithNested) and the replay
// (replaySessionHistory → readOrderedMessages → emitLinearizedWithNested) read that SAME reader through
// the SAME shared emit loop. So loaded == live holds BY CONSTRUCTION (the story-026 lesson: factoring the
// single emit loop is what guarantees no replay-vs-live divergence). This test pins that parity: it drives
// the SAME reduced-shape stub + injected raw transcript (the toolUseResult hydrated by uuid, exactly as
// pump-live-diff.test.ts) through BOTH paths and asserts the emitted diff `tool_call_update`s are EQUAL
// (same toolCallId + same content). Fresh sessions per path so the per-session `emitted` dedupe does not
// cross-suppress. This is an EXPECTED unexpected-green: the parity already holds, the test locks it down.
//
// node:test: `node --experimental-strip-types --test test/load-replay-diff-live.test.ts` (build first).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeAcpAgent } from "../dist/acp-agent.js";

// === The SAME enriched corpus pump-live-diff.test.ts uses: a REDUCED-shape thread (NO toolUseResult on
// any message — exactly what getSessionMessages returns live) PLUS a RAW transcript that DOES carry the
// per-type toolUseResult keyed by the SAME uuid, injected into the diff-enriched reader. ===

// Edit: reduced tool_use + tool_result, no toolUseResult.
const EDIT_REDUCED = [
  {
    uuid: "e2",
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "tool_use", id: "toolu_E", name: "Edit", input: { file_path: "/abs/x.ts", old_string: "old", new_string: "neu" } },
      ],
    },
  },
  {
    uuid: "e3",
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_E", content: "ok" }] },
  },
];

// Edit RAW transcript (newline-split JSONL): full records carrying toolUseResult by the SAME uuid ("e3").
// Story-026 Edit shape (structuredPatch + originalFile) ⇒ oldText from the hunks.
const EDIT_RAW = [
  JSON.stringify({ uuid: "e1", type: "user", message: { role: "user", content: [{ type: "text", text: "fix x.ts" }] } }),
  JSON.stringify({ uuid: "e2", type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_E", name: "Edit", input: { file_path: "/abs/x.ts", old_string: "old", new_string: "neu" } }] } }),
  JSON.stringify({
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
  }),
  "", // trailing newline split — the reader must skip it
];

// Write: reduced tool_use + tool_result, no toolUseResult.
const WRITE_REDUCED = [
  {
    uuid: "w2",
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_W", name: "Write", input: { file_path: "/abs/f.txt", content: "hello\n" } }],
    },
  },
  {
    uuid: "w3",
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_W", content: "ok" }] },
  },
];

// Write RAW transcript: the new-file body in `content` with an EMPTY structuredPatch (story-021 §12
// type:create shape) — the reused translator synthesises the all-additions hunk ⇒ oldText:null.
const WRITE_RAW = [
  JSON.stringify({ uuid: "w2", type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_W", name: "Write", input: { file_path: "/abs/f.txt", content: "hello\n" } }] } }),
  JSON.stringify({
    uuid: "w3",
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_W", content: "ok" }] },
    toolUseResult: { filePath: "/abs/f.txt", content: "hello\n", structuredPatch: [] },
  }),
  "",
];

// Combined corpus: Edit turn then Write turn, so the parity is asserted across BOTH diff shapes in one
// emit sequence (Edit oldText-from-hunks AND Write oldText:null). The raw transcript carries both.
const BOTH_REDUCED = [...EDIT_REDUCED, ...WRITE_REDUCED];
const BOTH_RAW = [
  JSON.stringify({ uuid: "e1", type: "user", message: { role: "user", content: [{ type: "text", text: "fix x.ts" }] } }),
  JSON.stringify({ uuid: "e2", type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_E", name: "Edit", input: { file_path: "/abs/x.ts", old_string: "old", new_string: "neu" } }] } }),
  JSON.stringify({
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
  }),
  JSON.stringify({ uuid: "w2", type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_W", name: "Write", input: { file_path: "/abs/f.txt", content: "hello\n" } }] } }),
  JSON.stringify({
    uuid: "w3",
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_W", content: "ok" }] },
    toolUseResult: { filePath: "/abs/f.txt", content: "hello\n", structuredPatch: [] },
  }),
  "",
];

const sharedClient = (captured: any[]) =>
  ({
    sessionUpdate: async (n: any) => {
      captured.push(n);
    },
    requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    readTextFile: async () => ({ content: "" }),
    writeTextFile: async () => ({}),
  }) as never;

// Pull the diff-bearing tool_call_update payloads out of a capture buffer: { toolCallId, content }. This
// is the renderable surface a client (Zed) actually consumes — the parity assertion compares exactly this.
const diffUpdates = (captured: any[]) =>
  captured
    .filter(
      (c) =>
        c.update?.sessionUpdate === "tool_call_update" &&
        Array.isArray(c.update?.content) &&
        c.update.content[0]?.type === "diff",
    )
    .map((c) => ({ toolCallId: c.update.toolCallId, content: c.update.content }));

/**
 * LIVE PUMP agent — watcher PRESENT (the live tail fires). getSessionMessages returns the REDUCED stub;
 * the raw transcript is injected via `diffEnrichOptions` so the diff-enriched reader hydrates toolUseResult
 * by uuid WITHOUT touching the real `~/.claude`. Mirrors makeAgent in pump-live-diff.test.ts.
 */
function makeLiveAgent(opts: { reduced: unknown[]; raw: string[] }) {
  const captured: any[] = [];
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
  const getMessages = async () => opts.reduced as never;
  const agent: any = new ClaudeAcpAgent(sharedClient(captured), undefined, undefined, {
    startEngine: fakeStartEngine,
    getMessages,
    liveDiff: true,
    diffEnrichOptions: { findTranscript: () => ["/fake.jsonl"], readRawLines: () => opts.raw },
  });
  return { agent, captured };
}

/**
 * REPLAY-ONLY agent — watcher/engine UNDEFINED (the live pump never fires; the ONLY emitter is
 * replaySessionHistory, exactly the real Degrau-1 load). SAME reduced stub + SAME injected raw transcript
 * + SAME `liveDiff:true`, so the diff-enriched reader is wired identically. Mirrors makeAgent in
 * load-replay-diff.test.ts but with the liveDiff enrichment ON (the corpus is reduced-shape).
 */
function makeReplayAgent(opts: { reduced: unknown[]; raw: string[] }) {
  const captured: any[] = [];
  const fakeStartEngine = (args: { sessionId?: string; cwd: string }) => ({
    sessionId: args.sessionId ?? "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    pty: { onExit: () => ({ dispose() {} }), onData: () => ({ dispose() {} }), resize() {}, write() {}, kill() {} } as never,
    watcher: undefined,
    engine: undefined,
    cwd: args.cwd,
  });
  const getMessages = async () => opts.reduced as never;
  const agent: any = new ClaudeAcpAgent(sharedClient(captured), undefined, undefined, {
    startEngine: fakeStartEngine,
    getMessages,
    liveDiff: true,
    diffEnrichOptions: { findTranscript: () => ["/fake.jsonl"], readRawLines: () => opts.raw },
  });
  return { agent, captured };
}

test("R3.1 — session/load replay emits the SAME Edit+Write diffs as the live pump (parity regression guard)", async (t) => {
  // LIVE: fresh session, drive the tail pump (as pump-live-diff.test.ts).
  const live = makeLiveAgent({ reduced: BOTH_REDUCED, raw: BOTH_RAW });
  t.after(() => live.agent.dispose());
  const liveSid = await live.agent.createSession({ cwd: "/w", mcpServers: [] }).then((r: any) => r.sessionId);
  await live.agent.pumpUpdates(liveSid);
  const liveDiffs = diffUpdates(live.captured);

  // REPLAY: a SEPARATE, fresh agent+session, drive the real session/load → replaySessionHistory path (as
  // load-replay-diff.test.ts). Fresh session so the per-session `emitted` dedupe does not cross-suppress.
  const replay = makeReplayAgent({ reduced: BOTH_REDUCED, raw: BOTH_RAW });
  t.after(() => replay.agent.dispose());
  await replay.agent.loadSession({ sessionId: "11111111-1111-4111-8111-111111111111", cwd: "/proj", mcpServers: [] });
  const replayDiffs = diffUpdates(replay.captured);

  // Both paths must render the two diffs (Edit + Write) — guard against either path silently emitting none.
  assert.equal(liveDiffs.length, 2, "the live pump must emit both diffs (Edit + Write) over the enriched corpus");
  assert.equal(replayDiffs.length, 2, "the session/load replay must emit both diffs (Edit + Write) over the enriched corpus");

  // The PARITY assertion: the replay's diff tool_call_update sequence is DEEP-EQUAL to the live pump's —
  // same toolCallId AND same diff content, in the same order. This is what locks loaded == live (R3.1).
  assert.deepEqual(
    replayDiffs,
    liveDiffs,
    "the session/load replay diffs must be byte-for-byte EQUAL to the live pump diffs (toolCallId + content) — any inequality is a real replay-vs-live divergence",
  );

  // Spot-check the shapes are the expected story-021 mapping (and not two empties that trivially match):
  // Edit ⇒ oldText/newText from the hunks; Write ⇒ oldText:null.
  const editDiff = liveDiffs.find((u) => u.content[0].path === "/abs/x.ts");
  const writeDiff = liveDiffs.find((u) => u.content[0].path === "/abs/f.txt");
  assert.ok(editDiff, "an Edit diff for /abs/x.ts is present");
  assert.ok(writeDiff, "a Write diff for /abs/f.txt is present");
  assert.ok(
    typeof editDiff!.content[0].oldText === "string" && editDiff!.content[0].oldText.includes("old"),
    "the Edit diff carries the old text from the hunks",
  );
  assert.ok(
    typeof editDiff!.content[0].newText === "string" && editDiff!.content[0].newText.includes("neu"),
    "the Edit diff carries the new text",
  );
  assert.equal(writeDiff!.content[0].oldText, null, "the Write diff (type:create) has oldText:null");
});
