// Story 068 / Task 1.1 — context-window resolution per model alias (R1, R1.1, R1.2, R2; UB2).
//
// BUG: the Zed panel's token denominator showed 200K for EVERY session because `contextWindowSize`
// was only ever 1M when the model string matched `\b1m\b`, falling back to DEFAULT_CONTEXT_WINDOW
// (200K) otherwise. `opus` (natively 1M) therefore wrongly showed 200K, while `sonnet`/`haiku` (truly
// 200K) were correct by accident. The window is NOT uniform — a blanket "everything is 1M" would be wrong.
//
// FIX (story 068): a static alias→window map (MODEL_CONTEXT_WINDOWS, beside MODEL_CATALOG) keyed by the
// catalog `value`, consulted by `inferContextWindowFromModel` BEFORE the `\b1m\b` regex, then `null`.
// The two call sites keep `?? DEFAULT_CONTEXT_WINDOW`. UB2: `sonnet[1m]` must STAY 1M (it already did
// via the regex; this story must not regress it).
//
// Symbols are namespace-imported so this file LOADS even before the story-068 exports exist (the
// "surface" test then fails cleanly — Red — instead of the whole module erroring on a missing named
// import). `inferContextWindowFromModel` + `DEFAULT_CONTEXT_WINDOW` are exported from acp-agent.ts for
// this unit (they were private before story 068); `MODEL_CONTEXT_WINDOWS` is the new model-catalog map.
//
// node:test runner (build first): `node --experimental-strip-types --test test/context-window.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as acp from "../dist/acp-agent.js";
import * as catalog from "../dist/model-catalog.js";

/** The resolver under test (null = "unknown", caller applies the default). */
const infer = (m: string): number | null => acp.inferContextWindowFromModel(m);
/** Mirror the two call sites' `?? DEFAULT_CONTEXT_WINDOW` to assert the OBSERVABLE denominator. */
const resolve = (m: string): number => infer(m) ?? acp.DEFAULT_CONTEXT_WINDOW;

test("068 surface: the story-068 exports exist (resolver, default, map)", () => {
  assert.equal(
    typeof acp.inferContextWindowFromModel,
    "function",
    "inferContextWindowFromModel must be exported from acp-agent.ts",
  );
  assert.equal(
    typeof acp.DEFAULT_CONTEXT_WINDOW,
    "number",
    "DEFAULT_CONTEXT_WINDOW must be exported from acp-agent.ts",
  );
  assert.equal(
    typeof catalog.MODEL_CONTEXT_WINDOWS,
    "object",
    "MODEL_CONTEXT_WINDOWS must be exported from model-catalog.ts",
  );
  assert.ok(catalog.MODEL_CONTEXT_WINDOWS, "MODEL_CONTEXT_WINDOWS must be a non-null record");
});

test("068 R1.1: opus → 1M (the fix — was wrongly 200K)", () => {
  assert.equal(infer("opus"), 1_000_000);
});

test("068 R1.1: sonnet → 200K (standard window; correct as-is, NOT 1M)", () => {
  assert.equal(infer("sonnet"), 200_000);
});

test("068 R1.1 / UB2: sonnet[1m] → 1M (must NOT regress)", () => {
  assert.equal(infer("sonnet[1m]"), 1_000_000);
});

test("068 R1.1: haiku → 200K", () => {
  assert.equal(infer("haiku"), 200_000);
});

test("068 R1.2: unknown alias carrying a 1m token → 1M (regex fallback)", () => {
  assert.equal(infer("claude-sonnet-4-6-1m"), 1_000_000);
});

test("068 R1.2: fully unknown → null; call site applies DEFAULT_CONTEXT_WINDOW", () => {
  assert.equal(infer("totally-unknown-model"), null);
  assert.equal(resolve("totally-unknown-model"), acp.DEFAULT_CONTEXT_WINDOW);
  assert.equal(resolve("totally-unknown-model"), 200_000);
});

test("068 R2: default + opusplan → 200K conservative (TUI-config-dependent / mixed)", () => {
  assert.equal(infer("default"), 200_000);
  assert.equal(infer("opusplan"), 200_000);
});

test("068 anti-drift: every MODEL_CATALOG value has an explicit MODEL_CONTEXT_WINDOWS entry", () => {
  for (const m of catalog.MODEL_CATALOG) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(catalog.MODEL_CONTEXT_WINDOWS, m.value),
      `catalog alias '${m.value}' must have an explicit MODEL_CONTEXT_WINDOWS entry (drift guard)`,
    );
  }
});
