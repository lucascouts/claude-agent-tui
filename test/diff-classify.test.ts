// Story 021 / Task 2.1 — classify a `user` event's `toolUseResult` as an Edit / Write diff source
// (doc §12, §7 `toolUseResult.structuredPatch` row; design Core Algorithm step 2).
//
// The diff source is the `user` event's `toolUseResult`, NOT `file-history-snapshot` (Task 1). For an
// Edit (`type:update`) it carries {filePath, originalFile, oldString, newString, structuredPatch};
// for a Write (`type:create`) it carries {filePath, content} with an EMPTY structuredPatch. This test
// pins the classifier: an Edit is read into `edit`, a Write into `write`, and a malformed Edit
// (missing `originalFile`) is skipped-and-logged as `unsupported` — never emitted as a half-built
// edit (tolerant default, §6). No custom JSONL parser: the blocks arrive via the REUSE-live read path.
//
// node:test runner: `node --experimental-strip-types --test test/diff-classify.test.ts`
// (run `npm run build` first — the behavioural import resolves against ../dist).
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyDiffSource } from "../dist/diff-source.js";

// Edit (type:update) — full pre-edit `originalFile` + a single structuredPatch hunk (doc §12 shape).
const editTUR = {
  filePath: "/abs/x.ts",
  originalFile: "const a = 1\nconst old = 2\n",
  oldString: "const old = 2",
  newString: "const neu = 2",
  structuredPatch: [
    { oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [" const a = 1", "-const old = 2", "+const neu = 2"] },
  ],
};

// Write (type:create) — EMPTY structuredPatch + the new-file body in `content` (doc §12 shape).
const writeTUR = {
  filePath: "/abs/new.ts",
  content: "export const greeting = 'hi';\nexport const count = 3;",
  structuredPatch: [],
};

// Malformed Edit — has a structuredPatch but NO `originalFile`; cannot build a faithful diff source.
const editMissingOriginal = {
  filePath: "/abs/y.ts",
  oldString: "b",
  newString: "c",
  structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [" a", "-b", "+c"] }],
};

test("an Edit toolUseResult is classified `edit` with filePath/originalFile/structuredPatch read", () => {
  const r = classifyDiffSource("Edit", editTUR);
  assert.equal(r.kind, "edit");
  assert.equal(r.filePath, "/abs/x.ts");
  assert.equal(r.originalFile, editTUR.originalFile);
  assert.deepEqual(r.structuredPatch, editTUR.structuredPatch);
});

test("a Write toolUseResult (empty structuredPatch + content) is classified `write`", () => {
  const r = classifyDiffSource("Write", writeTUR);
  assert.equal(r.kind, "write");
  assert.equal(r.filePath, "/abs/new.ts");
  assert.equal(r.content, writeTUR.content);
});

test("a malformed Edit (missing originalFile) is skipped-and-logged as `unsupported`, not emitted as edit", () => {
  const r = classifyDiffSource("Edit", editMissingOriginal);
  assert.notEqual(r.kind, "edit"); // never a half-built edit with an undefined originalFile
  assert.equal(r.kind, "unsupported");
});
