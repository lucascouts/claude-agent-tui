import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Story 080 (R2.1/R2.2) — each tree carries three version records that answer
// three DIFFERENT questions, so they are not expected to be equal. What is
// invariant is the RELATIONSHIP between them, and that is what this file pins.
//
// The drift this guards against already happened: fork/.release-please-manifest.json
// sat at 0.39.0 from the original vendoring commit (300b541) while
// .fork-provenance.json was re-anchored twice — story 070 to v0.53.0, story 074
// to v0.57.0 — and nothing carried the upstream-tracking records along. The
// normative statement of what each record governs lives in
// .fork-provenance.json#versionRecords, with the prose in docs/FORK.md.
//
// This file is byte-identical in both trees; it branches on the tree it finds
// itself in, because the manifest means different things on each side.

const here = dirname(fileURLToPath(import.meta.url));
const treeRoot = join(here, "..");

function readJson(name: string): Record<string, any> {
  return JSON.parse(readFileSync(join(treeRoot, name), "utf8"));
}

// Both trees publish under the same package `name` (@lucascouts/claude-agent-tui),
// so `name` cannot discriminate them. The `bin` key can: the fork keeps the
// upstream identity (claude-agent-acp), the mirror the published one.
function isForkTree(): boolean {
  const pkg = readJson("package.json");
  return Object.keys(pkg.bin ?? {}).includes("claude-agent-acp");
}

/** Newest release-please entry — the first `## [x.y.z]` heading in CHANGELOG.md. */
function newestChangelogVersion(): string {
  const md = readFileSync(join(treeRoot, "CHANGELOG.md"), "utf8");
  const m = md.match(/^## \[(\d+\.\d+\.\d+)\]/m);
  assert.ok(m, "CHANGELOG.md carries no `## [x.y.z]` release-please heading");
  return m![1];
}

test("version records: .fork-provenance.json carries the normative versionRecords block (R2.1)", () => {
  const p = readJson(".fork-provenance.json");
  const vr = p.versionRecords;
  assert.ok(vr, ".fork-provenance.json must carry a versionRecords block (story 080, R2.1)");
  assert.deepEqual(
    Object.keys(vr).sort(),
    ["forkProvenanceTag", "note", "packageJsonVersion", "releasePleaseManifest"],
    "versionRecords must document exactly the three records plus its own note",
  );
  for (const [key, value] of Object.entries(vr)) {
    assert.equal(typeof value, "string", `versionRecords.${key} must be a string`);
    assert.ok(
      (value as string).length > 40,
      `versionRecords.${key} must actually state what the record governs, not a placeholder`,
    );
  }
});

test("version records: the release-please manifest matches CHANGELOG's newest entry (R2.2)", () => {
  // True in BOTH trees: release-please writes the manifest and the changelog as
  // a pair, so a manifest bump that leaves the changelog behind is drift.
  const manifest = readJson(".release-please-manifest.json");
  assert.equal(
    manifest["."],
    newestChangelogVersion(),
    "the release-please manifest and CHANGELOG.md's newest entry must name the same version",
  );
});

test("version records: the fork tree's upstream-tracking manifest equals the vendored fork point (R2.2)", (t) => {
  if (!isForkTree()) {
    return t.skip("mirror tree: its manifest is release-please-owned, not upstream-tracking");
  }
  const manifest = readJson(".release-please-manifest.json");
  const tag = String(readJson(".fork-provenance.json").tag);
  assert.match(tag, /^v\d+\.\d+\.\d+$/, ".fork-provenance.json tag must be a vX.Y.Z upstream tag");
  assert.equal(
    manifest["."],
    tag.slice(1),
    `the fork tree's .release-please-manifest.json is an upstream-tracking record: it must equal the vendored fork point ${tag}`,
  );
});

test("version records: the mirror tree's manifest equals its published package version (R2.3)", (t) => {
  if (isForkTree()) {
    return t.skip("fork tree: its package.json version is inert — the fork is never published");
  }
  const manifest = readJson(".release-please-manifest.json");
  assert.equal(
    manifest["."],
    readJson("package.json").version,
    "in the mirror both records are release-please-owned and must agree",
  );
});

test("version records: docs/FORK.md 'Origin and frozen commit' states the anchored tag and sha (R2.2)", (t) => {
  if (!isForkTree()) {
    return t.skip("mirror tree: ships standalone without docs/FORK.md");
  }
  const forkMd = join(treeRoot, "..", "docs", "FORK.md");
  if (!existsSync(forkMd)) {
    return t.skip("docs/FORK.md not reachable from this checkout");
  }
  const p = readJson(".fork-provenance.json");
  const md = readFileSync(forkMd, "utf8");
  const start = md.indexOf("## Origin and frozen commit");
  assert.ok(start >= 0, "docs/FORK.md must keep its `## Origin and frozen commit` section");
  const rest = md.slice(start);
  const end = rest.indexOf("\n## ", 1);
  const block = end >= 0 ? rest.slice(0, end) : rest;
  assert.ok(
    block.includes(String(p.tag)),
    `docs/FORK.md 'Origin and frozen commit' must name the anchored tag ${p.tag}`,
  );
  assert.ok(
    block.includes(String(p.sha)),
    `docs/FORK.md 'Origin and frozen commit' must name the anchored sha ${p.sha}`,
  );
});
