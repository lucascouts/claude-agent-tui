import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const seamMap = readFileSync(join(here, "..", "SEAM-MAP.md"), "utf8");

// --- Reusable row parser (the seam map is ONE markdown table) ----------------
// A table row is a line that starts (after optional whitespace) with `|`. Its
// cells are the `|`-delimited segments with the leading/trailing empties dropped.
// This file ACCUMULATES: later sub-tasks APPEND test blocks and reuse these
// helpers; they never weaken or remove prior blocks. Anchor by symbol NAME.

export interface SeamRow {
  symbol: string; // first cell, raw (still backtick-wrapped, e.g. "`runAcp`")
  verdict: string; // second cell
  target: string; // third cell ("Target story")
  note: string; // fourth cell
  cells: string[]; // all cells, trimmed
}

export function parseRows(md: string): SeamRow[] {
  const rows: SeamRow[] = [];
  for (const line of md.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    // Drop the leading/trailing empty cells produced by the outer pipes.
    const cells = trimmed.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length === 0) continue;
    // Skip the header separator row (cells are only dashes/colons).
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
    rows.push({
      symbol: cells[0] ?? "",
      verdict: cells[1] ?? "",
      target: cells[2] ?? "",
      note: cells[3] ?? "",
      cells,
    });
  }
  return rows;
}

// Return the data row whose first cell contains the backticked `symbol`.
// Matches the exact identifier in backticks so `prompt` never matches
// `createSession + prompt()` etc.
export function rowFor(md: string, symbol: string): SeamRow | undefined {
  const needle = "`" + symbol + "`";
  return parseRows(md).find(
    (r) => r.symbol.includes(needle) && r.symbol !== "Symbol",
  );
}

// Return every data row whose Verdict cell exactly equals `verdict`
// (e.g. "CUT", "REWRITE", "KEEP"). Exported for later sub-tasks (2.2/2.3,
// completeness) that filter the table by tag-class. The single DEAD row's
// Verdict cell is a long phrase, so it is matched by `.includes("DEAD")`
// elsewhere, never by exact-equals here.
export function rowsByVerdict(md: string, verdict: string): SeamRow[] {
  return parseRows(md).filter((r) => r.verdict === verdict);
}

// --- R1.1: ACP transport layer is tagged KEEP, target 011 --------------------
const TRANSPORT_KEEP = ["runAcp", "ndJsonStream", "AgentSideConnection", "initialize"];

for (const symbol of TRANSPORT_KEEP) {
  test(`seam-map (R1.1): \`${symbol}\` has a KEEP row targeting 011`, () => {
    const row = rowFor(seamMap, symbol);
    assert.ok(row, `SEAM-MAP.md: no row found for symbol '${symbol}'`);
    assert.equal(
      row.verdict,
      "KEEP",
      `SEAM-MAP.md: '${symbol}' verdict is '${row.verdict}', expected 'KEEP'`,
    );
    assert.ok(
      row.target.includes("011"),
      `SEAM-MAP.md: '${symbol}' target is '${row.target}', expected to contain '011'`,
    );
  });
}

// --- R1.2 / R1.3: pure translators are tagged KEEP (engine-agnostic) ---------
// toAcpNotifications + every tools.ts export are reused 1:1 by the fork (§3/§4
// "REUSA integral"); they operate on Anthropic content blocks identical to JSONL
// message.content, so they are engine-agnostic. NOTE: streamEventToAcpNotifications
// is deliberately NOT asserted here — it is the lone KEEP-but-DEAD exception
// (Task 3 / §7 caveat), so it carries no live-consumer KEEP row.
const TOOLS_TS_KEEP = [
  "toolInfoFromToolUse",
  "toolUpdateFromToolResult",
  "toolUpdateFromDiffToolResponse",
  "planEntries",
  "taskStateToPlanEntries",
];
const TRANSLATOR_KEEP = ["toAcpNotifications", ...TOOLS_TS_KEEP];

// R1.2: every pure translator has a KEEP row.
for (const symbol of TRANSLATOR_KEEP) {
  test(`seam-map (R1.2): \`${symbol}\` has a KEEP row`, () => {
    const row = rowFor(seamMap, symbol);
    assert.ok(row, `SEAM-MAP.md: no row found for symbol '${symbol}'`);
    assert.equal(
      row.verdict,
      "KEEP",
      `SEAM-MAP.md: '${symbol}' verdict is '${row.verdict}', expected 'KEEP'`,
    );
  });
}

