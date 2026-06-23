// Story 052 / Task 1.1 — CodeQL js/polynomial-redos (#1) on local-command marker stripping.
//
// `stripLocalCommandMetadata` (fork/src/acp-agent.ts) strips the XML-like markers the Claude SDK
// wraps around persisted local slash-command invocations (e.g. `/model`) on the `session/load`
// replay path. The original implementation matched them with a lazy backreference regex
//   /<(command-name|…|local-command-stderr)>[\s\S]*?<\/\1>/g
// which backtracks polynomially (O(n²)) on input that is many openers with no closing tag —
// CodeQL alert #1 (CWE-1333/400/730). Upstream #738 replaces it with a single-pass O(n) scanner.
//
// This test pins the rewrite:
//   (a) correctness — §Unchanged Behavior 1-3 (prose preserved, markers-only → null, all five tags,
//       array-of-blocks path) PLUS an equivalence oracle comparing the live function to the ORIGINAL
//       regex over a small corpus, so the rewrite is byte-identical;
//   (b) ReDoS guard — sub-quadratic scaling across two growing n (100k, 200k): each strip must run
//       < 50 ms AND t(200k) must stay within ~3× t(100k). The old quadratic regex blows the < 50 ms
//       bound and/or the ratio (Red); the linear scanner passes both (Green). A single small-n point
//       is deliberately NOT sufficient — a fast machine can run the quadratic regex under 50 ms at
//       100k, so the cross-n ratio is what proves linearity there.
//
// node:test runner: `npm run build` first (the behavioural import resolves against ../dist), then
//   node --experimental-strip-types --test test/redos-command-marker.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { stripLocalCommandMetadata } from "../dist/acp-agent.js";

const ALL_TAGS = [
  "command-name",
  "command-message",
  "command-args",
  "local-command-stdout",
  "local-command-stderr",
];

// Equivalence oracle: the ORIGINAL lazy-backreference regex, kept here verbatim so the rewritten
// scanner can be proven byte-identical against it. Only ever run on the small corpus below — never
// on the pathological scaling inputs (it is the very code that is O(n²) there).
const ORIGINAL_PATTERN =
  /<(command-name|command-message|command-args|local-command-stdout|local-command-stderr)>[\s\S]*?<\/\1>/g;
function oracle(text: string): string | null {
  const stripped = text.replace(ORIGINAL_PATTERN, "");
  return stripped.trim() === "" ? null : stripped;
}

// ── (a) correctness — §Unchanged Behavior 1-3 ───────────────────────────────────────────────
test("prose mixed alongside markers is preserved (Unchanged #1)", () => {
  assert.equal(stripLocalCommandMetadata("<command-name>/model</command-name>hi"), "hi");
  assert.equal(
    stripLocalCommandMetadata("please run /model with args"),
    "please run /model with args",
  );
});

test("a markers-only message returns null (Unchanged #2)", () => {
  assert.equal(stripLocalCommandMetadata("<command-name>/model</command-name>"), null);
  assert.equal(stripLocalCommandMetadata(""), null);
});

test("all five marker tags are stripped (Unchanged #3)", () => {
  for (const tag of ALL_TAGS) {
    assert.equal(stripLocalCommandMetadata(`<${tag}>payload</${tag}>`), null, tag);
    assert.equal(stripLocalCommandMetadata(`keep<${tag}>x</${tag}>`), "keep", tag);
  }
});

test("array-of-blocks path is unchanged (Unchanged #3)", () => {
  // text blocks get stripped; non-text blocks pass through untouched; an all-markers array → null.
  const result = stripLocalCommandMetadata([
    { type: "text", text: "<command-args>--json</command-args>keep" },
    { type: "image", source: "x" },
  ]);
  assert.deepEqual(result, [
    { type: "text", text: "keep" },
    { type: "image", source: "x" },
  ]);
  assert.equal(
    stripLocalCommandMetadata([{ type: "text", text: "<command-name>/m</command-name>" }]),
    null,
  );
});

// ── (a) equivalence oracle — byte-identical to the original regex over a corpus ──────────────
test("equivalence oracle: scanner output matches the original regex over a corpus", () => {
  const corpus = [
    "",
    "hi",
    "please run /model with args",
    "<command-name>/model</command-name>",
    "<command-name>/model</command-name>hi",
    "before <command-name>n</command-name> after",
    "<command-args>--json --verbose</command-args>",
    "<local-command-stdout>out\nlines</local-command-stdout>",
    "<local-command-stderr>err</local-command-stderr>",
    "<command-message>m</command-message>",
    // adjacent / multiple same-name tags
    "<command-name>a</command-name><command-args>b</command-args>",
    "<command-args>x</command-args>mid<command-args>y</command-args>",
    // a different-name marker nested inside one marker span
    "<command-args>x<command-name>y</command-name>z</command-args>",
    // orphan open with no close — preserved by both
    "<command-args>no closing tag ever appears here",
    // mismatched open/close — preserved by both (backreference \1 ↔ same-name indexOf)
    "<command-name>a</command-args>",
    // stray close with no open — preserved by both
    "just a </command-args> floating",
    // a `<` that is not a marker
    "a < b and c > d",
    // a near-miss tag name — preserved
    "<command-nam>notatag</command-nam>",
    // a same-name opener with no close, followed by a complete different-name marker
    "<command-args>noclose <command-name>n</command-name>",
    // first same-name opener has no close, a later one does (the whole span is removed)
    "<command-args>a <command-args>b</command-args>",
  ];
  for (const input of corpus) {
    assert.deepEqual(
      stripLocalCommandMetadata(input),
      oracle(input),
      `mismatch on: ${JSON.stringify(input)}`,
    );
  }
});

// ── (b) ReDoS guard — sub-quadratic scaling across ≥2 growing n ──────────────────────────────
// Pathological input: a long run of `<command-args>` openers with NO closing tag. The lazy
// backreference regex retries the tail from every opener → O(n²); the single-pass scanner marks a
// no-close opener "dead" and never rescans it → O(n).
function pathological(n: number): string {
  const opener = "<command-args>";
  return opener.repeat(Math.ceil(n / opener.length)).slice(0, n);
}

function minStripMs(input: string, runs = 3): number {
  let best = Infinity;
  for (let r = 0; r < runs; r++) {
    const start = performance.now();
    stripLocalCommandMetadata(input);
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

test("ReDoS guard: marker stripping scales sub-quadratically (Red on regex, Green on scanner)", () => {
  // warm up the JIT so the first real measurement is not penalised.
  stripLocalCommandMetadata(pathological(2_000));

  const t100 = minStripMs(pathological(100_000));
  const t200 = minStripMs(pathological(200_000));

  assert.ok(t100 < 50, `t(100k)=${t100.toFixed(2)}ms must be < 50ms (linear scanner)`);
  assert.ok(t200 < 50, `t(200k)=${t200.toFixed(2)}ms must be < 50ms (linear scanner)`);
  // doubling n must not quadruple the time: linear ⇒ ≈2×, quadratic ⇒ ≈4×.
  assert.ok(
    t200 < 3 * t100 + 1,
    `scaling ratio t(200k)/t(100k) = ${(t200 / t100).toFixed(2)} must stay sub-quadratic (< 3×)`,
  );
});
