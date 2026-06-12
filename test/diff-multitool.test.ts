// Story 021 / Task 3.2 — cover-or-log MultiEdit / NotebookEdit / MCP patch shapes (doc §12; design D4;
// §6 tolerant default-ignore posture).
//
// Only Edit and Write are verified upstream. For the rest: where the `toolUseResult` shape is a
// RECOGNISED structuredPatch+originalFile form, map it like Edit; where the shape is UNVERIFIED,
// detect + LOG it (tool name + observed shape) for drift telemetry and SKIP emitting a diff — WITHOUT
// throwing and WITHOUT aborting the turn. Never assume a fixed tool set.
//
// node:test runner: `node --experimental-strip-types --test test/diff-multitool.test.ts`
// (run `npm run build` first — behavioural imports resolve against ../dist).
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyDiffSource, toDiffToolResponse, diffToolCallUpdate } from "../dist/diff-source.js";

// MultiEdit with a RECOGNISED Edit-shaped toolUseResult (structuredPatch + originalFile).
const multiEditTUR = {
  filePath: "/abs/multi.ts",
  originalFile: "a\nb\n",
  structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [" a", "-b", "+B"] }],
};

// NotebookEdit with an UNVERIFIED shape — no structuredPatch/content/originalFile to map from.
const notebookWeird = { filePath: "/abs/nb.ipynb", cells: [{ cell_type: "code" }], edit_mode: "replace" };

// An MCP-tool patch with an unrecognised shape.
const mcpWeird = { result: "patched", server: "fs" };

test("a MultiEdit with a recognised structuredPatch+originalFile shape maps to an edit diff", () => {
  const src = classifyDiffSource("MultiEdit", multiEditTUR);
  assert.equal(src.kind, "edit");
  const update = diffToolCallUpdate(src, "toolu_ME");
  assert.equal(update.sessionUpdate, "tool_call_update");
  assert.equal(update.content[0].type, "diff");
  assert.equal(update.content[0].path, "/abs/multi.ts");
});

test("a NotebookEdit with an unverified shape is detected, logged, and skipped — no throw, no diff", () => {
  let threw = false;
  let r;
  try {
    r = classifyDiffSource("NotebookEdit", notebookWeird);
  } catch {
    threw = true;
  }
  assert.equal(threw, false); // never throws on an unknown shape
  assert.equal(r.kind, "unsupported"); // recognised as a diff-bearing tool, but shape unverified → logged
  assert.equal(toDiffToolResponse(r), null); // no diff is emitted
});

test("an MCP-tool patch with an unrecognised shape is logged-and-skipped, not thrown", () => {
  const r = classifyDiffSource("mcp__fs__apply_patch", mcpWeird);
  assert.notEqual(r.kind, "edit");
  assert.notEqual(r.kind, "write");
  assert.equal(toDiffToolResponse(r), null);
});

test("the turn continues after an unsupported shape — a subsequent valid Edit still classifies", () => {
  classifyDiffSource("NotebookEdit", notebookWeird); // unsupported, logged, skipped
  const next = classifyDiffSource("Edit", {
    filePath: "/abs/x.ts",
    originalFile: "a\n",
    structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [" a", "+b"] }],
  });
  assert.equal(next.kind, "edit"); // pipeline not aborted
});
