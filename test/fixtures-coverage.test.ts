// Story 036 / Task 1.1 (R1.1, R1.2, R1.3, R1.4) — the all-types fixture corpus + sanitization guard.
//
// This is a CONSOLIDATION test: it asserts the sanitized JSONL corpus under test/fixtures/
// covers the §16 breadth (≥14 distinct event types + all 5 content block types), includes a sidechain
// branch and a content string-vs-array pair, PRESERVES the pre-existing multi-turn.jsonl/no-signal.jsonl
// (R1.4), and that NO fixture line leaks a real cwd / absolute user path (R1.3). It authors no
// translation logic — it inventories the corpus the downstream suites (018–026) reuse.
//
// node:test runner: `node --experimental-strip-types --test test/fixtures-coverage.test.ts`
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ALL_TYPES = new URL("./fixtures/corpus-all-types.jsonl", import.meta.url);

/** Parse a JSONL fixture into row objects (one per non-blank line). */
function loadJsonl(url: URL): Array<Record<string, unknown>> {
  return readFileSync(url, "utf8")
    .trim()
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** All committed fixture files that make up the shared corpus (for the sanitization sweep). */
const CORPUS_FILES = [
  new URL("./fixtures/corpus-all-types.jsonl", import.meta.url),
  new URL("./fixtures/multi-turn.jsonl", import.meta.url),
  new URL("./fixtures/no-signal.jsonl", import.meta.url),
  new URL("./fixtures/v2.1.121/session.jsonl", import.meta.url),
  new URL("./fixtures/v2.1.159/session.jsonl", import.meta.url),
];

/** Pull every content block out of an array of rows (flattening message.content arrays). */
function blockTypes(rows: Array<Record<string, unknown>>): Set<string> {
  const out = new Set<string>();
  for (const r of rows) {
    const m = r.message as { content?: unknown } | undefined;
    if (m && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b && typeof b === "object" && typeof (b as { type?: unknown }).type === "string") {
          out.add((b as { type: string }).type);
        }
      }
    }
  }
  return out;
}

// === R1.1 — ≥14 distinct event types + all 5 content block types ===============================

test("corpus-all-types: covers ≥14 distinct JSONL event types (R1.1)", () => {
  const rows = loadJsonl(ALL_TYPES);
  const types = new Set(rows.map((r) => String(r.type)));
  assert.ok(
    types.size >= 14,
    `corpus must cover >=14 event types, found ${types.size}: ${[...types].sort().join(", ")}`,
  );
});

test("corpus-all-types: covers all 5 content block types (text, thinking, tool_use, tool_result, image) (R1.1)", () => {
  const rows = loadJsonl(ALL_TYPES);
  const blocks = blockTypes(rows);
  for (const required of ["text", "thinking", "tool_use", "tool_result", "image"]) {
    assert.ok(blocks.has(required), `corpus must contain a ${required} block; found ${[...blocks].join(", ")}`);
  }
});

// === R1.2 — a sidechain fixture + a content string-vs-array pair ================================

test("corpus-all-types: contains ≥1 sidechain branch (isSidechain:true in the parentUuid graph) (R1.2)", () => {
  const rows = loadJsonl(ALL_TYPES);
  const sidechains = rows.filter((r) => r.isSidechain === true);
  assert.ok(sidechains.length >= 1, "corpus must contain >=1 isSidechain row");
  // a sidechain branch must hang off a parent (parentUuid set) — it is a graph branch, not a root.
  assert.ok(
    sidechains.every((r) => r.parentUuid != null),
    "each sidechain row must reference a parentUuid (a branch, not a root)",
  );
});

test("corpus-all-types: contains BOTH a content-as-array and a content-as-string user message (R1.2)", () => {
  const rows = loadJsonl(ALL_TYPES);
  const userMsgs = rows.filter((r) => r.type === "user").map((r) => (r.message as { content?: unknown }).content);
  const hasArray = userMsgs.some((c) => Array.isArray(c));
  const hasString = userMsgs.some((c) => typeof c === "string");
  assert.ok(hasArray, "corpus must contain a user message whose message.content is an ARRAY of blocks");
  assert.ok(hasString, "corpus must contain a user message whose message.content is a bare STRING");
});

// === R1.4 — the pre-existing fixtures are PRESERVED (extend, not replace) =======================

test("pre-existing fixtures multi-turn.jsonl and no-signal.jsonl are preserved (R1.4)", () => {
  const multiTurn = new URL("./fixtures/multi-turn.jsonl", import.meta.url);
  const noSignal = new URL("./fixtures/no-signal.jsonl", import.meta.url);
  assert.ok(existsSync(fileURLToPath(multiTurn)), "multi-turn.jsonl must still exist (not replaced)");
  assert.ok(existsSync(fileURLToPath(noSignal)), "no-signal.jsonl must still exist (not replaced)");
  // both must still parse (untouched, still valid JSONL)
  assert.ok(loadJsonl(multiTurn).length > 0, "multi-turn.jsonl still parses");
  assert.ok(loadJsonl(noSignal).length > 0, "no-signal.jsonl still parses");
});

// === R1.3 — sanitization: NO leaked real cwd / absolute user path in any fixture line ===========

test("sanitization: no fixture line leaks a real absolute user path or raw home cwd (R1.3)", () => {
  // Patterns that would indicate an un-sanitized real capture leaked into the repo.
  const LEAK_PATTERNS = [/\/home\/[a-z]/i, /\/Users\/[A-Za-z]/, /\/root\//];
  for (const url of CORPUS_FILES) {
    const text = readFileSync(url, "utf8");
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      for (const pat of LEAK_PATTERNS) {
        assert.ok(
          !pat.test(line),
          `fixture ${url.pathname.split("/").pop()} line ${i + 1} leaks a real path matching ${pat}: ${line.slice(0, 120)}`,
        );
      }
    });
  }
});
