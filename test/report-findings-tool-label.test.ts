// Story 074 / Task 3.1 (#826) — toolInfoFromToolUse renders the code-review
// `ReportFindings` tool as a think-kind tool info: title `Report N finding(s)`
// (proper pluralization; N is the finding count), one `file:line — summary` content
// block per finding, `line` omitted when the finding carries none, and the empty
// case titled `Report findings: none found`. Pure display translation from
// toolUse.input (ReportFindingsInput) — no elicitation/engine coupling (KEEP).
//
// Build first — imports resolve against ../dist:
//   node --experimental-strip-types --test test/report-findings-tool-label.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { toolInfoFromToolUse } from "../dist/lib.js";

function info(input: unknown): any {
  return toolInfoFromToolUse({ name: "ReportFindings", id: "tu-826", input } as any);
}

const texts = (i: any): string[] =>
  (i.content as any[]).map((c) => c?.content?.text).filter((t) => typeof t === "string");

test("3.1 N findings → think-kind, titled 'Report N findings', one file:line — summary block each", () => {
  const i = info({
    findings: [
      { file: "src/a.ts", line: 12, summary: "off-by-one in loop" },
      { file: "src/b.ts", line: 3, summary: "unchecked null" },
    ],
  });
  assert.equal(i.kind, "think", "ReportFindings renders as a think-kind tool info");
  assert.equal(i.title, "Report 2 findings", "title carries the finding count, pluralized");
  assert.deepEqual(texts(i), ["src/a.ts:12 — off-by-one in loop", "src/b.ts:3 — unchecked null"]);
});

test("3.1 a single finding pluralizes to 'finding' (singular)", () => {
  const i = info({ findings: [{ file: "src/c.ts", line: 1, summary: "typo" }] });
  assert.equal(i.title, "Report 1 finding");
  assert.deepEqual(texts(i), ["src/c.ts:1 — typo"]);
});

test("3.1 a finding without a line omits the ':line' segment", () => {
  const i = info({ findings: [{ file: "src/d.ts", summary: "missing test" }] });
  assert.equal(i.title, "Report 1 finding");
  assert.deepEqual(texts(i), ["src/d.ts — missing test"]);
});

test("3.2 empty findings → titled 'Report findings: none found', no content blocks", () => {
  const i = info({ findings: [] });
  assert.equal(i.kind, "think");
  assert.equal(i.title, "Report findings: none found");
  assert.deepEqual(i.content, []);
});

test("3.2 missing findings key is treated as none found", () => {
  const i = info({});
  assert.equal(i.title, "Report findings: none found");
  assert.deepEqual(i.content, []);
});