// R1.3: no tools.ts translator is tagged CUT or REWRITE (they are engine-agnostic).
for (const symbol of TOOLS_TS_KEEP) {
  test(`seam-map (R1.3): \`${symbol}\` is not CUT or REWRITE`, () => {
    const row = rowFor(seamMap, symbol);
    assert.ok(row, `SEAM-MAP.md: no row found for symbol '${symbol}'`);
    assert.notEqual(
      row.verdict,
      "CUT",
      `SEAM-MAP.md: '${symbol}' is tagged CUT; tools.ts translators are engine-agnostic (KEEP)`,
    );
    assert.notEqual(
      row.verdict,
      "REWRITE",
      `SEAM-MAP.md: '${symbol}' is tagged REWRITE; tools.ts translators are engine-agnostic (KEEP)`,
    );
  });
}

// --- R1.4: reused SDK JSONL readers are tagged KEEP --------------------------
// getSessionMessages is reused LIVE (Degrau-0 E5 `REUSE-live`, DEGRAU0-RESULTS.md
// binding decision 1: re-invoked on the end-of-turn signal / short debounce, NO
// custom parser for v1) — wired by 015 (live read) + 023 (rewritten core).
// replaySessionHistory is reused for the session/load replay (§11) — wired by 026.

test("seam-map (R1.4): `getSessionMessages` has a KEEP row targeting 015 and 023, noted live", () => {
  const row = rowFor(seamMap, "getSessionMessages");
  assert.ok(row, "SEAM-MAP.md: no row found for symbol 'getSessionMessages'");
  assert.equal(
    row.verdict,
    "KEEP",
    `SEAM-MAP.md: 'getSessionMessages' verdict is '${row.verdict}', expected 'KEEP'`,
  );
  assert.ok(
    row.target.includes("015"),
    `SEAM-MAP.md: 'getSessionMessages' target is '${row.target}', expected to contain '015'`,
  );
  assert.ok(
    row.target.includes("023"),
    `SEAM-MAP.md: 'getSessionMessages' target is '${row.target}', expected to contain '023'`,
  );
  assert.match(
    row.note,
    /live/i,
    `SEAM-MAP.md: 'getSessionMessages' note must cite the live (REUSE-live) reuse; note is '${row.note}'`,
  );
});

test("seam-map (R1.4): `replaySessionHistory` has a KEEP row targeting 026", () => {
  const row = rowFor(seamMap, "replaySessionHistory");
  assert.ok(row, "SEAM-MAP.md: no row found for symbol 'replaySessionHistory'");
  assert.equal(
    row.verdict,
    "KEEP",
    `SEAM-MAP.md: 'replaySessionHistory' verdict is '${row.verdict}', expected 'KEEP'`,
  );
  assert.ok(
    row.target.includes("026"),
    `SEAM-MAP.md: 'replaySessionHistory' target is '${row.target}', expected to contain '026'`,
  );
});

// --- R2.1 / R2.2: createSession + prompt() loop are the rewrite seam ---------
// The SDK-coupled orchestration is CUT and the pair is REWRITTEN into the
// PTY + JSONL-tail core, all wired by story 023 (§3 CORTAR / §4 "REESCREVE
// createSession() + loop prompt()" / §0). Symbols anchored BY NAME — upstream
// line numbers are volatile (§3). Located via the rowsByVerdict / rowFor
// helpers so the REWRITE row is matched by its Verdict, not by a brittle
// symbol-cell literal.

// R2.2: a REWRITE row exists, targets 023, and its Symbol cell names BOTH
// `createSession` and `prompt` (the pair being rewritten as one core).
test("seam-map (R2.2): a REWRITE row targets 023 and names both `createSession` and `prompt`", () => {
  const rewriteRows = rowsByVerdict(seamMap, "REWRITE");
  assert.equal(
    rewriteRows.length,
    1,
    `SEAM-MAP.md: expected exactly one REWRITE row, found ${rewriteRows.length}`,
  );
  const row = rewriteRows[0];
  assert.ok(
    row.target.includes("023"),
    `SEAM-MAP.md: REWRITE row target is '${row.target}', expected to contain '023'`,
  );
  assert.ok(
    row.symbol.includes("`createSession") && row.symbol.includes("prompt()`"),
    `SEAM-MAP.md: REWRITE row Symbol cell is '${row.symbol}', expected to reference both 'createSession' and 'prompt'`,
  );
});

