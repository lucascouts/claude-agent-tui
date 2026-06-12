// Story 021 / Task 4.2 — LOCK the canonical acceptance fixtures (doc §12, §7): an Edit-update hunk and
// a Write-create, asserting EXACT path / oldText / newText through the full
// classifyDiffSource → diffToolCallUpdate → reused `toolUpdateFromDiffToolResponse` path. These are
// the §12 "fixture tests for an Edit-update hunk and a Write-create, asserting exact oldText/newText/
// path" the Aceite requires. It is a REGRESSION LOCK over the runtime delivered by groups 2–3.
//
// Per Decision A (`.draft/deviations.yaml`): the reused translator derives oldText/newText from the
// hunk `lines` and IGNORES `originalFile`, so the Edit's oldText is the HUNK-DERIVED pre-edit text
// (context + removed lines), NOT the whole `originalFile`; the Write's oldText is literal `null` (D3).
//
// node:test runner: `node --experimental-strip-types --test test/diff-fixtures.test.ts`
// (run `npm run build` first — behavioural imports resolve against ../dist).
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyDiffSource, diffToolCallUpdate } from "../dist/diff-source.js";

// Canonical Edit-update fixture (doc §12 shape): one hunk with context + a removed + an added line.
const editUpdate = {
  filePath: "/abs/app.ts",
  originalFile: "import { run } from './run'\nconst port = 3000\nrun(port)\n",
  oldString: "const port = 3000",
  newString: "const port = 8080",
  structuredPatch: [
    {
      oldStart: 1,
      oldLines: 3,
      newStart: 1,
      newLines: 3,
      lines: [" import { run } from './run'", "-const port = 3000", "+const port = 8080", " run(port)"],
    },
  ],
};

// Canonical Write-create fixture (doc §12 shape): EMPTY structuredPatch + the new-file body in content.
const writeCreate = {
  filePath: "/abs/config.ts",
  content: "export const config = { debug: false };",
  structuredPatch: [],
};

test("LOCK Edit-update fixture → diff with exact path / hunk-derived oldText / newText", () => {
  const update = diffToolCallUpdate(classifyDiffSource("Edit", editUpdate), "toolu_lock_edit");
  assert.equal(update.sessionUpdate, "tool_call_update");
  assert.equal(update.toolCallId, "toolu_lock_edit");
  assert.equal(update.content.length, 1);
  const diff = update.content[0];
  assert.equal(diff.type, "diff");
  assert.equal(diff.path, "/abs/app.ts");
  // Decision A: oldText = context + removed lines; newText = context + added lines (originalFile ignored).
  assert.equal(diff.oldText, "import { run } from './run'\nconst port = 3000\nrun(port)");
  assert.equal(diff.newText, "import { run } from './run'\nconst port = 8080\nrun(port)");
});

test("LOCK Write-create fixture → diff with exact path / oldText:null / newText(=content)", () => {
  const update = diffToolCallUpdate(classifyDiffSource("Write", writeCreate), "toolu_lock_write");
  assert.equal(update.content.length, 1);
  const diff = update.content[0];
  assert.equal(diff.type, "diff");
  assert.equal(diff.path, "/abs/config.ts");
  assert.equal(diff.oldText, null); // literal null — the whole new file renders as added (D3)
  assert.equal(diff.newText, writeCreate.content);
});
