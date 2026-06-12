// Story 016 / Task 1.3 — normalise message.content as an ARRAY or a raw STRING in every branch.
//
// Before any branch inspects content blocks, `message.content` is normalised to an array of
// blocks REGARDLESS of whether the JSONL carried an array or a raw string (§6): an array passes
// through unchanged; a raw string is wrapped as a single `{type:'text',text:<string>}` block so
// the downstream §7 translators (story 018) always see a uniform array and a `.map`/index over
// content never throws on the string form. The original event is never mutated.
//
// node:test runner: `node --experimental-strip-types --test test/event-content-shape.test.ts`
// (run `npm run build` first — the behavioral import resolves against ../dist).
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyEvent } from "../dist/event-switch.js";

test("content: a raw STRING message.content becomes a single text block", () => {
  const c: any = classifyEvent({
    uuid: "s1",
    type: "assistant",
    userType: "external",
    message: { role: "assistant", content: "plain body" },
  } as any);
  assert.deepEqual(c.content, [{ type: "text", text: "plain body" }]);
});

test("content: an ARRAY message.content passes through unchanged (same length + order)", () => {
  const blocks = [
    { type: "text", text: "a" },
    { type: "thinking", thinking: "b" },
    { type: "text", text: "c" },
  ];
  const c: any = classifyEvent({
    uuid: "a1",
    type: "assistant",
    userType: "external",
    message: { content: blocks },
  } as any);
  assert.equal(c.content.length, 3);
  assert.deepEqual(c.content, blocks);
});

test("content: the user content arm also normalises a raw string (both content branches)", () => {
  const c: any = classifyEvent({
    uuid: "u1",
    type: "user",
    userType: "external",
    message: { content: "hi there" },
  } as any);
  assert.deepEqual(c.content, [{ type: "text", text: "hi there" }]);
});

test("content: a content-reading branch over the STRING form does not throw", () => {
  assert.doesNotThrow(() => {
    const c: any = classifyEvent({
      uuid: "s2",
      type: "user",
      userType: "external",
      message: { content: "x" },
    } as any);
    // Downstream §7 translators .map over content — it must be a real array, never the raw string.
    const types = c.content.map((b: any) => b.type);
    assert.deepEqual(types, ["text"]);
  });
});

test("content: normalisation does NOT mutate the input event's message.content", () => {
  const blocks = [{ type: "text", text: "keep" }];
  const input = { uuid: "m1", type: "assistant", userType: "external", message: { content: blocks } };
  const before = JSON.stringify(input);
  classifyEvent(input as any);
  assert.equal(JSON.stringify(input), before, "the input event must be untouched");
});

test("content: absent or non-string/non-array content yields an empty array (no throw)", () => {
  // message present but no `content` field
  const c1: any = classifyEvent({
    uuid: "e1",
    type: "assistant",
    userType: "external",
    message: {},
  } as any);
  assert.deepEqual(c1.content, []);
  // message absent entirely
  const c2: any = classifyEvent({ uuid: "e2", type: "user", userType: "external" } as any);
  assert.deepEqual(c2.content, []);
});
