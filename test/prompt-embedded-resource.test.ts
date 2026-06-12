// Story 030 / Task 1.2 — embedded `resource` block: large→@<path>, small→inline.
// One documented threshold constant (EMBEDDED_RESOURCE_INLINE_THRESHOLD) drives BOTH branches
// (R3.1/R3.2/R3.3 / §8 🔶 decision). Sizes are derived from the exported constant so the test
// proves both branches key off the SAME constant: exactly-at-threshold → @<path>, below → inline.
// node:test runner: `node --experimental-strip-types --test test/prompt-embedded-resource.test.ts`
// (run `npm run build` first — the behavioral import resolves against ../dist)
import { test } from "node:test";
import assert from "node:assert/strict";
// Namespace import: a not-yet-exported constant reads as `undefined` (no ESM link error), so the
// Red phase fails at an assertion (export absent) rather than at module load — a valid Red.
import * as acp from "../dist/acp-agent.js";

const promptToClaude = acp.promptToClaude;
const THRESHOLD: number = (acp as any).EMBEDDED_RESOURCE_INLINE_THRESHOLD;

const req = (...blocks: any[]) => ({ sessionId: "s-030", prompt: blocks }) as any;
const embedded = (text: string, uri: string) =>
  ({ type: "resource", resource: { uri, text, mimeType: "text/plain" } });

test("R3 — the inline threshold is a single exported, positive numeric constant", () => {
  assert.equal(typeof THRESHOLD, "number", "EMBEDDED_RESOURCE_INLINE_THRESHOLD is exported as a number");
  assert.ok(THRESHOLD > 0, "the threshold is a positive size");
});

test("R3.2 — a small embedded resource (below the threshold) is inlined", () => {
  assert.equal(typeof THRESHOLD, "number"); // guard → clean Red before the constant exists
  const content = "s".repeat(THRESHOLD - 1);
  const out = promptToClaude(req(embedded(content, "file:///p/small.ts")));
  assert.ok(out.includes(content), "below-threshold content is inlined directly into the payload");
});

test("R3.1 — a large embedded resource (at/above threshold) with a path becomes @<path>, NOT inlined", () => {
  assert.equal(typeof THRESHOLD, "number");
  const content = "L".repeat(THRESHOLD); // exactly at the threshold → at/above → @<path>
  const out = promptToClaude(req(embedded(content, "file:///p/big.ts")));
  assert.ok(out.includes("@/p/big.ts"), "at/above-threshold content is referenced by @<path> (TUI re-reads)");
  assert.ok(!out.includes(content), "the large content is NOT inlined");
});

test("R3.3 — a large embedded resource with no resolvable path falls back to inlining", () => {
  assert.equal(typeof THRESHOLD, "number");
  const content = "B".repeat(THRESHOLD + 100);
  const out = promptToClaude(req(embedded(content, "untitled:scratch-1"))); // non-file uri → no path
  assert.ok(out.includes(content), "path-less large content falls back to inline rather than a broken @");
  assert.ok(
    !out.includes("@untitled") && !out.includes("@scratch"),
    "no broken @ mention is emitted for a path-less resource",
  );
});
