import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Story 080 (R1.2, R1.3) — the supported Node floor, stated once and pinned here.
//
// The audit found it stated three ways that disagreed: `engines.node` said >=20,
// the mirror README said >=23, and upstream v0.65.0 said >=22. `npm install`
// therefore succeeded on Node 20, where the suite cannot run at all — the runner
// is `node --experimental-strip-types`, a flag that only exists from Node 22.6.
//
// SUPPORTED_FLOOR is a SUPPORT POLICY, not a measured minimum: the project
// targets the active LTS line. It is backed by a clean-room container run
// recorded under "## Floor findings" in the story — a fresh `git clone` with no
// host node_modules or dist/, then `npm ci` -> `npm run build` -> `npm test`
// green in BOTH trees on node:24 (digest sha256:934240a1..., Node v24.19.0).
//
// This file is byte-identical in both trees. The cross-tree and README checks
// resolve through the monorepo layout and skip when the sibling is not reachable,
// so the published mirror stays green standing alone.

const SUPPORTED_FLOOR = ">=24";

/**
 * Lowest major admitted by a floor expression: ">=24" -> 24.
 * The manifests use a bare `>=X` range; anything richer would need semver, and
 * pulling in a dependency to parse our own one-line policy is not worth it.
 */
function floorMajor(range: string): number {
  const m = range.match(/(\d+)/);
  assert.ok(m, `engines.node must state a major version, got ${JSON.stringify(range)}`);
  return Number(m![1]);
}

const here = dirname(fileURLToPath(import.meta.url));
const treeRoot = join(here, "..");
const repoRoot = join(treeRoot, "..");

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** The mirror README is the only place the floor is stated in prose. */
function mirrorReadmePath(): string | null {
  for (const candidate of [
    join(repoRoot, "claude-agent-tui", "README.md"),
    join(treeRoot, "README.md"),
  ]) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

test("engine floor: this tree's engines.node is the recorded floor (R1.2)", () => {
  const pkg = readJson(join(treeRoot, "package.json"));
  assert.equal(
    pkg.engines?.node,
    SUPPORTED_FLOOR,
    "engines.node must equal the floor proven green by the clean-room run in ## Floor findings",
  );
});

test("engine floor: both trees declare the same engines.node (R1.2)", (t) => {
  const forkPkg = join(repoRoot, "fork", "package.json");
  const mirrorPkg = join(repoRoot, "claude-agent-tui", "package.json");
  if (!existsSync(forkPkg) || !existsSync(mirrorPkg)) {
    return t.skip("sibling tree not reachable — this is a standalone checkout");
  }
  assert.equal(
    readJson(forkPkg).engines?.node,
    readJson(mirrorPkg).engines?.node,
    "the two trees must not disagree about the supported Node version",
  );
});

test("engine floor: the mirror README states the same floor as engines.node (R1.3)", (t) => {
  const readme = mirrorReadmePath();
  if (readme === null) {
    return t.skip("mirror README not reachable from this checkout");
  }
  const stated = readFileSync(readme, "utf8").match(/Node\.js\s*(?:≥|>=)\s*(\d+)/);
  assert.ok(stated, "the mirror README must state a Node requirement as `Node.js ≥ N`");
  assert.equal(
    Number(stated![1]),
    floorMajor(SUPPORTED_FLOOR),
    "the README's prose requirement and engines.node must name the same major",
  );
});

test("engine floor: the floor actually admits the test runner's flag (R1.1)", () => {
  // Why a bare `>=22` is not enough, and the sharpest argument for diverging from
  // upstream: `--experimental-strip-types` landed in Node 22.6, so `>=22` still
  // admits 22.0-22.5, where `npm test` cannot start. Only a floor of 23 or higher
  // makes the manifest's promise true for EVERY version it admits. The assertion
  // is conditional on the runner still using the flag.
  const pkg = readJson(join(treeRoot, "package.json"));
  const scripts: Record<string, string> = pkg.scripts ?? {};
  const usesStripTypes = Object.values(scripts).some((s) =>
    s.includes("--experimental-strip-types"),
  );
  if (!usesStripTypes) {
    return; // constraint gone; the floor is then a pure support policy
  }
  assert.ok(
    floorMajor(SUPPORTED_FLOOR) >= 23,
    "a floor of 22 admits 22.0-22.5, which lack --experimental-strip-types — npm install would succeed where npm test cannot run",
  );
});
