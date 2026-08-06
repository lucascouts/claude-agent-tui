// Story 079 / Task 1.3 (R2) — an Agent/Task tool_result ends with a model-directed trailer that ACP
// clients shouldn't see: an `agentId: <id> (use SendMessage …)` continuation line and/or a
// `<usage>…</usage>` totals block. Both are stripped tail-anchored, so a format change stops the
// strip from matching instead of mangling the subagent's report.
//
// Ported from upstream #879 (v0.60.0), which replaced a regex sweep with this linear parse. Unit
// test over the translator directly (build first — imports resolve against ../dist):
//   node --experimental-strip-types --test test/agent-trailer-strip.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { toolUpdateFromToolResult } from "../dist/tools.js";

const render = (content: unknown, name = "Task"): string =>
  JSON.stringify(toolUpdateFromToolResult({ type: "tool_result", content } as any, { name }, false));

const REPORT = "The migration touches 3 files.";

test("R2: a trailing <usage> block is stripped", () => {
  const out = render(`${REPORT}\n<usage>input: 120\noutput: 40</usage>`);
  assert.match(out, /migration touches 3 files/);
  assert.doesNotMatch(out, /<usage>/, "the totals block must not reach the client");
});

test("R2: a trailing agentId continuation line is stripped", () => {
  const out = render(`${REPORT}\nagentId: agent-7f3a (use SendMessage to continue)`);
  assert.match(out, /migration touches 3 files/);
  assert.doesNotMatch(out, /agentId:/);
});

test("R2: both trailer forms are stripped together", () => {
  const out = render(
    `${REPORT}\nagentId: agent-7f3a (use SendMessage to continue)\n<usage>input: 120</usage>`,
  );
  assert.match(out, /migration touches 3 files/);
  assert.doesNotMatch(out, /agentId:/);
  assert.doesNotMatch(out, /<usage>/);
});

test("R2.1: a <usage> mention in the BODY is not a trailer — the report is not truncated at it", () => {
  const out = render(`I inspected the <usage> marker handling.\nAll good.`);
  assert.match(out, /inspected the/, "matching from the last <usage> must not eat the body");
  assert.match(out, /All good/);
});

test("R2.1: an agentId-shaped line that is NOT last is left alone", () => {
  const out = render(`agentId: agent-1 (spawned)\n${REPORT}`);
  assert.match(out, /agentId: agent-1/, "only a tail-anchored line is a trailer");
});

test("R2.1: an unrecognized trailer shape leaves the text intact (fails open, never mangles)", () => {
  const out = render(`${REPORT}\nagentId agent-7f3a [use SendMessage]`);
  assert.match(out, /agentId agent-7f3a/);
});

test("R2: block-array content — only text blocks are rewritten, others pass through", () => {
  const update: any = toolUpdateFromToolResult(
    {
      type: "tool_result",
      content: [
        { type: "text", text: `${REPORT}\n<usage>input: 9</usage>` },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      ],
    } as any,
    { name: "Agent" },
    false,
  );
  const rendered = JSON.stringify(update);
  assert.doesNotMatch(rendered, /<usage>/);
  assert.match(rendered, /migration touches 3 files/);
  assert.match(rendered, /image/, "a non-text block must survive untouched");
});

test("R2: a non-Agent tool keeps its text verbatim (the strip is Agent/Task-scoped)", () => {
  const out = render(`${REPORT}\n<usage>input: 9</usage>`, "Grep");
  assert.match(out, /<usage>/, "only Agent/Task results carry the trailer");
});

test("R2.2: linear time on adversarial input (no ambiguous repetition)", () => {
  // A near-miss of the agentId line: the regex must fail fast rather than backtrack. `[\w-]+` cannot
  // consume the following space and `[^)]*` cannot consume the closing paren, so both quantifiers
  // have exactly one candidate split per start position.
  const timeStrip = (n: number): number => {
    const text = `${REPORT}\nagentId: ${"a".repeat(n)} (${"b".repeat(n)}`;
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const start = performance.now();
      render(text);
      best = Math.min(best, performance.now() - start);
    }
    return best;
  };
  const t100 = timeStrip(100_000);
  const t200 = timeStrip(200_000);
  assert.ok(t100 < 50, `t(100k)=${t100.toFixed(2)}ms must be < 50ms (linear scan)`);
  assert.ok(t200 < 50, `t(200k)=${t200.toFixed(2)}ms must be < 50ms (linear scan)`);
});
