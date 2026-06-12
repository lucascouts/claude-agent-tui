// Story 036 / Task 1.2 (R2.1, R2.2, R2.3) — version-labelled fixture sets + drift presence.
//
// Asserts both the 2.1.121 and 2.1.159 fixture sets exist under version-labelled paths, are
// addressable by version label via the versions.json manifest (R2.3), and that at least one fixture
// DIFFERS between the two sets in JSONL format or in billing entrypoint taxonomy (R2.2 — drift present
// and attributable). Provenance honesty (synthetic vs real) is recorded in the manifest and asserted
// here so a reader cannot mistake the derived 2.1.121 set for a real binary capture.
//
// node:test runner: `node --experimental-strip-types --test test/fixtures-versions.test.ts`
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MANIFEST = new URL("./fixtures/versions.json", import.meta.url);

interface VersionEntry {
  version: string;
  path: string;
  synthetic: boolean;
  basis: string;
  entrypoint: string;
  driftNotes: string[];
}

function loadManifest(): { versions: VersionEntry[] } {
  return JSON.parse(readFileSync(MANIFEST, "utf8"));
}

/** Resolve a version label to its fixture rows via the manifest (the addressability seam, R2.3). */
function setForVersion(version: string): Array<Record<string, unknown>> {
  const { versions } = loadManifest();
  const entry = versions.find((v) => v.version === version);
  assert.ok(entry, `manifest must address version ${version}`);
  const url = new URL(`./fixtures/${entry!.path}`, import.meta.url);
  return readFileSync(url, "utf8")
    .trim()
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

// === R2.1 — both version sets exist under version-labelled paths ===============================

test("both 2.1.121 and 2.1.159 fixture sets exist under version-labelled paths (R2.1)", () => {
  for (const v of ["2.1.121", "2.1.159"]) {
    const url = new URL(`./fixtures/v${v}/session.jsonl`, import.meta.url);
    assert.ok(existsSync(fileURLToPath(url)), `v${v}/session.jsonl must exist`);
  }
});

// === R2.3 — each set is version-labelled and addressable by version ============================

test("each set is addressable by version label via versions.json (R2.3)", () => {
  const { versions } = loadManifest();
  const labels = versions.map((v) => v.version).sort();
  assert.deepEqual(labels, ["2.1.121", "2.1.159"], "manifest must label exactly the two anchor versions");
  // every line of each set carries its own version field too (self-labelled, not only via the index).
  for (const v of ["2.1.121", "2.1.159"]) {
    const rows = setForVersion(v);
    assert.ok(rows.length > 0, `set ${v} resolves to >0 rows by label`);
    assert.ok(
      rows.every((r) => r.version === v),
      `every row in set ${v} self-labels version:"${v}"`,
    );
  }
});

// === R2.2 — at least one fixture differs in format OR entrypoint taxonomy (drift present) =======

test("a drift-bearing fixture pair differs between the two sets in entrypoint taxonomy (R2.2)", () => {
  const set121 = setForVersion("2.1.121");
  const set159 = setForVersion("2.1.159");
  const ep = (rows: Array<Record<string, unknown>>) =>
    new Set(rows.filter((r) => r.type === "assistant" || r.type === "user").map((r) => r.entrypoint));
  const ep121 = ep(set121);
  const ep159 = ep(set159);
  // the two sets must NOT share the same entrypoint label set — that IS the taxonomy drift.
  assert.notDeepEqual([...ep121].sort(), [...ep159].sort(), "entrypoint taxonomy must differ between versions");
  assert.ok(ep159.has("cli"), "2.1.159 billable events carry the modern 'cli' label");
  assert.ok(!ep121.has("cli"), "2.1.121 billable events do NOT carry 'cli' (older taxonomy)");
});

test("a drift-bearing fixture pair differs between the two sets in JSONL content format (string vs array) (R2.2)", () => {
  const set121 = setForVersion("2.1.121");
  const set159 = setForVersion("2.1.159");
  const firstUserContent = (rows: Array<Record<string, unknown>>) =>
    (rows.find((r) => r.type === "user")!.message as { content?: unknown }).content;
  const c121 = firstUserContent(set121);
  const c159 = firstUserContent(set159);
  // format drift: 2.1.121's first user turn is a bare STRING; 2.1.159's is an ARRAY of blocks.
  assert.equal(typeof c121, "string", "2.1.121 first user content is a bare string (older format)");
  assert.ok(Array.isArray(c159), "2.1.159 first user content is an array of blocks (modern format)");
});

// === provenance honesty — the synthetic flag is recorded, not hidden ===========================

test("manifest records HONEST provenance — both sets flagged synthetic with a stated basis", () => {
  const { versions } = loadManifest();
  for (const v of versions) {
    assert.equal(v.synthetic, true, `set ${v.version} must be flagged synthetic (no real capture is faked)`);
    assert.ok(v.basis.length > 0, `set ${v.version} must state its derivation basis`);
    assert.ok(Array.isArray(v.driftNotes) && v.driftNotes.length > 0, `set ${v.version} must enumerate its drift notes`);
  }
});
