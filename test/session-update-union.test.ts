import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Story 011 / Task 4.1 (updated by story 045) — lock that the `SessionUpdate`
// discriminated union is reused 1:1 from `@agentclientprotocol/sdk` 0.25.0: no local
// redefinition or unexpected shape drift, proving the ACP schema layer is kept 1:1.

const here = dirname(fileURLToPath(import.meta.url));
const forkRoot = join(here, "..");
const sdkRoot = join(forkRoot, "node_modules", "@agentclientprotocol", "sdk");

// The 0.25.0 discriminant set (the `sessionUpdate` literal of each variant).
// 0.25.0 added `plan_update` and `plan_removed` to the union (additive vs 0.22.1);
// nothing was removed (story 045 — SDK migration).
const EXPECTED_VARIANTS = [
  "user_message_chunk",
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
  "plan_update",
  "plan_removed",
  "available_commands_update",
  "current_mode_update",
  "config_option_update",
  "session_info_update",
  "usage_update",
];

test("session update union: the ACP SDK is pinned to 0.25.0", () => {
  const pkg = JSON.parse(readFileSync(join(sdkRoot, "package.json"), "utf8"));
  assert.equal(pkg.version, "0.25.0", "the ACP schema/transport SDK is pinned at 0.25.0 (story 045)");
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

test("session update union: variant set matches SDK 0.25.0 (no unexpected shape drift)", () => {
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
    "the SessionUpdate discriminated-union variant set drifted from the expected 0.25.0 set",
  );
});

test("session update union: the UNSTABLE usage_update variant is present (§15 open-question anchor)", () => {
  // §15 🧪 (deferred to story 025): whether the user's Zed tolerates the UNSTABLE
  // usage_update is unverified — but the variant must exist in the frozen union we
  // advertise. This anchors that open question to a concrete, present discriminant.
  assert.ok(EXPECTED_VARIANTS.includes("usage_update"));
});
