import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const forkRoot = join(here, "..");

function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(forkRoot, rel), "utf8"));
}

const pkg = readJson("package.json");
const deps = (pkg.dependencies ?? {}) as Record<string, string>;

// --- Task 2.1: kept ACP + reused-SDK deps pinned exactly (no caret/tilde) ---

test("fork deps: @agentclientprotocol/sdk pinned exactly to 0.22.1, no range (R2.1)", () => {
  assert.equal(deps["@agentclientprotocol/sdk"], "0.22.1");
  assert.doesNotMatch(deps["@agentclientprotocol/sdk"] ?? "", /[\^~]/);
});

test("fork deps: @anthropic-ai/claude-agent-sdk pinned exactly to 0.3.166, no range (R2.2)", () => {
  assert.equal(deps["@anthropic-ai/claude-agent-sdk"], "0.3.166");
  assert.doesNotMatch(deps["@anthropic-ai/claude-agent-sdk"] ?? "", /[\^~]/);
});

// --- Task 2.2: node-pty is the only extra runtime dep vs upstream v0.39.0 ---

test("fork deps: node-pty present in dependencies, no range (R2.3)", () => {
  assert.ok("node-pty" in deps, "node-pty must be a runtime dependency");
  assert.doesNotMatch(deps["node-pty"] ?? "", /[\^~]/);
});

test("fork deps: node-pty is the ONLY dependency key added vs upstream v0.39.0 (R2.3)", () => {
  const provenance = readJson(".fork-provenance.json");
  const upstreamKeys = provenance.upstreamDependencyKeys as string[] | undefined;
  assert.ok(
    Array.isArray(upstreamKeys) && upstreamKeys.length > 0,
    "the upstream v0.39.0 dependency-key baseline must be frozen in provenance",
  );
  const current = new Set(Object.keys(deps));
  const upstream = new Set(upstreamKeys);
  const added = [...current].filter((k) => !upstream.has(k)).sort();
  const removed = [...upstream].filter((k) => !current.has(k)).sort();
  assert.deepEqual(added, ["node-pty"], "exactly one dependency key added: node-pty");
  assert.deepEqual(removed, [], "no upstream dependency key removed");
});
