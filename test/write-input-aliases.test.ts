// Port of upstream #1161 (90cde4b) — a Write `tool_use` that spells its fields with the aliases the
// CLI accepts since 2.1.280 (`path` for `file_path`, `file_text`/`file_content` for `content`) must
// render like the canonical spelling. The JSONL `tool_use` block keeps the model's raw spelling, so
// without a normaliser the call reaches Zed with no title path, no location and no diff — Zed shows
// "Preparing file…" while the write itself goes through.
//
// node:test runner: `npm run build` first (the behavioural import resolves against ../dist), then
//   node --experimental-strip-types --test test/write-input-aliases.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { toolInfoFromToolUse } from "../dist/lib.js";

const ALIASED_INPUTS: Array<[string, Record<string, unknown>]> = [
  ["path + file_text", { path: "/repo/a.ts", file_text: "x" }],
  ["path + file_content", { path: "/repo/a.ts", file_content: "x" }],
  ["file_path + file_text", { file_path: "/repo/a.ts", file_text: "x" }],
];

for (const [label, input] of ALIASED_INPUTS) {
  test(`Write with ${label} renders like file_path + content`, () => {
    const info = toolInfoFromToolUse(
      { name: "Write", id: "toolu_write_alias", input } as never,
      false,
      "/repo",
    );
    assert.equal(info.title, "Write a.ts");
    assert.deepEqual(info.locations, [{ path: "/repo/a.ts" }]);
    assert.deepEqual(info.content, [
      { type: "diff", path: "/repo/a.ts", oldText: null, newText: "x" },
    ]);
  });
}

test("Write prefers the canonical fields when both spellings are present", () => {
  const info = toolInfoFromToolUse(
    {
      name: "Write",
      id: "toolu_write_both",
      input: { file_path: "/repo/a.ts", path: "/repo/b.ts", content: "a", file_text: "b" },
    } as never,
    false,
    "/repo",
  );
  assert.equal(info.title, "Write a.ts");
  assert.deepEqual(info.content, [
    { type: "diff", path: "/repo/a.ts", oldText: null, newText: "a" },
  ]);
});
