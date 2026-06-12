// Story 021 / Task 3.1 — render the mapped diff through the REUSED, unmodified
// `toolUpdateFromDiffToolResponse` (tools.ts §3), attached to the open `toolCallId` (story 019 seam),
// and pin the shim decision (doc §12 🧪).
//
// `diffToolCallUpdate(source, toolCallId)` assembles the §7 envelope
// `{sessionUpdate:'tool_call_update', toolCallId, content:[{type:'diff',path,oldText,newText}]}` by
// feeding `toDiffToolResponse(source)` to the reused translator. SHIM DECISION:
//   - Edit  → VERBATIM pass-through (shim: none) — the JSONL `structuredPatch` is fed unchanged and
//             the reused translator accepts it directly.
//   - Write → NORMALISED — its empty `structuredPatch` is NOT accepted verbatim (yields no content),
//             so the source shape is normalised to a synthetic all-additions hunk before the reused
//             translator (the thin shim lives in `toDiffToolResponse`, NOT in tools.ts).
// `tools.ts` is referenced UNMODIFIED either way.
//
// node:test runner: `node --experimental-strip-types --test test/diff-translate.test.ts`
// (run `npm run build` first — behavioural imports resolve against ../dist).
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyDiffSource, toDiffToolResponse, diffToolCallUpdate } from "../dist/diff-source.js";
import { toolUpdateFromDiffToolResponse } from "../dist/tools.js";

const editTUR = {
  filePath: "/abs/x.ts",
  originalFile: "const a = 1\nconst old = 2\n",
  oldString: "const old = 2",
  newString: "const neu = 2",
  structuredPatch: [
    { oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [" const a = 1", "-const old = 2", "+const neu = 2"] },
  ],
};
const writeTUR = {
  filePath: "/abs/new.ts",
  content: "export const greeting = 'hi';\nexport const count = 3;",
  structuredPatch: [],
};

test("Edit → tool_call_update {toolCallId, content:[{type:diff,...}]} via the reused translator", () => {
  const update = diffToolCallUpdate(classifyDiffSource("Edit", editTUR), "toolu_EDIT");
  assert.equal(update.sessionUpdate, "tool_call_update");
  assert.equal(update.toolCallId, "toolu_EDIT"); // attached to the OPEN tool call (story 019 seam)
  assert.equal(update.content.length, 1);
  assert.equal(update.content[0].type, "diff");
  assert.equal(update.content[0].path, "/abs/x.ts");
  assert.equal(update.content[0].oldText, "const a = 1\nconst old = 2");
  assert.equal(update.content[0].newText, "const a = 1\nconst neu = 2");
});

test("Write → tool_call_update with oldText:null sourced from content", () => {
  const update = diffToolCallUpdate(classifyDiffSource("Write", writeTUR), "toolu_WRITE");
  assert.equal(update.sessionUpdate, "tool_call_update");
  assert.equal(update.toolCallId, "toolu_WRITE");
  assert.equal(update.content[0].oldText, null);
  assert.equal(update.content[0].newText, writeTUR.content);
});

test("shim: Edit's JSONL structuredPatch is accepted by the reused translator VERBATIM (shim: none)", () => {
  const input = toDiffToolResponse(classifyDiffSource("Edit", editTUR));
  assert.deepEqual(input.structuredPatch, editTUR.structuredPatch); // no field renaming/nesting
  const { content } = toolUpdateFromDiffToolResponse(input);
  assert.equal(content[0].type, "diff"); // accepted directly
});

test("shim: a raw Write (empty structuredPatch) is NOT accepted verbatim → normalised to a synthetic hunk", () => {
  // Feeding the raw JSONL Write shape verbatim yields NO content — proving normalisation is required.
  const verbatim = toolUpdateFromDiffToolResponse({ filePath: writeTUR.filePath, structuredPatch: writeTUR.structuredPatch });
  assert.equal(verbatim.content, undefined);
  // The normalised source shape IS accepted and yields the new-file diff.
  const normalised = toDiffToolResponse(classifyDiffSource("Write", writeTUR));
  const { content } = toolUpdateFromDiffToolResponse(normalised);
  assert.equal(content[0].oldText, null);
  assert.equal(content[0].newText, writeTUR.content);
});

test("an unrenderable source (unsupported / not-a-diff-source) yields no tool_call_update", () => {
  assert.equal(diffToolCallUpdate({ kind: "not-a-diff-source" }, "toolu_X"), null);
});
