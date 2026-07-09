import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Durable provenance source. The upstream `.git` is removed at vendor time
// (the fork is vendored into the project repo), so origin/tag/SHA can no longer
// be read via `git describe` / `git rev-parse v0.53.0` in regression. Task 1
// verifies those against the live upstream `.git` at vendor time and freezes the
// result here. See FORK.md and the story 009 deviation register.
const here = dirname(fileURLToPath(import.meta.url));
const provenancePath = join(here, "..", ".fork-provenance.json");

function readProvenance(): Record<string, unknown> {
  return JSON.parse(readFileSync(provenancePath, "utf8"));
}

test("fork origin: clone URL host/org is agentclientprotocol/claude-agent-acp (R1.1)", () => {
  const p = readProvenance();
  assert.match(String(p.url), /github\.com\/agentclientprotocol\/claude-agent-acp/);
  assert.equal(p.org, "agentclientprotocol/claude-agent-acp");
});

test("fork origin: records the redirect from the old zed-industries/claude-code-acp name (R1.2)", () => {
  const p = readProvenance();
  assert.equal(p.redirectFrom, "zed-industries/claude-code-acp");
});

test("fork origin: checked-out tag is v0.57.0 (R1.1)", () => {
  const p = readProvenance();
  assert.equal(p.tag, "v0.57.0");
});
