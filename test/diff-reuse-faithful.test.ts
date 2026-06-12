// Story 043 / Task 4.1 (R4.1) — REUSE-FAITHFUL GUARD: the diff the LIVE pump emits over the enriched
// reduced shape is BYTE-IDENTICAL to calling the story-021 diff API DIRECTLY. Story 043 only RESTORED the
// `toolUseResult` INPUT (via the diff-enriched reader, story-043 module); it did NOT re-implement diff
// classification or rendering — `classifyDiffSource` + `diffToolCallUpdate` (story 021, frozen) are reused
// UNCHANGED at acp-agent.ts:1499. This test pins exactly that: for an Edit and a Write fixture it computes
// the EXPECTED `tool_call_update` by invoking the story-021 API directly from ../dist/diff-source.js, then
// asserts the diff `update` the enriched pump path emits DEEP-EQUALS that expected value. A divergence here
// would mean the pump rendered through SOMETHING OTHER than the unchanged 021 classifier/renderer.
//
// Driving the pump mirrors pump-live-diff.test.ts: a REDUCED-shape stub (no toolUseResult) getSessionMessages
// returns, PLUS a RAW transcript carrying toolUseResult by the SAME uuid, injected via `diffEnrichOptions`
// so the diff-enriched reader hydrates WITHOUT touching the real `~/.claude`. The `toolUseResult` the 021 API
// is fed directly is the SAME object the raw transcript carries (the reader hydrates it onto the message
// verbatim, so feeding it directly reproduces exactly what the emit block at acp-agent.ts:1488 reads).
//
// EXPECTED unexpected-green: 043 already reuses the 021 API unchanged, so this guard passes on the first run —
// it LOCKS that reuse against future drift (it is NOT a tautology: the expected side is the real 021 API and
// the actual side is the real pump emission; they are computed by independent code paths).
//
// node:test: `node --experimental-strip-types --test test/diff-reuse-faithful.test.ts` (build first).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeAcpAgent } from "../dist/acp-agent.js";
// The story-021 API imported DIRECTLY (NOT via lib.ts — frozen surface) — the SAME functions acp-agent.ts
// calls at line 1499. The expected diff is computed by invoking these exactly as the emit block does.
import { classifyDiffSource, diffToolCallUpdate } from "../dist/diff-source.js";

// === Edit fixture — story-026 shape (structuredPatch + originalFile). Reduced thread has NO toolUseResult;
// the raw transcript carries it by the SAME uuid ("e3"). toolCallId is the tool_use id ("toolu_E"). ===

// The toolUseResult the raw transcript carries for "e3" — the SAME value the diff-enriched reader hydrates
// onto the reduced message, and the SAME value we feed the 021 API directly to compute the expectation.
const EDIT_TOOL_USE_RESULT = {
  filePath: "/abs/x.ts",
  originalFile: "const a = 1\nold\n",
  oldString: "old",
  newString: "neu",
  structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [" const a = 1", "-old", "+neu"] }],
};

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

