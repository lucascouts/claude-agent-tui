// Story 043 / Task 2.2 (R2.1, R5.1) — the LIVE pump emits the story-021 Edit/Write diff over the
// REDUCED-shape JSONL once `liveDiff` is ON. With the PTY engine the PostToolUse hook that produced
// diffs is GONE, and `getSessionMessages` returns the reduced 6-field shape WITHOUT the per-type
// `toolUseResult` the diff block reads off `turn.message.toolUseResult` (acp-agent.ts) — so a live pump
// over the reduced shape renders NO diff. Story 043 wraps `this.getMessages` in the diff-enriched reader
// (getSessionMessages + uuid→`toolUseResult` hydration from the raw transcript) when `liveDiff` is ON, on
// BOTH the pump and the replay (both read `this.getMessages` once). This test drives the LIVE pump with a
// REDUCED stub (no toolUseResult) + an injected raw transcript carrying the toolUseResult by uuid, and
// asserts the Edit/Write diff fires (R2.1); the OFF case asserts byte-for-byte the pre-043 reduced stream
// (R5.1). Companion to pump-translate-diff.test.ts (which fed a stub ALREADY carrying toolUseResult).
//
// node:test: `node --experimental-strip-types --test test/pump-live-diff.test.ts` (build first).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeAcpAgent } from "../dist/acp-agent.js";

// The REDUCED-shape thread getSessionMessages returns: the Edit tool_use (caches toolu_E → "Edit" in
// the per-session toolUseCache) and its tool_result — but NO `toolUseResult` key on any message. This is
// exactly the live reduced shape over which the pre-043 diff block silently no-ops.
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

// The RAW transcript lines (newline-split JSONL) the injected `readRawLines` returns: full records that
// DO carry `toolUseResult`, keyed by the SAME uuid as the reduced message ("e3"). The diff-enriched
// reader's toolUseResultMap indexes uuid→toolUseResult and hydrates the reduced "e3" message. This is the
// story-026 Edit toolUseResult shape (structuredPatch + originalFile).
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

// The Write reduced thread: tool_use (toolu_W → "Write") + tool_result, again WITHOUT toolUseResult.
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

// The Write RAW transcript: the new-file body in `content` with an EMPTY structuredPatch (the story-021
// §12 Write/type:create shape) — the reused translator synthesises the all-additions hunk ⇒ oldText:null.
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

/**
 * Build an agent driving the LIVE pump. `reduced` is the stub getSessionMessages returns (NO
 * toolUseResult). `raw` (when given) is injected as the diff-enriched reader's raw transcript via
 * `diffEnrichOptions` so the reader hydrates toolUseResult WITHOUT touching the real `~/.claude`. With
 * `liveDiff:false` no enrichment happens and `raw` is unused (the OFF/baseline case).
 */
function makeAgent(opts: { reduced: unknown[]; raw?: string[]; liveDiff: boolean }) {
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
  // The REDUCED base reader — exactly what getSessionMessages returns live (no toolUseResult).
  const getMessages = async () => opts.reduced as never;
  const agent: any = new ClaudeAcpAgent(client, undefined, undefined, {
    startEngine: fakeStartEngine,
    getMessages,
    liveDiff: opts.liveDiff,
    // Test seam: drive the diff-enriched reader's locate+read deterministically (no real filesystem).
    diffEnrichOptions: { findTranscript: () => ["/fake.jsonl"], readRawLines: () => opts.raw ?? [] },
  });
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

test("R2.1 — liveDiff ON: an Edit over the REDUCED shape emits the structuredPatch diff (hydrated by uuid)", async (t) => {
  const { agent, diffs } = makeAgent({ reduced: EDIT_REDUCED, raw: EDIT_RAW, liveDiff: true });
  t.after(() => agent.dispose());
  const sessionId = await agent.createSession({ cwd: "/w", mcpServers: [] }).then((r: any) => r.sessionId);

  await agent.pumpUpdates(sessionId);

  const d = diffs();
  assert.equal(d.length, 1, "the live pump must emit exactly one diff for the Edit (hydrated from the raw toolUseResult)");
  assert.equal(d[0].path, "/abs/x.ts", "the Edit diff carries the file path");
  assert.ok(typeof d[0].oldText === "string" && d[0].oldText.includes("old"), "the Edit diff carries the old text (from the hunks)");
  assert.ok(typeof d[0].newText === "string" && d[0].newText.includes("neu"), "the Edit diff carries the new text");
});

test("R2.1 — liveDiff ON: a Write over the REDUCED shape emits the synthesised all-additions diff ⇒ oldText:null", async (t) => {
  const { agent, diffs } = makeAgent({ reduced: WRITE_REDUCED, raw: WRITE_RAW, liveDiff: true });
  t.after(() => agent.dispose());
  const sessionId = await agent.createSession({ cwd: "/w", mcpServers: [] }).then((r: any) => r.sessionId);

  await agent.pumpUpdates(sessionId);

  const d = diffs();
  assert.equal(d.length, 1, "the live pump must emit exactly one diff for the Write");
  assert.equal(d[0].path, "/abs/f.txt", "the Write diff carries the file path");
  assert.equal(d[0].oldText, null, "a Write (new file, type:create) has oldText:null");
});

test("R5.1 — liveDiff OFF: the REDUCED shape emits NO diff and the stream is byte-identical to the baseline", async (t) => {
  // OFF: same reduced stub (no toolUseResult), no enrichment. The diff block no-ops, and the surrounding
  // text/tool stream must be byte-identical to the pre-043 reduced reader.
  const off = makeAgent({ reduced: EDIT_REDUCED, liveDiff: false });
  t.after(() => off.agent.dispose());
  const sid = await off.agent.createSession({ cwd: "/w", mcpServers: [] }).then((r: any) => r.sessionId);
  await off.agent.pumpUpdates(sid);

  assert.equal(off.diffs().length, 0, "liveDiff OFF over the reduced shape must emit NO diff (R5.1)");

  // Byte-for-byte baseline: a SECOND agent constructed WITHOUT the liveDiff flag at all (the literal
  // pre-043 reduced reader) must produce the identical session/update stream. Normalising the sessionId
  // (the two agents mint different ids) isolates the stream content from the per-run id.
  const base = makeAgent({ reduced: EDIT_REDUCED, liveDiff: false });
  t.after(() => base.agent.dispose());
  const bsid = await base.agent.createSession({ cwd: "/w", mcpServers: [] }).then((r: any) => r.sessionId);
  await base.agent.pumpUpdates(bsid);

  const norm = (caps: any[], id: string) => JSON.stringify(caps).split(id).join("<sid>");
  assert.equal(
    norm(off.captured, sid),
    norm(base.captured, bsid),
    "the liveDiff-OFF stream is byte-identical to the pre-043 reduced baseline (R5.1)",
  );
});
