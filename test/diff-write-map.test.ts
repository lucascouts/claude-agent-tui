// Story 021 / Task 2.3 — map a Write (`type:create`) toolUseResult to an ACP diff with oldText:null,
// sourced from `content` (doc §12; design D3), rendered through the REUSED
// `toolUpdateFromDiffToolResponse` (tools.ts kept intact — §3).
//
// A Write has an EMPTY structuredPatch and the new-file body in `content`, so the reused translator
// (which reads only structuredPatch) would emit nothing for it. DECISION A: the module normalises the
// Write into a synthetic all-additions hunk so the SAME reused function yields oldText:null (no
// `-`/context lines) and newText=content — reusing it for Write too (`.draft/deviations.yaml` 2.3).
// `oldText` MUST be literal `null` (not `""`) so the client renders the whole file as added (D3).
//
// node:test runner: `node --experimental-strip-types --test test/diff-write-map.test.ts`
// (run `npm run build` first — behavioural imports resolve against ../dist).
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyDiffSource, toDiffToolResponse } from "../dist/diff-source.js";
import { toolUpdateFromDiffToolResponse } from "../dist/tools.js";

const writeTUR = {
  filePath: "/abs/new.ts",
  content: "export const greeting = 'hi';\nexport const count = 3;",
  structuredPatch: [],
};

// A Write whose `content` is absent — an empty structuredPatch with nothing to render.
const writeNoContent = { filePath: "/abs/z.ts", structuredPatch: [] };

test("a Write (new file) maps to a diff with oldText:null sourced from content", () => {
  const source = classifyDiffSource("Write", writeTUR);
  assert.equal(source.kind, "write");

  const input = toDiffToolResponse(source);
  const { content } = toolUpdateFromDiffToolResponse(input);

  assert.ok(Array.isArray(content));
  assert.equal(content.length, 1);
  assert.equal(content[0].type, "diff");
  assert.equal(content[0].path, "/abs/new.ts");
  assert.equal(content[0].oldText, null); // literal null — NOT "" — so the whole file renders as added
  assert.equal(content[0].newText, writeTUR.content);
});

test("a Write with empty structuredPatch and absent content is skipped-and-logged (no diff emitted)", () => {
  const r = classifyDiffSource("Write", writeNoContent);
  assert.notEqual(r.kind, "write");
  assert.equal(r.kind, "unsupported");
  // Nothing to feed the reused translator — the source shape is null.
  assert.equal(toDiffToolResponse(r), null);
});