// R2.1: `createSession` is CUT, target 023, note names the SDK stream-json call.
test("seam-map (R2.1): `createSession` has a CUT row targeting 023 noting `query({ prompt, options })`", () => {
  const row = rowFor(seamMap, "createSession");
  assert.ok(row, "SEAM-MAP.md: no row found for symbol 'createSession'");
  assert.equal(
    row.verdict,
    "CUT",
    `SEAM-MAP.md: 'createSession' verdict is '${row.verdict}', expected 'CUT'`,
  );
  assert.ok(
    row.target.includes("023"),
    `SEAM-MAP.md: 'createSession' target is '${row.target}', expected to contain '023'`,
  );
  assert.ok(
    row.note.includes("query({ prompt, options })"),
    `SEAM-MAP.md: 'createSession' note is '${row.note}', expected to name the 'query({ prompt, options })' SDK stream-json call`,
  );
});

// R2.1: `prompt` is CUT, target 023, note names the while(true) consumption loop.
test("seam-map (R2.1): `prompt` has a CUT row targeting 023 noting the `while(true)` consumption loop", () => {
  const row = rowFor(seamMap, "prompt");
  assert.ok(row, "SEAM-MAP.md: no row found for symbol 'prompt'");
  assert.equal(
    row.verdict,
    "CUT",
    `SEAM-MAP.md: 'prompt' verdict is '${row.verdict}', expected 'CUT'`,
  );
  assert.ok(
    row.target.includes("023"),
    `SEAM-MAP.md: 'prompt' target is '${row.target}', expected to contain '023'`,
  );
  assert.ok(
    row.note.includes("while(true)"),
    `SEAM-MAP.md: 'prompt' note is '${row.note}', expected to name the 'while(true)' SDK consumption loop`,
  );
});

// --- R2.3 / R2.4: SDK control-path callbacks are CUT -------------------------
// The SDK-driven control path is cut and re-implemented against the new engine:
//   cancel()            via query.interrupt()      → re-implemented vs PTY \x03 (story 030, §3)
//   setPermissionMode() via query.setPermissionMode() → Degrau-2 gate path (story 032, §3/§9)
//   canUseTool          SDK permission callback that DOES NOT EXIST in the PTY flow
//                       (§9 verified truth) → Degrau-2 (story 032)
// Symbols anchored BY NAME (upstream line numbers volatile, §3); located via rowFor.

// R2.3: `cancel` is CUT, target 030 (re-implemented against the PTY interrupt).
test("seam-map (R2.3): `cancel` has a CUT row targeting 030", () => {
  const row = rowFor(seamMap, "cancel");
  assert.ok(row, "SEAM-MAP.md: no row found for symbol 'cancel'");
  assert.equal(
    row.verdict,
    "CUT",
    `SEAM-MAP.md: 'cancel' verdict is '${row.verdict}', expected 'CUT'`,
  );
  assert.ok(
    row.target.includes("030"),
    `SEAM-MAP.md: 'cancel' target is '${row.target}', expected to contain '030'`,
  );
});

// R2.4: `setPermissionMode` is CUT, target 032 (Degrau-2 gate path).
test("seam-map (R2.4): `setPermissionMode` has a CUT row targeting 032", () => {
  const row = rowFor(seamMap, "setPermissionMode");
  assert.ok(row, "SEAM-MAP.md: no row found for symbol 'setPermissionMode'");
  assert.equal(
    row.verdict,
    "CUT",
    `SEAM-MAP.md: 'setPermissionMode' verdict is '${row.verdict}', expected 'CUT'`,
  );
  assert.ok(
    row.target.includes("032"),
    `SEAM-MAP.md: 'setPermissionMode' target is '${row.target}', expected to contain '032'`,
  );
});

// R2.4: `canUseTool` is CUT, target 032 — the SDK permission callback that does
// NOT exist in the PTY flow (§9). Note must record that non-existence.
test("seam-map (R2.4): `canUseTool` has a CUT row targeting 032 noting it does not exist in the PTY flow", () => {
  const row = rowFor(seamMap, "canUseTool");
  assert.ok(row, "SEAM-MAP.md: no row found for symbol 'canUseTool'");
  assert.equal(
    row.verdict,
    "CUT",
    `SEAM-MAP.md: 'canUseTool' verdict is '${row.verdict}', expected 'CUT'`,
  );
  assert.ok(
    row.target.includes("032"),
    `SEAM-MAP.md: 'canUseTool' target is '${row.target}', expected to contain '032'`,
  );
  assert.match(
    row.note,
    /not\s+(\*\*)?exist/i,
    `SEAM-MAP.md: 'canUseTool' note is '${row.note}', expected to record that the SDK callback does not exist in the PTY flow (§9)`,
  );
});

