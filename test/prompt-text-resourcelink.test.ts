// Story 030 / Task 1.1 — promptToClaude: ContentBlock[] → PTY text (text + resource_link).
// Proves the SDKUserMessage path is replaced by a string payload (R1.1), a `text` block is
// injected verbatim (R2.1), and a `resource_link` becomes @<path> for file:// URIs with a
// markdown-link fallback for non-path URIs (R2.2 / §8 reverse flow). No SDKUserMessage built.
// node:test runner: `node --experimental-strip-types --test test/prompt-text-resourcelink.test.ts`
// (run `npm run build` first — the behavioral import resolves against ../dist)
import { test } from "node:test";
import assert from "node:assert/strict";
import { promptToClaude } from "../dist/acp-agent.js";

/** Minimal PromptRequest builder — blocks cast loosely (strip-types: no runtime type check). */
const req = (...blocks: any[]) => ({ sessionId: "s-030", prompt: blocks }) as any;

test("R1.1 — promptToClaude returns a PTY text string, not an SDKUserMessage object", () => {
  const out = promptToClaude(req({ type: "text", text: "hello" }));
  assert.equal(typeof out, "string", "the rewritten promptToClaude returns the PTY text payload (string)");
  // the old SDKUserMessage shape (an object carrying .message.content) must be gone
  assert.equal((out as any).message, undefined, "no SDKUserMessage object is constructed (R1.1)");
});

test("R2.1 — a text block is injected into the payload verbatim", () => {
  const out = promptToClaude(req({ type: "text", text: "Explain the auth flow." }));
  assert.ok(out.includes("Explain the auth flow."), "the text block reaches the payload unchanged");
});

test("R2.2 — a resource_link with a file:// uri becomes @<path> (TUI re-reads), not a markdown link", () => {
  const out = promptToClaude(
    req({ type: "resource_link", name: "auth.ts", uri: "file:///home/u/src/auth.ts" }),
  );
  assert.ok(out.includes("@/home/u/src/auth.ts"), "a file:// resource_link emits @<path>");
  assert.ok(!out.includes("["), "no markdown-link wrapping for a resolvable file path");
});

test("R2.2 — a resource_link with a non-path uri falls back to a markdown link (no bare @, no throw)", () => {
  const out = promptToClaude(
    req({ type: "resource_link", name: "spec", uri: "https://example.com/spec" }),
  );
  assert.ok(
    out.includes("[spec](https://example.com/spec)"),
    "a non-path uri → markdown-link fallback rather than a broken @ mention",
  );
  assert.ok(!out.includes("@"), "no bare @ mention for a non-filesystem uri");
});
