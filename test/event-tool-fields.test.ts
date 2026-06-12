// Story 016 / Task 1.4 — model tool_use.caller and the tool_result.tool_reference sub-block.
//
// The §6 block shapes carry extras the §7 tool translator (story 019) must read:
//   tool_use    {type,id,name,input,caller}          ← `caller`
//   tool_result {type,tool_use_id,content,is_error?} ← `content` string OR array; `tool_reference` sub-block
// Story 016 owns the normalisation seam, so it MUST carry these through its normalised content
// (not silently drop them) and MUST NOT transform nested `tool_result.content` (story 019 expects
// the raw string OR array and passes it to the unmodified `toolUpdateFromToolResult`). This test
// pins that survival contract the way story 019 actually consumes it — selecting blocks by `.type`.
//
// node:test runner: `node --experimental-strip-types --test test/event-tool-fields.test.ts`
// (run `npm run build` first — the behavioral import resolves against ../dist).
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyEvent } from "../dist/event-switch.js";

/** The normalised content blocks story 016 hands to the §7 translators (stories 018/019). */
function blocksOf(event: unknown): any[] {
  return (classifyEvent(event as any) as any).content;
}

test("tool_use.caller survives 016 normalisation (story 019 reads it — never dropped)", () => {
  const blocks = blocksOf({
    uuid: "t1",
    type: "assistant",
    userType: "external",
    message: { content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file: "x" }, caller: "agent" }] },
  });
  const tu = blocks.find((b) => b.type === "tool_use");
  assert.ok(tu, "the tool_use block must survive in the normalised content");
  assert.equal(tu.caller, "agent", "tool_use.caller must be preserved");
  assert.equal(tu.id, "toolu_1");
  assert.equal(tu.name, "Read");
  assert.deepEqual(tu.input, { file: "x" });
});

test("tool_result.tool_reference sub-block (inside array content) survives normalisation", () => {
  const blocks = blocksOf({
    uuid: "t2",
    type: "user",
    userType: "external",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_1",
          is_error: false,
          content: [
            { type: "text", text: "ok" },
            { type: "tool_reference", name: "ref-x" },
          ],
        },
      ],
    },
  });
  const tr = blocks.find((b) => b.type === "tool_result");
  assert.ok(tr, "the tool_result block must survive");
  assert.ok(Array.isArray(tr.content), "array tool_result.content is preserved as an array");
  const ref = tr.content.find((b: any) => b.type === "tool_reference");
  assert.ok(ref, "the tool_reference sub-block must survive inside the array content");
  assert.equal(ref.name, "ref-x");
});

test("tool_result.content as a raw STRING is preserved (not transformed — story 019 expects both forms)", () => {
  const blocks = blocksOf({
    uuid: "t3",
    type: "user",
    userType: "external",
    message: { content: [{ type: "tool_result", tool_use_id: "toolu_2", content: "plain result text" }] },
  });
  const tr = blocks.find((b) => b.type === "tool_result");
  assert.ok(tr);
  // 016 must NOT wrap/transform nested tool_result.content — story 019 reads the raw string OR array.
  assert.equal(tr.content, "plain result text");
});

test("absent caller / tool_reference is the normal optional case — no drift, no throw", () => {
  const drift: any[] = [];
  assert.doesNotThrow(() => {
    const a = blocksOf2(
      { uuid: "t4", type: "assistant", userType: "external", message: { content: [{ type: "tool_use", id: "toolu_3", name: "Bash", input: {} }] } },
      drift,
    );
    const u = blocksOf2(
      { uuid: "t5", type: "user", userType: "external", message: { content: [{ type: "tool_result", tool_use_id: "toolu_3", content: "done" }] } },
      drift,
    );
    assert.equal(a.find((b) => b.type === "tool_use").caller, undefined, "absent caller is optional");
    assert.equal(u.find((b) => b.type === "tool_result").tool_reference, undefined, "absent tool_reference is optional");
  });
  assert.equal(drift.length, 0, "missing optional block fields must not be drift");
});

/** Like blocksOf but threads an onDrift sink so the optional-field case can assert no drift. */
function blocksOf2(event: unknown, drift: any[]): any[] {
  return (classifyEvent(event as any, { onDrift: (r) => drift.push(r) }) as any).content;
}