// --- R2.5: the SDK-embedded binary resolver is CUT --------------------------
// claudeCliPath() resolves the binary EMBEDDED IN THE SDK; the fork instead
// resolves the subscription `claude` from the user's PATH (§3 CORTAR bullet),
// so the symbol is CUT and replaced by the PATH-resolver story 012. Symbol
// anchored BY NAME (upstream line numbers volatile, §3); located via rowFor.

// R2.5: `claudeCliPath` is CUT, target 012, note names the PATH replacement.
test("seam-map (R2.5): `claudeCliPath` has a CUT row targeting 012 noting PATH resolution", () => {
  const row = rowFor(seamMap, "claudeCliPath");
  assert.ok(row, "SEAM-MAP.md: no row found for symbol 'claudeCliPath'");
  assert.equal(
    row.verdict,
    "CUT",
    `SEAM-MAP.md: 'claudeCliPath' verdict is '${row.verdict}', expected 'CUT'`,
  );
  assert.ok(
    row.target.includes("012"),
    `SEAM-MAP.md: 'claudeCliPath' target is '${row.target}', expected to contain '012'`,
  );
  assert.match(
    row.note,
    /PATH/,
    `SEAM-MAP.md: 'claudeCliPath' note is '${row.note}', expected to mention the subscription 'claude' resolved from PATH (§3)`,
  );
});

// --- R4.1: the complete table enumerates EXACTLY the §3/§4 entries -----------
// Keystone completeness assertion. The full SEAM-MAP table must contain exactly
// the 20 rows (12 KEEP + 6 CUT + 1 REWRITE + 1 DEAD) covering every §3 CORTAR /
// §3 MANTER / §4 symbol — no row missing, no symbol invented. We assert the
// distinct base-symbol set equals the authoritative 19, every Verdict is in the
// {KEEP,CUT,REWRITE,DEAD} space, and every Target token matches the per-symbol
// mapping resolved in .draft/seam-contract.md (which SUPERSEDES task 4.1's
// narrower literal "{011,018,019,020,026}" KEEP-set phrasing — deviations.yaml #3).