const EDIT_RAW = [
  JSON.stringify({ uuid: "e1", type: "user", message: { role: "user", content: [{ type: "text", text: "fix x.ts" }] } }),
  JSON.stringify({ uuid: "e2", type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_E", name: "Edit", input: { file_path: "/abs/x.ts", old_string: "old", new_string: "neu" } }] } }),
  JSON.stringify({
    uuid: "e3",
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_E", content: "ok" }] },
    toolUseResult: EDIT_TOOL_USE_RESULT,
  }),
  "", // trailing newline split — the reader must skip it
];

// === Write fixture — story-021 §12 type:create shape (EMPTY structuredPatch + new-file content). The reused
// translator synthesises the all-additions hunk ⇒ oldText:null. toolCallId is "toolu_W". ===

const WRITE_TOOL_USE_RESULT = { filePath: "/abs/f.txt", content: "hello\n", structuredPatch: [] };

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

const WRITE_RAW = [
  JSON.stringify({ uuid: "w2", type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_W", name: "Write", input: { file_path: "/abs/f.txt", content: "hello\n" } }] } }),
  JSON.stringify({
    uuid: "w3",
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_W", content: "ok" }] },
    toolUseResult: WRITE_TOOL_USE_RESULT,
  }),
  "",
];

/**
 * Build an agent driving the LIVE pump (watcher present), mirroring makeAgent in pump-live-diff.test.ts:
 * a REDUCED-shape stub getSessionMessages returns + a RAW transcript injected via `diffEnrichOptions` so the
 * diff-enriched reader hydrates toolUseResult by uuid WITHOUT touching the real filesystem. `liveDiff:true`.
 */
function makeAgent(opts: { reduced: unknown[]; raw: string[] }) {
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
  const getMessages = async () => opts.reduced as never;
  const agent: any = new ClaudeAcpAgent(client, undefined, undefined, {
    startEngine: fakeStartEngine,
    getMessages,
    liveDiff: true,
    diffEnrichOptions: { findTranscript: () => ["/fake.jsonl"], readRawLines: () => opts.raw },
  });
  return { agent, captured };
}

// Pull the diff-bearing `tool_call_update` payloads (the `update` the emit block hands sessionUpdate) out of
// the capture buffer. This `update` IS the value `diffToolCallUpdate(...)` returned (acp-agent.ts wraps it as
// { sessionId, update }), so it is exactly what the direct 021 API call must deep-equal.
const diffUpdates = (captured: any[]) =>
  captured
    .filter(
      (c) =>
        c.update?.sessionUpdate === "tool_call_update" &&
        Array.isArray(c.update?.content) &&
        c.update.content[0]?.type === "diff",
    )
    .map((c) => c.update);

test("R4.1 — the enriched pump's Edit diff is byte-identical to calling the story-021 API directly", async (t) => {
  // EXPECTED, computed by invoking the story-021 API DIRECTLY exactly as acp-agent.ts:1499 does:
  // diffToolCallUpdate(classifyDiffSource(name, toolUseResult), toolCallId). name="Edit", toolCallId is the
  // tool_use id "toolu_E", toolUseResult is the SAME object the raw transcript carries for uuid "e3".
  const expected = diffToolCallUpdate(classifyDiffSource("Edit", EDIT_TOOL_USE_RESULT), "toolu_E");
  assert.ok(expected, "guard precondition: the story-021 API renders a diff for the Edit fixture");

  // ACTUAL: drive the live pump over the reduced shape + injected raw transcript and capture the emitted diff.
  const { agent, captured } = makeAgent({ reduced: EDIT_REDUCED, raw: EDIT_RAW });
  t.after(() => agent.dispose());
  const sessionId = await agent.createSession({ cwd: "/w", mcpServers: [] }).then((r: any) => r.sessionId);
  await agent.pumpUpdates(sessionId);

  const updates = diffUpdates(captured);
  assert.equal(updates.length, 1, "the enriched pump emits exactly one Edit diff tool_call_update");
  // The reuse-faithful proof: the emitted diff DEEP-EQUALS the direct story-021 API result. Independent code
  // paths (the pump's emit block vs. a direct API call) producing the identical value ⇒ the pump renders
  // through the UNCHANGED 021 classifier + renderer (043 only restored the input).
  assert.deepEqual(
    updates[0],
    expected,
    "the enriched pump's Edit diff must EQUAL diffToolCallUpdate(classifyDiffSource('Edit', toolUseResult), 'toolu_E') — proves 043 reuses the story-021 API unchanged",
  );
});

test("R4.1 — the enriched pump's Write diff (oldText:null synthesised hunk) equals the story-021 API directly", async (t) => {
  // EXPECTED via the SAME direct 021 API call — name="Write", toolCallId "toolu_W", the empty-structuredPatch
  // type:create shape ⇒ the reused translator synthesises the all-additions hunk ⇒ oldText:null.
  const expected = diffToolCallUpdate(classifyDiffSource("Write", WRITE_TOOL_USE_RESULT), "toolu_W");
  assert.ok(expected, "guard precondition: the story-021 API renders a diff for the Write fixture");
  // Spot-check the expected is the type:create shape (so the deep-equal below is not matching two empties).
  assert.equal(expected!.content[0].oldText, null, "the story-021 Write render has oldText:null (type:create)");

  const { agent, captured } = makeAgent({ reduced: WRITE_REDUCED, raw: WRITE_RAW });
  t.after(() => agent.dispose());
  const sessionId = await agent.createSession({ cwd: "/w", mcpServers: [] }).then((r: any) => r.sessionId);
  await agent.pumpUpdates(sessionId);

  const updates = diffUpdates(captured);
  assert.equal(updates.length, 1, "the enriched pump emits exactly one Write diff tool_call_update");
  assert.deepEqual(
    updates[0],
    expected,
    "the enriched pump's Write diff must EQUAL diffToolCallUpdate(classifyDiffSource('Write', toolUseResult), 'toolu_W') — proves 043 reuses the story-021 API unchanged",
  );
});
