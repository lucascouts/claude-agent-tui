import { test } from "node:test";
import assert from "node:assert/strict";
import { usageUpdatesFor } from "../dist/usage.js";

// Story 025 / Task 3.1 (R3.1) — usageUpdatesFor is the feature-flag gate for the optional
// UNSTABLE usage_update notification. It defaults OFF: with the flag off (the default) it
// constructs NOTHING — a no-op, not a suppressed-after-build — so the turn's session/update
// stream is byte-for-byte unaffected; with the flag on it appends a single usage_update
// when the message carries usage tokens. The flag STAYS off in production until the
// live-Zed acceptance probe (Task 3.3, R8) confirms the user's Zed tolerates it.

const withUsage = { usage: { input_tokens: 100, output_tokens: 30 } };

test("usageUpdatesFor: flag OFF (default) constructs zero usage_update even with usage tokens (R3.1)", () => {
  assert.deepEqual(usageUpdatesFor(withUsage), [], "no options -> default OFF -> nothing");
  assert.deepEqual(usageUpdatesFor(withUsage, {}), [], "empty options -> default OFF -> nothing");
  assert.deepEqual(usageUpdatesFor(withUsage, { usageUpdate: false }), [], "explicit OFF -> nothing");
});

test("usageUpdatesFor: flag ON constructs at least one usage_update when usage tokens present (R3.1)", () => {
  const out = usageUpdatesFor(withUsage, { usageUpdate: true });
  assert.equal(out.length, 1, "flag on + usage tokens -> exactly one usage_update");
  assert.equal(out[0].sessionUpdate, "usage_update");
  assert.equal(out[0].used, 130);
});

test("usageUpdatesFor: flag ON but no usage tokens still constructs nothing (best-effort)", () => {
  assert.deepEqual(usageUpdatesFor({}, { usageUpdate: true }), []);
});
