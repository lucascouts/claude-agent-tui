// Security regression — CodeQL alerts 16 (`js/redos`, exponential) and 17 (`js/polynomial-redos`)
// on `src/tools.ts`, both introduced by the #974 port and both closed by replacing the regex with
// a linear scanner.
//
// THE VULNERABILITY WAS REAL, not a CodeQL false positive. The ported upstream regex nested a
// quantifier inside a quantified group — `(?: \[blocked by ((?:#[^,\]]+(?:, )?)+)\])?` — and on
// the input CodeQL named (`#! [pending] a [blocked by #` + N repetitions of `+#`) the match time
// QUADRUPLED for every 2 characters added: n=20 → 4.9 ms, n=22 → 20 ms, n=24 → 79 ms. Extrapolated,
// ~40 repetitions — a line of about 100 characters — hangs the process for over an hour.
//
// The input is not a literal in this file: it is the model-facing text of a tool_result read from
// the session transcript, so it is exactly the "uncontrolled data" the rule is about.
//
// Two things are pinned here, and the equivalence one matters as much as the timing one — a
// rewrite that is fast but parses differently would silently change what users see in their plan:
//
//   1. EQUIVALENCE — the scanner and the original regex agree on every input below, including the
//      awkward ones (nested brackets in the subject, a parenthesised owner, an empty blocked list,
//      trailing junk). The regex is reproduced here ONLY as the test oracle; production no longer
//      contains it.
//   2. LINEARITY — the same family of inputs that made the regex explode stays flat.
//
// node:test runner: `node --experimental-strip-types --test test/redos-task-list-line.test.ts`
// (run `npm run build` first — the behavioral import resolves against ../dist).
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTaskListOutput } from "../dist/tools.js";

/**
 * The ORIGINAL upstream regex, kept as a test oracle only. Never call it on adversarial input —
 * that is the whole point of the file it was removed from.
 */
const ORACLE =
  /^#(\S+) \[(pending|in_progress|completed)\] (.+?)(?: \(([^()]*)\))?(?: \[blocked by ((?:#[^,\]]+(?:, )?)+)\])?$/;

function viaOracle(line: string) {
  const m = ORACLE.exec(line);
  if (!m) return undefined;
  return {
    id: m[1],
    subject: m[3],
    status: m[2],
    ...(m[4] ? { owner: m[4] } : {}),
    blockedBy: m[5] ? m[5].split(", ").map((id) => id.slice(1)) : [],
  };
}

/** The scanner, reached through its only public caller. */
function viaScanner(line: string) {
  return parseTaskListOutput(line)?.tasks?.[0];
}

const CASES: ReadonlyArray<readonly [string, string]> = [
  ["plain", "#1 [pending] Do the thing"],
  ["real corpus line", "#1 [completed] Grupo 1 — The view model"],
  ["in_progress", "#42 [in_progress] Wire the seam"],
  ["with owner", "#3 [pending] Ship it (alice)"],
  ["with blocked list", "#4 [pending] Later [blocked by #1, #2]"],
  ["owner and blocked", "#5 [pending] Both (bob) [blocked by #1]"],
  ["subject with brackets", "#6 [pending] a [not a blocked list]"],
  ["subject with parens", "#7 [pending] fix (again) now"],
  ["two paren groups", "#8 [pending] a (x) (y)"],
  ["blocked then parens", "#9 [pending] a [blocked by #2] (owner)"],
  ["em dash id", "#a1b2 [completed] Unicode — em dash"],
  ["unknown status", "#1 [archived] nope"],
  ["no leading hash", "1 [pending] nope"],
  ["empty id", "# [pending] nope"],
  ["no subject", "#1 [pending] "],
  ["missing bracket", "#1 pending] nope"],
  ["empty string", ""],
  ["just a hash", "#"],
  ["trailing junk", "#1 [pending] a] extra"],
];

test("equivalence: the scanner agrees with the original regex on every shape", () => {
  for (const [name, line] of CASES) {
    assert.deepEqual(viaScanner(line), viaOracle(line), `disagreement on "${name}": ${line}`);
  }
});

test("equivalence: the scanner still parses the real corpus listing", () => {
  const real = "#1 [completed] Grupo 1 — The view model\n#6 [pending] Grupo 6 — Wiring";
  const parsed: any = parseTaskListOutput(real);
  assert.equal(parsed.tasks.length, 2);
  assert.deepEqual(parsed.tasks[0], {
    id: "1",
    subject: "Grupo 1 — The view model",
    status: "completed",
    blockedBy: [],
  });
});

test("equivalence: owner and blockedBy survive the rewrite", () => {
  const parsed: any = parseTaskListOutput("#5 [in_progress] Both (bob) [blocked by #1, #2]");
  assert.deepEqual(parsed.tasks[0], {
    id: "5",
    subject: "Both",
    status: "in_progress",
    owner: "bob",
    blockedBy: ["1", "2"],
  });
});

/** Median of 5 runs — one scheduling hiccup should not decide a security regression. */
function medianParseMs(line: string): number {
  const samples: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t0 = process.hrtime.bigint();
    parseTaskListOutput(line);
    samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  return samples.sort((a, b) => a - b)[2];
}

test("ReDoS guard: the exact CodeQL witness parses instantly, at a size the regex could not survive", () => {
  // n=24 already cost the regex 79 ms; n=200 would have been astronomically worse.
  const witness = "#! [pending] a [blocked by #" + "+#".repeat(200);
  const ms = medianParseMs(witness);
  assert.ok(ms < 50, `the CodeQL witness must parse in well under 50ms, took ${ms.toFixed(2)}ms`);
});

test("ReDoS guard: cost stays linear — doubling the input does not square the time", () => {
  const witness = (n: number) => "#! [pending] a [blocked by #" + "+#".repeat(n);
  parseTaskListOutput(witness(500)); // warm the JIT so the first measurement is not penalised
  const t2k = medianParseMs(witness(2_000));
  const t4k = medianParseMs(witness(4_000));
  assert.ok(t2k < 50, `t(2k)=${t2k.toFixed(2)}ms must be < 50ms`);
  assert.ok(t4k < 50, `t(4k)=${t4k.toFixed(2)}ms must be < 50ms`);
  // Linear ⇒ ≈2×; exponential ⇒ the run would never have reached this line.
  assert.ok(
    t4k < 3 * t2k + 1,
    `ratio t(4k)/t(2k) = ${(t4k / t2k).toFixed(2)} must stay sub-quadratic (< 3×)`,
  );
});

test("ReDoS guard: a long well-formed blocked list is linear too", () => {
  const ids = Array.from({ length: 5_000 }, (_, i) => `#${i}`).join(", ");
  const ms = medianParseMs(`#1 [pending] many [blocked by ${ids}]`);
  assert.ok(ms < 50, `a 5000-entry blocked list must parse in under 50ms, took ${ms.toFixed(2)}ms`);
});
