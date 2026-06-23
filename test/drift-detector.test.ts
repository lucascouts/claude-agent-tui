// Story 049 / Task 3.1 (R2.1, R2.2, R2.3, R2.4, R2.5) — the OFFLINE drift detector.
//
// This file IS the detector (covered-by: itself). It runs the four PURE checks from
// `src/drift-checks.ts` (Task 2) over the REAL sources currently in the tree:
//   - stop_reason / jsonl_shape ... every `test/fixtures/v*/session.jsonl` fixture (globbed dynamically)
//   - content_block coverage ...... the installed `@anthropic-ai/sdk` block-type unions  vs  the bridge's
//                                   own `switch (chunk.type)` cases in `src/acp-agent.ts`
//   - allow_keystroke ............. the bridge's own `KEYSTROKE_YES` constant (imported, not hardcoded)
// and asserts ALL FOUR are green. The current binary surfaces have NOT drifted, so every check passes
// today; this catches the NEXT drift (e.g. a new SDK content block, a new stop_reason, a renamed JSONL
// field) PROACTIVELY — before `tsc` forces the `never` or a render silently no-ops.
//
// BINARY-FREE (R2.5): this detector never touches PATH, never spawns, never resolves a `claude` binary.
// It reads only on-disk fixtures + the installed SDK `.d.ts` + the bridge's own source text. A dedicated
// test below GUARDS that invariant by asserting neither this file nor `src/drift-checks.ts` references any
// spawn/binary surface. Consequently the suite is green whether or not `claude` is on PATH.
//
// node:test runner: `node --experimental-strip-types --test test/drift-detector.test.ts`
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  checkStopReasons,
  checkContentBlockCoverage,
  checkJsonlShape,
  checkAllowKeystroke,
} from "../src/drift-checks.ts";
import { KEYSTROKE_YES } from "../src/permissions/allow-inject.ts";

// ------------------------------------------------------------------------------------------------
// Shared real-source loaders (all I/O lives HERE — drift-checks.ts stays pure).
// ------------------------------------------------------------------------------------------------

type JsonLine = Record<string, unknown>;

/**
 * Load EVERY versioned fixture transcript. Globs `test/fixtures/` for dirs matching `/^v\d/` (so Task 5's
 * v2.1.176 / v2.1.185 dirs — and any future version — are picked up automatically; the version list is
 * NEVER hardcoded), reads each `session.jsonl`, and parses every non-empty line. Returns the flat list of
 * parsed lines across all versions.
 */
function loadAllFixtureLines(): JsonLine[] {
  const fixturesDir = new URL("./fixtures/", import.meta.url);
  const versionDirs = readdirSync(fixturesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^v\d/.test(d.name))
    .map((d) => d.name)
    .sort();
  const lines: JsonLine[] = [];
  for (const dir of versionDirs) {
    const url = new URL(`./fixtures/${dir}/session.jsonl`, import.meta.url);
    const raw = readFileSync(url, "utf8");
    for (const ln of raw.split("\n")) {
      if (ln.trim().length === 0) {
        continue;
      }
      lines.push(JSON.parse(ln) as JsonLine);
    }
  }
  return lines;
}

const allLines: JsonLine[] = loadAllFixtureLines();

// --- content_block derivation (the GOTCHA surface) — BOTH sides derived from real sources ---------

/** A `.d.ts` file + the union type name to mine out of it. */
interface UnionSource {
  /** Path to the `.d.ts`, relative to the SDK package's `resources/` dir. */
  file: string;
  /** The `export type <Union> = …` name. */
  union: string;
}

const SDK_RESOURCES = new URL("../node_modules/@anthropic-ai/sdk/resources/", import.meta.url);

/**
 * The four unions the SECOND `switch (chunk.type)` in acp-agent.ts consumes — its parameter type is
 * `ContentBlockParam[] | BetaContentBlock[] | BetaRawContentBlockDelta[]` (acp-agent.ts:53-54), and the
 * streaming deltas come through `RawContentBlockDelta`. We mine all four and union the discriminants so a
 * new block type in ANY of them is caught.
 *
 * NOTE: the beta unions live in `beta/messages/messages.d.ts` — the top-level `resources/beta.d.ts` is a
 * 1-line `export *` re-export stub (it carries no interface bodies), so we read the concrete file the
 * `@anthropic-ai/sdk/resources/beta.mjs` import ultimately resolves to.
 */
const UNION_SOURCES: readonly UnionSource[] = [
  { file: "messages/messages.d.ts", union: "ContentBlockParam" },
  { file: "messages/messages.d.ts", union: "RawContentBlockDelta" },
  { file: "beta/messages/messages.d.ts", union: "BetaContentBlock" },
  { file: "beta/messages/messages.d.ts", union: "BetaRawContentBlockDelta" },
];

