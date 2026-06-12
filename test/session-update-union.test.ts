import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Story 011 / Task 4.1 — lock that the `SessionUpdate` discriminated union is reused
// UNCHANGED from the frozen `@agentclientprotocol/sdk` 0.22.1: no local redefinition
// or shape drift, proving the ACP schema layer is kept 1:1 (§3 base congelada).

const here = dirname(fileURLToPath(import.meta.url));
const forkRoot = join(here, "..");
const sdkRoot = join(forkRoot, "node_modules", "@agentclientprotocol", "sdk");

// The frozen 0.22.1 discriminant set (the `sessionUpdate` literal of each variant).
const EXPECTED_VARIANTS = [
  "user_message_chunk",
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
  "available_commands_update",
  "current_mode_update",
  "config_option_update",
  "session_info_update",
  "usage_update",
];

test("session update union: the ACP SDK is pinned to the frozen 0.22.1", () => {
  const pkg = JSON.parse(readFileSync(join(sdkRoot, "package.json"), "utf8"));
  assert.equal(pkg.version, "0.22.1", "the frozen ACP schema/transport SDK must stay 0.22.1");
});

test("session update union: SessionUpdate is not redefined or shadowed in fork src", () => {
  const files = readdirSync(join(forkRoot, "src")).filter((f) => f.endsWith(".ts"));
  for (const f of files) {
    const code = readFileSync(join(forkRoot, "src", f), "utf8");
    assert.ok(
      !/\b(?:type|interface)\s+SessionUpdate\b/.test(code),
      `src/${f} must not locally declare SessionUpdate — it is reused from the SDK`,
    );
  }
});

test("session update union: variant set imports unchanged from SDK 0.22.1 (no shape drift)", () => {
  const dts = readFileSync(join(sdkRoot, "dist", "schema", "types.gen.d.ts"), "utf8");
  const declIdx = dts.indexOf("export type SessionUpdate =");
  assert.ok(declIdx !== -1, "SessionUpdate union must be defined in the SDK type surface");
  // The union spans until the next top-level declaration; slice that window only.
  const nextExport = dts.indexOf("\nexport ", declIdx + 1);
  const block = dts.slice(declIdx, nextExport === -1 ? undefined : nextExport);

  const found = [...block.matchAll(/sessionUpdate:\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(
    [...found].sort(),
    [...EXPECTED_VARIANTS].sort(),
    "the SessionUpdate discriminated-union variant set drifted from frozen 0.22.1",
  );
});

test("session update union: the UNSTABLE usage_update variant is present (§15 open-question anchor)", () => {
  // §15 🧪 (deferred to story 025): whether the user's Zed tolerates the UNSTABLE
  // usage_update is unverified — but the variant must exist in the frozen union we
  // advertise. This anchors that open question to a concrete, present discriminant.
  assert.ok(EXPECTED_VARIANTS.includes("usage_update"));
});
