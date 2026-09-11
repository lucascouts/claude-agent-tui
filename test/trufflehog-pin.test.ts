import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// The trufflehog action is a ~40-line composite wrapper whose last step is
//
//   docker run --rm -v .:/tmp -w /tmp "${IMAGE}:${VERSION}" git file:///tmp/ ...
//
// and `action.yml` declares `version` with `default: "latest"`. Pinning `uses:` by
// commit SHA therefore pins the wrapper and leaves the scanner floating on a mutable
// tag -- a regression or compromise of `latest` reaches CI without passing through any
// PR, and no Dependabot bump records it. The workflow pins `version:` to close that.
//
// Dependabot updates `uses:` refs, not action inputs, so the next SHA bump will not
// touch the input. These tests are what notices: they fail when the two diverge,
// instead of relying on a reviewer remembering. See issue #97.

const here = dirname(fileURLToPath(import.meta.url));
const workflow = readFileSync(join(here, "..", ".github", "workflows", "ci.yml"), "utf8");

// The step's own lines, so a `version:` belonging to some other step can never be
// mistaken for this one.
function trufflehogStep(): string {
  const lines = workflow.split("\n");
  const start = lines.findIndex((l) => l.includes("uses: trufflesecurity/trufflehog@"));
  assert.notEqual(start, -1, "the CI workflow must still run the trufflehog action");
  const indent = lines[start].search(/\S/);
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line.trim() !== "" && line.search(/\S/) < indent) break;
    end++;
  }
  return lines.slice(start, end).join("\n");
}

test("trufflehog: the action is pinned by commit SHA, never a mutable tag", () => {
  const step = trufflehogStep();
  assert.match(
    step,
    /uses:\s*trufflesecurity\/trufflehog@[0-9a-f]{40}\s/,
    "the action must be pinned by a 40-character commit SHA",
  );
});

test("trufflehog: the scanner version is pinned, so the SHA is not the only pin", () => {
  const step = trufflehogStep();
  assert.match(
    step,
    /^\s*version:\s*"?\d+\.\d+\.\d+"?\s*$/m,
    "the action's `version` input must be set; its default is the mutable tag `latest`",
  );
});

test("trufflehog: the pinned scanner version matches the version the SHA comment names", () => {
  const step = trufflehogStep();

  const commented = /trufflesecurity\/trufflehog@[0-9a-f]{40}\s*#\s*v(\d+\.\d+\.\d+)/.exec(step);
  assert.ok(commented, "the pinned SHA must carry a `# vX.Y.Z` comment naming its release");

  const pinned = /^\s*version:\s*"?(\d+\.\d+\.\d+)"?\s*$/m.exec(step);
  assert.ok(pinned, "the action's `version` input must name a concrete release");

  assert.equal(
    pinned[1],
    commented[1],
    "the scanner version and the action release have diverged: a bump moved `uses:` " +
      "without moving `version:`, so CI runs a scanner older than the action it pins",
  );
});