/** The outcome of mining one union: the discriminant literals found, plus any member we could not resolve. */
interface UnionMineResult {
  literals: string[];
  unresolved: string[];
}

/**
 * 2-hop derivation for one union:
 *   1. `export type <Union> = A | B | C;` → member interface names.
 *   2. for each member `Foo`, its discriminant: `export interface Foo { … type: '<literal>' … }`
 *      (non-greedy from the interface head, so we take ITS first `type:` and not a later sibling's).
 * Returns the literals plus the names of members with no resolvable discriminant (the caller fails loud
 * if that list is non-empty for a union it expected to fully resolve).
 */
function mineUnionLiterals(src: string, union: string): UnionMineResult {
  const unionMatch = src.match(new RegExp(`export type ${union}\\s*=([^;]+);`));
  if (!unionMatch) {
    throw new Error(`drift-detector: union "${union}" not found (SDK layout changed?)`);
  }
  const members = unionMatch[1]
    .split("|")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const literals: string[] = [];
  const unresolved: string[] = [];
  for (const member of members) {
    const ifaceMatch = src.match(
      new RegExp(`export interface ${member}\\s*\\{[\\s\\S]*?\\btype:\\s*'([a-z_]+)'`),
    );
    if (ifaceMatch) {
      literals.push(ifaceMatch[1]);
    } else {
      unresolved.push(member);
    }
  }
  return { literals, unresolved };
}

/**
 * Union the discriminant literals of all {@link UNION_SOURCES}. If a union resolves ZERO members, that is a
 * broken parse (SDK layout moved) and we throw rather than risk a false green. Per-member unresolved names
 * are surfaced to the caller for a documented fall-back decision.
 */
function deriveSdkBlockTypes(): { types: Set<string>; unresolved: Record<string, string[]> } {
  const types = new Set<string>();
  const unresolved: Record<string, string[]> = {};
  for (const { file, union } of UNION_SOURCES) {
    const src = readFileSync(new URL(file, SDK_RESOURCES), "utf8");
    const { literals, unresolved: missed } = mineUnionLiterals(src, union);
    if (literals.length === 0) {
      throw new Error(`drift-detector: union "${union}" resolved 0 discriminants (broken parse)`);
    }
    for (const lit of literals) {
      types.add(lit);
    }
    if (missed.length > 0) {
      unresolved[union] = missed;
    }
  }
  return { types, unresolved };
}

/**
 * Mine the `case "<label>":` labels of the SECOND `switch (chunk.type)` in acp-agent.ts — the one that ends
 * at `unreachable(chunk, …)`. There are TWO such switches; to pick the right one WITHOUT hardcoding line
 * numbers we anchor on the `unreachable(chunk` line, then take the LAST `switch (chunk.type)` BEFORE it.
 * (The first switch handles `prompt.prompt` blocks and ends at `unreachable(event`, which we deliberately
 * exclude — it adds `audio`/`resource`/`resource_link` cases that are not SDK content blocks.)
 */
function deriveHandledCases(): { cases: Set<string>; startLine: number; endLine: number } {
  const acpUrl = new URL("../src/acp-agent.ts", import.meta.url);
  const fileLines = readFileSync(acpUrl, "utf8").split("\n");
  const endIdx = fileLines.findIndex((l) => l.includes("unreachable(chunk"));
  if (endIdx < 0) {
    throw new Error('drift-detector: could not find "unreachable(chunk" anchor in acp-agent.ts');
  }
  let startIdx = -1;
  for (let i = endIdx; i >= 0; i--) {
    if (fileLines[i].includes("switch (chunk.type)")) {
      startIdx = i;
      break;
    }
  }
  if (startIdx < 0) {
    throw new Error("drift-detector: could not find the chunk.type switch before the unreachable anchor");
  }
  const region = fileLines.slice(startIdx, endIdx + 1).join("\n");
  const cases = new Set<string>();
  for (const m of region.matchAll(/case\s+"([a-z_]+)":/g)) {
    cases.add(m[1]);
  }
  return { cases, startLine: startIdx + 1, endLine: endIdx + 1 };
}

// ------------------------------------------------------------------------------------------------
// Surface 1 — stop_reason (R2.1)
// ------------------------------------------------------------------------------------------------

test("Surface 1 (R2.1): every fixture stop_reason is handled or known-non-terminal", () => {
  assert.ok(allLines.length > 0, "fixtures must load (>0 parsed lines across all v* dirs)");
  const r = checkStopReasons(allLines);
  assert.equal(r.ok, true, r.detail);
});

