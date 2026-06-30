// Story 042 / Task 1.2 (R1.2, R2.1, R2.2, R3.1) — PIN the emitted usage_update shape to the Zed v1
// `UsageUpdate` struct (story 039). The reused story-025 gate (usageUpdatesFor → toUsageUpdate,
// src/usage.ts) must emit EXACTLY `{ sessionUpdate: "usage_update", size, used }` — camelCase, no
// more keys — so this file asserts the object via deepEqual against a literal (any extra key,
// including a fabricated `cost`, FAILS), checks `used = input + output` and `size = contextWindowSize`,
// and pins the empty-array postures (no tokens; flag OFF).
//
// node:test runner: `node --experimental-strip-types --test test/usage-shape-contract.test.ts`
// (run `npm run build` first — the seam resolves against ../dist/usage.js, an INTERNAL fork module
// imported directly, NOT via lib.ts whose public surface is frozen to upstream v0.53.0).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { usageUpdatesFor, toUsageUpdate, type UsageCarrier } from "../dist/usage.js";

// A carrier shaped exactly like a JSONL message-event's usage block (only token counts — no cost).
const CARRIER: UsageCarrier = { usage: { input_tokens: 100, output_tokens: 30 } };
const WINDOW = 200000;

// === R2.1 / R2.2 / R3.1 — the emitted object is EXACTLY the pinned camelCase shape ================

test("flag ON + tokens → exactly ONE notification, shape == { sessionUpdate, size, used } (R2.1, R2.2)", () => {
  const result = usageUpdatesFor(CARRIER, { usageUpdate: true, contextWindowSize: WINDOW });

  assert.equal(result.length, 1, "flag ON + usage tokens → exactly one usage_update");
  // deepEqual against a LITERAL: any extra own-key (e.g. a fabricated `cost`) makes this FAIL.
  assert.deepEqual(
    result[0],
    { sessionUpdate: "usage_update", size: 200000, used: 130 },
    "the object must be EXACTLY { sessionUpdate, size, used } — no extra keys",
  );
});

test("used === input_tokens + output_tokens; size === contextWindowSize (R2.2)", () => {
  const result = usageUpdatesFor(CARRIER, { usageUpdate: true, contextWindowSize: WINDOW });
  assert.equal(result[0].used, 100 + 30, "used = input_tokens + output_tokens");
  assert.equal(result[0].size, WINDOW, "size = contextWindowSize (the inferred window), not `used`");
});

test("the optional `cost` field is OMITTED — never fabricated (R3.1)", () => {
  const result = usageUpdatesFor(CARRIER, { usageUpdate: true, contextWindowSize: WINDOW });
  assert.ok(!("cost" in result[0]), "usage_update must carry NO `cost` own-property");
  // also at the toUsageUpdate seam directly.
  const direct = toUsageUpdate(CARRIER, { contextWindowSize: WINDOW })!;
  assert.ok(!("cost" in direct), "toUsageUpdate must construct NO `cost` own-property");
});

// === R1.2 — never fabricate: no tokens → nothing; flag OFF → nothing ==============================

test("flag ON but NO usage tokens → [] (never fabricate) (R1.2)", () => {
  const noTokens: UsageCarrier = { usage: null };
  assert.deepEqual(
    usageUpdatesFor(noTokens, { usageUpdate: true, contextWindowSize: WINDOW }),
    [],
    "flag ON + no usage tokens → [] (nothing fabricated)",
  );
});

test("flag OFF (no usageUpdate option) → [] (nothing constructed) (R1.2)", () => {
  assert.deepEqual(
    usageUpdatesFor(CARRIER, { contextWindowSize: WINDOW }),
    [],
    "flag OFF → [] — toUsageUpdate is not even called",
  );
});

// === the gate is REUSED from src/usage.ts, not re-implemented here =================================

test("the shape-contract test REUSES usageUpdatesFor / toUsageUpdate (no local re-impl) (R2.1)", () => {
  assert.equal(typeof usageUpdatesFor, "function", "usageUpdatesFor is the reused story-025 export");
  assert.equal(typeof toUsageUpdate, "function", "toUsageUpdate is the reused story-025 export");
  // established 018/019 self-guard: this file must not re-declare the gate locally.
  const self = readFileSync(new URL("./usage-shape-contract.test.ts", import.meta.url), "utf8");
  assert.ok(!/function\s+usageUpdatesFor\b/.test(self), "must not re-implement the usage gate locally");
  assert.ok(!/function\s+toUsageUpdate\b/.test(self), "must not re-implement the mapper locally");
});
