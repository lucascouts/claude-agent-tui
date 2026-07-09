// Story 074 / Task 4.1–4.2 (#828) — the fast-mode config-option SURFACE reconcile with upstream
// v0.57. The fork keeps its PTY `/fast on|off` inject mechanism and the FAST_MODE_MODELS gate; only the
// ACP *type negotiation* aligns with upstream: emit `type:"boolean"` (currentValue tracks the toggle)
// when the client advertised `session.configOptions.boolean`, else the `on`/`off` select fallback. The
// constants FAST_MODE_CONFIG_ID/ON/OFF replace the inline literals, and resolveFastModeEnabled accepts
// a boolean payload OR the on/off string. These are the pure, hermetic surface units (no agent/pty).
//   node --experimental-strip-types --test test/fast-mode-config-surface.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FAST_MODE_CONFIG_ID,
  FAST_MODE_ON,
  FAST_MODE_OFF,
  createFastModeConfigOption,
  clientSupportsBooleanConfigOptions,
  resolveFastModeEnabled,
} from "../dist/model-catalog.js";

// ---- 4.2 constants (replace inline "fast"/"on"/"off" literals) ----------------------------------

test("4.1 the fast-mode identity is exported as constants", () => {
  assert.equal(FAST_MODE_CONFIG_ID, "fast");
  assert.equal(FAST_MODE_ON, "on");
  assert.equal(FAST_MODE_OFF, "off");
});

// ---- 4.1 createFastModeConfigOption: boolean when advertised, select fallback otherwise ----------

test("4.1 boolean option when the client advertises boolean config options (currentValue tracks toggle)", () => {
  const on = createFastModeConfigOption(true, true) as any;
  assert.equal(on.id, FAST_MODE_CONFIG_ID);
  assert.equal(on.type, "boolean");
  assert.equal(on.currentValue, true, "currentValue reflects the enabled toggle");
  assert.equal(on.name, "Fast Mode");
  assert.ok(!("options" in on), "a boolean option carries no select `options` array");

  const off = createFastModeConfigOption(false, true) as any;
  assert.equal(off.type, "boolean");
  assert.equal(off.currentValue, false);
});

test("4.1 select fallback (on/off) when boolean config options are NOT advertised", () => {
  const on = createFastModeConfigOption(true, false) as any;
  assert.equal(on.type, "select");
  assert.equal(on.currentValue, FAST_MODE_ON);
  assert.deepEqual(
    on.options.map((o: any) => o.value),
    [FAST_MODE_OFF, FAST_MODE_ON],
    "off then on, mirroring the story-073 select order",
  );

  const off = createFastModeConfigOption(false, false) as any;
  assert.equal(off.type, "select");
  assert.equal(off.currentValue, FAST_MODE_OFF);
});

// ---- 4.1 boolean-capability detection (reads session.configOptions.boolean) ----------------------

test("4.1 clientSupportsBooleanConfigOptions true only when session.configOptions.boolean is present", () => {
  assert.equal(clientSupportsBooleanConfigOptions({ session: { configOptions: { boolean: {} } } } as any), true);
  assert.equal(clientSupportsBooleanConfigOptions({ session: { configOptions: {} } } as any), false);
  assert.equal(clientSupportsBooleanConfigOptions({ session: {} } as any), false);
  assert.equal(clientSupportsBooleanConfigOptions({} as any), false);
  assert.equal(clientSupportsBooleanConfigOptions(undefined), false);
  assert.equal(clientSupportsBooleanConfigOptions(null), false);
});

// ---- 4.3 resolveFastModeEnabled: boolean payload OR on/off string → same enabled state -----------

test("4.3 resolveFastModeEnabled maps a boolean payload OR the on/off string to the same enabled state", () => {
  assert.equal(resolveFastModeEnabled(true), true);
  assert.equal(resolveFastModeEnabled(false), false);
  assert.equal(resolveFastModeEnabled(FAST_MODE_ON), true);
  assert.equal(resolveFastModeEnabled(FAST_MODE_OFF), false);
  // Any non-"on" string (and any other shape) resolves to OFF — a toggle never half-applies.
  assert.equal(resolveFastModeEnabled("garbage"), false);
  assert.equal(resolveFastModeEnabled(undefined), false);
});
