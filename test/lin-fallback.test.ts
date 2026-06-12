// Story 017 / Task 1.3 — Specify the equivalent chain-builder fallback (R1.3).
//
// `buildChainEquivalent(rawLines)` is the CONTINGENCY mirror of getSessionMessages for the case a
// future binary makes the SDK linearization unavailable/non-equivalent for the live path. It walks
// the parentUuid chain over RAW JSONL lines (where parentUuid/isSidechain/isMeta actually exist),
// filtering isSidechain/isMeta and following the surviving chain to the latest tip. It is GATED OFF
// by default — it is NOT the v1 path (E5 REUSE-live is). The equivalence test asserts byte-identical
// turn order between the SDK path and the fallback on a shared fixture.
//
// node:test runner: `node --experimental-strip-types --test test/lin-fallback.test.ts`
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChainEquivalent } from "../dist/linearize.js";

// A shared fixture: RAW JSONL lines (full shape: parentUuid + isSidechain/isMeta) AND the reduced
// SDK output the same transcript would yield (main chain only, chronological).
const RAW_LINES = [
  JSON.stringify({ type: "user", uuid: "u1", parentUuid: null, message: { content: [] } }),
  JSON.stringify({ type: "assistant", uuid: "a1", parentUuid: "u1", message: { content: [] } }),
  JSON.stringify({ type: "system", uuid: "meta1", parentUuid: "a1", isMeta: true, message: {} }),
  JSON.stringify({ type: "assistant", uuid: "side1", parentUuid: "a1", isSidechain: true, message: {} }),
  JSON.stringify({ type: "user", uuid: "u2", parentUuid: "a1", message: { content: [] } }),
  JSON.stringify({ type: "assistant", uuid: "a2", parentUuid: "u2", message: { content: [] } }),
];

// What getSessionMessages returns for the same transcript: the filtered main chain, in order.
const SDK_OUTPUT = [
  { type: "user", uuid: "u1", session_id: "s", message: { content: [] }, parent_tool_use_id: null },
  { type: "assistant", uuid: "a1", session_id: "s", message: { content: [] }, parent_tool_use_id: null },
  { type: "user", uuid: "u2", session_id: "s", message: { content: [] }, parent_tool_use_id: null },
  { type: "assistant", uuid: "a2", session_id: "s", message: { content: [] }, parent_tool_use_id: null },
];

test("buildChainEquivalent is GATED OFF by default (contingency-only, not v1)", () => {
  assert.throws(() => buildChainEquivalent(RAW_LINES), /disabled|contingency|enabled/i);
});

test("fallback turn order is byte-identical to the SDK path on the shared fixture", () => {
  const fallback = buildChainEquivalent(RAW_LINES, { enabled: true });
  assert.deepEqual(
    fallback.map((m) => m.uuid),
    SDK_OUTPUT.map((m) => m.uuid),
  );
});

test("fallback excludes isSidechain and isMeta from the main chain (mirrors the SDK filter)", () => {
  const fallback = buildChainEquivalent(RAW_LINES, { enabled: true });
  const uuids = fallback.map((m) => m.uuid);
  assert.ok(!uuids.includes("side1"), "sidechain row must be filtered");
  assert.ok(!uuids.includes("meta1"), "meta row must be filtered");
});

test("fallback follows the surviving chain to the latest tip (abandoned fork branch dropped)", () => {
  // a1 has TWO children: an abandoned branch (uX) and the surviving one (u2 → a2, the latest tip).
  const forked = [
    JSON.stringify({ type: "user", uuid: "u1", parentUuid: null, message: { content: [] } }),
    JSON.stringify({ type: "assistant", uuid: "a1", parentUuid: "u1", message: { content: [] } }),
    JSON.stringify({ type: "user", uuid: "uX", parentUuid: "a1", message: { content: [] } }), // abandoned
    JSON.stringify({ type: "user", uuid: "u2", parentUuid: "a1", message: { content: [] } }),
    JSON.stringify({ type: "assistant", uuid: "a2", parentUuid: "u2", message: { content: [] } }),
  ];
  const fallback = buildChainEquivalent(forked, { enabled: true });
  assert.deepEqual(
    fallback.map((m) => m.uuid),
    ["u1", "a1", "u2", "a2"],
  );
  assert.ok(!fallback.map((m) => m.uuid).includes("uX"), "abandoned branch must not appear");
});
