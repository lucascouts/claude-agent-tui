import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const forkRoot = join(here, "..");
const provenancePath = join(forkRoot, ".fork-provenance.json");

function readProvenance(): Record<string, unknown> {
  return JSON.parse(readFileSync(provenancePath, "utf8"));
}

test("fork sha: captured SHA is a 40-char lowercase hex string (R1.1)", () => {
  const p = readProvenance();
  assert.match(String(p.sha), /^[0-9a-f]{40}$/);
});

test("fork sha: vendor-time verified the SHA equals the v0.39.0 tag (R1.1)", () => {
  const p = readProvenance();
  // The upstream `.git` is removed when the fork is vendored into the project
  // repo, so `git rev-parse v0.39.0` cannot be re-run in regression. Task 1.2
  // performs that equality check against the live upstream `.git` at vendor time
  // and records the outcome as `tagShaVerified`. This pins the intent of the
  // original assertion (`git rev-parse v0.39.0` equals the captured SHA) durably.
  assert.equal(p.tagShaVerified, true);
});