// Extract every backticked identifier from a Symbol cell. A cell may be a single
// `` `runAcp` `` or a composite like `` `createSession + prompt()` ``; we pull
// each backtick-delimited token and reduce it to its bare identifier (strip a
// trailing call `()` and any non-identifier punctuation), e.g.
// "`createSession + prompt()`" → ["createSession", "prompt"].
function baseSymbolsOf(symbolCell: string): string[] {
  const out: string[] = [];
  const backticked = symbolCell.match(/`[^`]+`/g) ?? [];
  for (const tok of backticked) {
    const inner = tok.slice(1, -1); // drop the surrounding backticks
    for (const ident of inner.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []) {
      out.push(ident);
    }
  }
  return out;
}

// A row is DEAD iff its Verdict cell contains "DEAD" (the long KEEP-but-DEAD
// phrase on the streamEventToAcpNotifications row); otherwise the Verdict cell
// is one of the bare tags KEEP / CUT / REWRITE.
function verdictClass(row: SeamRow): string {
  return row.verdict.includes("DEAD") ? "DEAD" : row.verdict;
}

// Extract every 3-digit story token from a Target cell ("018/019/020" → 3 tokens).
function targetTokens(targetCell: string): string[] {
  return targetCell.match(/\d{3}/g) ?? [];
}

const EXPECTED_BASE_SYMBOLS = [
  "runAcp",
  "ndJsonStream",
  "AgentSideConnection",
  "initialize",
  "toAcpNotifications",
  "toolInfoFromToolUse",
  "toolUpdateFromToolResult",
  "toolUpdateFromDiffToolResponse",
  "planEntries",
  "taskStateToPlanEntries",
  "getSessionMessages",
  "replaySessionHistory",
  "createSession",
  "prompt",
  "cancel",
  "setPermissionMode",
  "canUseTool",
  "claudeCliPath",
  "streamEventToAcpNotifications",
];

const TARGET_UNIVERSE = new Set([
  "011", "012", "013", "014", "015", "018",
  "019", "020", "021", "023", "026", "030", "032", "034",
]);

// R4.1 (1): the table holds EXACTLY 20 data rows — no missing/extra rows.
test("seam-map (R4.1): the table enumerates exactly 20 rows (12 KEEP + 6 CUT + 1 REWRITE + 1 DEAD)", () => {
  const rows = parseRows(seamMap).filter((r) => r.symbol !== "Symbol");
  assert.equal(
    rows.length,
    20,
    `SEAM-MAP.md: expected exactly 20 data rows, found ${rows.length}`,
  );
});

// R4.1 (2): the DISTINCT base-symbol set across all rows equals EXACTLY the 19
// authoritative names — no missing, no extra, no identifier outside the set.
test("seam-map (R4.1): the distinct base-symbol set equals exactly the authoritative 19", () => {
  const rows = parseRows(seamMap);
  const distinct = new Set<string>();
  for (const row of rows) {
    for (const ident of baseSymbolsOf(row.symbol)) distinct.add(ident);
  }
  const expected = new Set(EXPECTED_BASE_SYMBOLS);

  const missing = [...expected].filter((s) => !distinct.has(s));
  const extra = [...distinct].filter((s) => !expected.has(s));

  assert.deepEqual(
    missing,
    [],
    `SEAM-MAP.md: missing expected base symbols: ${JSON.stringify(missing)}`,
  );
  assert.deepEqual(
    extra,
    [],
    `SEAM-MAP.md: unexpected base symbols (not in the authoritative 19): ${JSON.stringify(extra)}`,
  );
  assert.equal(
    distinct.size,
    19,
    `SEAM-MAP.md: expected exactly 19 distinct base symbols, found ${distinct.size} (${JSON.stringify([...distinct].sort())})`,
  );
});

// R4.1 (3): every row's Verdict class is one of {KEEP, CUT, REWRITE, DEAD};
// DEAD iff the Verdict cell contains "DEAD" (the streamEventToAcpNotifications row).
test("seam-map (R4.1): every row's verdict is one of {KEEP, CUT, REWRITE, DEAD}", () => {
  const allowed = new Set(["KEEP", "CUT", "REWRITE", "DEAD"]);
  for (const row of parseRows(seamMap).filter((r) => r.symbol !== "Symbol")) {
    const cls = verdictClass(row);
    assert.ok(
      allowed.has(cls),
      `SEAM-MAP.md: row '${row.symbol}' has verdict class '${cls}' (cell '${row.verdict}'), expected one of {KEEP,CUT,REWRITE,DEAD}`,
    );
  }
  // And exactly one DEAD row — the streamEventToAcpNotifications exception.
  const deadRows = parseRows(seamMap)
    .filter((r) => r.symbol !== "Symbol")
    .filter((r) => verdictClass(r) === "DEAD");
  assert.equal(
    deadRows.length,
    1,
    `SEAM-MAP.md: expected exactly one DEAD row, found ${deadRows.length}`,
  );
  assert.ok(
    deadRows[0].symbol.includes("`streamEventToAcpNotifications`"),
    `SEAM-MAP.md: the DEAD row should be 'streamEventToAcpNotifications', got '${deadRows[0].symbol}'`,
  );
});

// R4.1 (4a): every Target token is inside the allowed story universe.
test("seam-map (R4.1): every Target token is in the allowed story universe", () => {
  for (const row of parseRows(seamMap).filter((r) => r.symbol !== "Symbol")) {
    const tokens = targetTokens(row.target);
    assert.ok(
      tokens.length > 0,
      `SEAM-MAP.md: row '${row.symbol}' has no 3-digit Target token (cell '${row.target}')`,
    );
    for (const tok of tokens) {
      assert.ok(
        TARGET_UNIVERSE.has(tok),
        `SEAM-MAP.md: row '${row.symbol}' Target token '${tok}' is outside the allowed universe {${[...TARGET_UNIVERSE].join(",")}}`,
      );
    }
  }
});

// R4.1 (4b): every Target matches the AUTHORITATIVE per-symbol mapping from the
// contract. Each rule is keyed by a row locator and checks the row's Target
// tokens. The REWRITE row is located by its verdict (its Symbol cell is the
// `createSession + prompt()` composite); the two CUT rows for createSession /
// prompt are located by rowFor on the bare identifier.
test("seam-map (R4.1): every Target matches the authoritative per-symbol mapping", () => {
  // exact-set helpers over a row's Target tokens
  const tokensFor = (row: SeamRow | undefined): string[] =>
    row ? targetTokens(row.target) : [];
  const hasAll = (row: SeamRow | undefined, ...wanted: string[]): boolean => {
    const set = new Set(tokensFor(row));
    return wanted.every((w) => set.has(w));
  };
  const isExactly = (row: SeamRow | undefined, ...wanted: string[]): boolean => {
    const set = new Set(tokensFor(row));
    return set.size === wanted.length && wanted.every((w) => set.has(w));
  };

  // KEEP transport → 011 (exactly)
  for (const sym of ["runAcp", "ndJsonStream", "AgentSideConnection", "initialize"]) {
    const row = rowFor(seamMap, sym);
    assert.ok(row, `SEAM-MAP.md: no row for '${sym}'`);
    assert.ok(
      isExactly(row, "011"),
      `SEAM-MAP.md: '${sym}' Target is '${row.target}', expected exactly '011'`,
    );
  }

  // toAcpNotifications → must contain 018 (cell "018/019/020")
  {
    const row = rowFor(seamMap, "toAcpNotifications");
    assert.ok(row, "SEAM-MAP.md: no row for 'toAcpNotifications'");
    assert.ok(
      hasAll(row, "018"),
      `SEAM-MAP.md: 'toAcpNotifications' Target is '${row.target}', expected to contain '018'`,
    );
  }

  // tool_use / tool_result translators → 019 (exactly)
  for (const sym of ["toolInfoFromToolUse", "toolUpdateFromToolResult"]) {
    const row = rowFor(seamMap, sym);
    assert.ok(row, `SEAM-MAP.md: no row for '${sym}'`);
    assert.ok(
      isExactly(row, "019"),
      `SEAM-MAP.md: '${sym}' Target is '${row.target}', expected exactly '019'`,
    );
  }

  // plan translators → 020 (exactly)
  for (const sym of ["planEntries", "taskStateToPlanEntries"]) {
    const row = rowFor(seamMap, sym);
    assert.ok(row, `SEAM-MAP.md: no row for '${sym}'`);
    assert.ok(
      isExactly(row, "020"),
      `SEAM-MAP.md: '${sym}' Target is '${row.target}', expected exactly '020'`,
    );
  }

  // diff translator (KEEP) → 021 (exactly) — wired by the diff-source rewrite story
  {
    const row = rowFor(seamMap, "toolUpdateFromDiffToolResponse");
    assert.ok(row, "SEAM-MAP.md: no row for 'toolUpdateFromDiffToolResponse'");
    assert.ok(
      isExactly(row, "021"),
      `SEAM-MAP.md: 'toolUpdateFromDiffToolResponse' Target is '${row.target}', expected exactly '021'`,
    );
  }

  // getSessionMessages (KEEP, reused LIVE) → must contain BOTH 015 and 023
  {
    const row = rowFor(seamMap, "getSessionMessages");
    assert.ok(row, "SEAM-MAP.md: no row for 'getSessionMessages'");
    assert.ok(
      hasAll(row, "015", "023"),
      `SEAM-MAP.md: 'getSessionMessages' Target is '${row.target}', expected to contain both '015' and '023'`,
    );
  }

  // replaySessionHistory → 026 (exactly)
  {
    const row = rowFor(seamMap, "replaySessionHistory");
    assert.ok(row, "SEAM-MAP.md: no row for 'replaySessionHistory'");
    assert.ok(
      isExactly(row, "026"),
      `SEAM-MAP.md: 'replaySessionHistory' Target is '${row.target}', expected exactly '026'`,
    );
  }

  // CUT createSession → 023 ; CUT prompt → 023 (each exactly). rowFor matches the
  // bare-identifier CUT rows, never the `createSession + prompt()` REWRITE composite.
  for (const sym of ["createSession", "prompt"]) {
    const row = rowFor(seamMap, sym);
    assert.ok(row, `SEAM-MAP.md: no row for '${sym}'`);
    assert.equal(
      row.verdict,
      "CUT",
      `SEAM-MAP.md: '${sym}' verdict is '${row.verdict}', expected 'CUT'`,
    );
    assert.ok(
      isExactly(row, "023"),
      `SEAM-MAP.md: '${sym}' (CUT) Target is '${row.target}', expected exactly '023'`,
    );
  }

  // the REWRITE row (createSession + prompt() composite) → 023 (exactly)
  {
    const rewriteRows = rowsByVerdict(seamMap, "REWRITE");
    assert.equal(
      rewriteRows.length,
      1,
      `SEAM-MAP.md: expected exactly one REWRITE row, found ${rewriteRows.length}`,
    );
    const row = rewriteRows[0];
    assert.deepEqual(
      baseSymbolsOf(row.symbol).sort(),
      ["createSession", "prompt"],
      `SEAM-MAP.md: REWRITE row Symbol cell '${row.symbol}' should reference exactly createSession + prompt`,
    );
    assert.ok(
      isExactly(row, "023"),
      `SEAM-MAP.md: REWRITE row Target is '${row.target}', expected exactly '023'`,
    );
  }

  // cancel → 030 (exactly)
  {
    const row = rowFor(seamMap, "cancel");
    assert.ok(row, "SEAM-MAP.md: no row for 'cancel'");
    assert.ok(
      isExactly(row, "030"),
      `SEAM-MAP.md: 'cancel' Target is '${row.target}', expected exactly '030'`,
    );
  }

  // setPermissionMode / canUseTool → 032 (each exactly)
  for (const sym of ["setPermissionMode", "canUseTool"]) {
    const row = rowFor(seamMap, sym);
    assert.ok(row, `SEAM-MAP.md: no row for '${sym}'`);
    assert.ok(
      isExactly(row, "032"),
      `SEAM-MAP.md: '${sym}' Target is '${row.target}', expected exactly '032'`,
    );
  }

  // claudeCliPath → 012 (exactly)
  {
    const row = rowFor(seamMap, "claudeCliPath");
    assert.ok(row, "SEAM-MAP.md: no row for 'claudeCliPath'");
    assert.ok(
      isExactly(row, "012"),
      `SEAM-MAP.md: 'claudeCliPath' Target is '${row.target}', expected exactly '012'`,
    );
  }

  // streamEventToAcpNotifications (DEAD) → 034 (exactly)
  {
    const row = rowFor(seamMap, "streamEventToAcpNotifications");
    assert.ok(row, "SEAM-MAP.md: no row for 'streamEventToAcpNotifications'");
    assert.equal(
      verdictClass(row),
      "DEAD",
      `SEAM-MAP.md: 'streamEventToAcpNotifications' verdict class is '${verdictClass(row)}', expected 'DEAD'`,
    );
    assert.ok(
      isExactly(row, "034"),
      `SEAM-MAP.md: 'streamEventToAcpNotifications' Target is '${row.target}', expected exactly '034'`,
    );
  }
});

// --- R4.2: the prior-art note cites the PTY engine spawn/lifecycle source ------
// The engine's spawn + lifecycle design REUSES proven PTY patterns from named
// prior art (§4 "Prior art PTY (siteboon, markes76, Glyphic) REUSA padrões"; §5)
// rather than inventing them, attributed to the engine-spawn/lifecycle stories
// 013 and 014. The note is PROSE below the table (not a table row), so it is read
// from the document text directly.
//
// We assert against the FULL document text rather than slicing a "Prior art"
// section: the five prior-art tokens are UNIQUE to the note. `siteboon`,
// `markes76`, and `Glyphic` are named only in the note, and the story tokens
// `013`/`014` appear nowhere else in SEAM-MAP.md (the table targets are
// 011/012/015/018/019/020/021/023/026/030/032/034). So a whole-document
// `.includes` cannot be satisfied by a stray token elsewhere, and it sidesteps
// the fragile heading-boundary slicing that previously collapsed the section.

// R4.2 (a): the prior-art note names all three sources — siteboon, markes76, Glyphic.
test("seam-map (R4.2): the prior-art note names siteboon, markes76, and Glyphic", () => {
  for (const source of ["siteboon", "markes76", "Glyphic"]) {
    assert.ok(
      seamMap.includes(source),
      `SEAM-MAP.md: prior-art note must name '${source}' as a PTY reuse-patterns source`,
    );
  }
});

// R4.2 (b): the prior-art note references BOTH engine-spawn/lifecycle stories 013 and 014.
test("seam-map (R4.2): the prior-art note references both story 013 and story 014", () => {
  for (const story of ["013", "014"]) {
    assert.ok(
      seamMap.includes(story),
      `SEAM-MAP.md: prior-art note must reference story '${story}' (engine spawn/lifecycle)`,
    );
  }
});