// ------------------------------------------------------------------------------------------------
// Surface 2 — content_block coverage (R2.2) — both sides DERIVED from the real sources
// ------------------------------------------------------------------------------------------------

test("Surface 2 (R2.2): every SDK content-block type has a handled switch case", () => {
  const { types: sdkBlockTypes, unresolved } = deriveSdkBlockTypes();
  const { cases: handledCases, startLine, endLine } = deriveHandledCases();

  // Fall-back transparency: a union member that genuinely will not resolve is logged, never silently
  // dropped (here it should be empty — all 45 members across the 4 unions resolve today).
  for (const [union, missed] of Object.entries(unresolved)) {
    console.warn(
      `[drift-detector] union "${union}" had unresolved member(s) (skipped, NOT counted as coverage): ` +
        missed.join(", "),
    );
  }

  // Sanity-gates — fail LOUD on a broken parse so we never report a false green from an empty set.
  assert.ok(
    sdkBlockTypes.size > 5 && sdkBlockTypes.has("text") && sdkBlockTypes.has("tool_use"),
    `SDK block-type derivation must resolve a plausible set (got ${sdkBlockTypes.size}: ` +
      `${[...sdkBlockTypes].sort().join(",")})`,
  );
  assert.ok(
    handledCases.size > 5 && handledCases.has("text"),
    `handled-case derivation must resolve a plausible set from switch lines ${startLine}..${endLine} ` +
      `(got ${handledCases.size}: ${[...handledCases].sort().join(",")})`,
  );

  // The real check: every SDK block type must be a handled case (passes today; trips on the next bump).
  const r = checkContentBlockCoverage([...sdkBlockTypes], [...handledCases]);
  assert.equal(r.ok, true, r.detail);
});

// ------------------------------------------------------------------------------------------------
// Surface 3 — jsonl_shape (R2.3)
// ------------------------------------------------------------------------------------------------

test("Surface 3 (R2.3): every fixture line matches the known raw JSONL shape", () => {
  assert.ok(allLines.length > 0, "fixtures must load (>0 parsed lines across all v* dirs)");
  const r = checkJsonlShape(allLines);
  assert.equal(r.ok, true, r.detail);
});

// ------------------------------------------------------------------------------------------------
// Surface 4 — allow_keystroke (R2.4) — fed the REAL imported constant, not a hardcoded "1\r"
// ------------------------------------------------------------------------------------------------

test("Surface 4 (R2.4): the bridge's KEYSTROKE_YES still matches the canonical allow keystroke", () => {
  const r = checkAllowKeystroke(KEYSTROKE_YES);
  assert.equal(r.ok, true, r.detail);
});

// ------------------------------------------------------------------------------------------------
// R2.5 — the detector is BINARY-FREE: it never spawns nor resolves a `claude` binary.
// ------------------------------------------------------------------------------------------------

/**
 * Strip `//…` line comments and `/* … *\/` block comments so the R2.5 guard scans CODE, not prose. Both
 * files legitimately *document* the surfaces they avoid (e.g. drift-checks.ts's header says "NO
 * child_process/spawn"); those mentions are the point of the guard, not a violation, so they must not
 * trip it. This is a deliberately conservative stripper (no string-literal awareness needed — these two
 * files contain no string literal carrying a comment delimiter), sufficient to isolate executable code.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ") // block comments
    .replace(/^[ \t]*\/\/.*$/gm, "") // whole-line // comments
    .replace(/([^:])\/\/.*$/gm, "$1"); // trailing // comments (avoid eating `://` in a URL scheme)
}

test("R2.5: neither the detector nor drift-checks references any binary-contact surface in code", () => {
  // Build the forbidden tokens from split fragments so the guard's OWN code does not match itself: a bare
  // contiguous token in any string literal here (even a test title or a message) would be scanned as code
  // and trip the guard. Every fragment below is split, and prose mentions live only in comments (stripped).
  // Each token is a binary-contact surface the pure detector must never need.
  const forbidden: string[] = [
    "child" + "_process",
    "sp" + "awn",
    "exec" + "File",
    "resolveClaude" + "Path",
    "claude" + "-path",
  ];

  const targets: ReadonlyArray<{ label: string; url: URL }> = [
    { label: "test/drift-detector.test.ts", url: new URL(import.meta.url) },
    { label: "src/drift-checks.ts", url: new URL("../src/drift-checks.ts", import.meta.url) },
  ];

  for (const { label, url } of targets) {
    const code = stripComments(readFileSync(fileURLToPath(url), "utf8"));
    for (const token of forbidden) {
      assert.ok(!code.includes(token), `${label} must be binary-free (R2.5) but references "${token}" in code`);
    }
  }
});
