// Story 021 / Task 2.2 — map an Edit (`type:update`) toolUseResult to an ACP diff content, rendered
// through the REUSED `toolUpdateFromDiffToolResponse` (tools.ts, kept intact — doc §3/§7).
//
// DECISION A (reuse-faithful, approved at run start): the reused translator builds oldText/newText
// from the structuredPatch `lines` (`-`/context → old, `+`/context → new) and IGNORES `originalFile`.
// So a diff's oldText is the HUNK-DERIVED pre-edit text (context + removed lines) — the SDK-identical
// shape — NOT the whole `originalFile` the R2.2 prose mentions. This is recorded in
// `.draft/deviations.yaml` (task 2.2). The module only assembles the source shape
// (`toDiffToolResponse`); it does NOT reimplement hunk assembly and does NOT modify tools.ts.
//
// node:test runner: `node --experimental-strip-types --test test/diff-edit-map.test.ts`
// (run `npm run build` first — behavioural imports resolve against ../dist).
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyDiffSource, toDiffToolResponse } from "../dist/diff-source.js";
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

test("an Edit maps, via the reused translator, to a diff with exact path and hunk-derived oldText/newText", () => {
  const source = classifyDiffSource("Edit", editTUR);
  assert.equal(source.kind, "edit");

  const input = toDiffToolResponse(source); // assembles {filePath, structuredPatch} for the reused fn
  const { content } = toolUpdateFromDiffToolResponse(input);

  assert.ok(Array.isArray(content));
  assert.equal(content.length, 1);
  assert.equal(content[0].type, "diff");
  assert.equal(content[0].path, "/abs/x.ts");
  // Decision A: oldText/newText come from the hunk lines (context + removed → old; context + added → new).
  assert.equal(content[0].oldText, "const a = 1\nconst old = 2");
  assert.equal(content[0].newText, "const a = 1\nconst neu = 2");
});

test("toDiffToolResponse feeds the structuredPatch through verbatim (path carried, hunks not split for one hunk)", () => {
  const input = toDiffToolResponse(classifyDiffSource("Edit", editTUR));
  assert.equal(input.filePath, "/abs/x.ts");
  assert.deepEqual(input.structuredPatch, editTUR.structuredPatch);
});
