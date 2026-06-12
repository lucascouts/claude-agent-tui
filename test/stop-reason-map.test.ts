// Story 024 / Task 4.1 — map raw message.stop_reason to the ACP stopReason taxonomy (R3).
//
// ACP StopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled".
// mapStopReason is TOTAL (never throws): end_turn/stop_sequence → end_turn, max_tokens → max_tokens,
// refusal → refusal; any unrecognized NON-NULL variant defaults to a defined fallback (end_turn) AND
// logs the raw value for drift telemetry rather than silently dropping it.
//
// node:test runner: `node --experimental-strip-types --test test/stop-reason-map.test.ts`
import { test } from "node:test";
import assert from "node:assert/strict";
import { mapStopReason } from "../dist/stop-reason-map.js";

test("end_turn and stop_sequence map to ACP end_turn", () => {
  assert.equal(mapStopReason("end_turn"), "end_turn");
  assert.equal(mapStopReason("stop_sequence"), "end_turn");
});

test("max_tokens maps to ACP max_tokens", () => {
  assert.equal(mapStopReason("max_tokens"), "max_tokens");
});

test("refusal maps to ACP refusal", () => {
  assert.equal(mapStopReason("refusal"), "refusal");
});

test("an unknown non-null variant returns the defined fallback AND logs the raw value", () => {
  const logs: unknown[][] = [];
  const out = mapStopReason("some_future_variant", { error: (...a: unknown[]) => logs.push(a) });
  assert.equal(out, "end_turn", "unknown variant defaults to end_turn");
  assert.equal(logs.length, 1, "the raw unmapped value is logged for drift telemetry");
  assert.ok(
    logs[0].some((a) => String(a).includes("some_future_variant")),
    "the raw value appears in the log",
  );
});

test("mapStopReason is total — never throws and does not log on null/undefined/non-string", () => {
  const logs: unknown[][] = [];
  const sink = { error: (...a: unknown[]) => logs.push(a) };
  assert.equal(mapStopReason(null, sink), "end_turn");
  assert.equal(mapStopReason(undefined, sink), "end_turn");
  assert.equal(mapStopReason(123, sink), "end_turn"); // non-null non-string → logged drift
  // null/undefined are absence, not drift — only the numeric non-null value logs
  assert.equal(logs.length, 1, "only the non-null 123 is logged, not null/undefined");
});
