// Story 042 / Task 1.1 (R1.1) — the USAGE_UPDATE entrypoint flag parse truth table. The pure
// `usageUpdateEnabled` (src/usage-env.ts) is what index.ts calls to decide the default posture, so
// its truth table is unit-checkable here WITHOUT booting the entrypoint or mutating process.env: each
// case passes an explicit env object. Contract (DEFAULT-ON): unset / empty / any value other than the
// opt-out → ON; opt OUT only via the exact strings "0" / "false".
//
// node:test runner: `node --experimental-strip-types --test test/index-usage-flag.test.ts`
// (run `npm run build` first — the seam resolves against ../dist/usage-env.js, an INTERNAL fork
// module imported directly, NOT via lib.ts whose public surface is frozen to upstream v0.39.0).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { usageUpdateEnabled } from "../dist/usage-env.js";

// A typed helper so the explicit env literals below are accepted as NodeJS.ProcessEnv shapes.
const env = (e: Record<string, string>): NodeJS.ProcessEnv => e as NodeJS.ProcessEnv;

test("DEFAULT-ON: unset / empty / any non-opt-out value → ON (R1.1)", () => {
  assert.equal(usageUpdateEnabled(env({})), true, "unset USAGE_UPDATE → ON (the new default)");
  assert.equal(usageUpdateEnabled(env({ USAGE_UPDATE: "" })), true, "empty USAGE_UPDATE → ON");
  assert.equal(usageUpdateEnabled(env({ USAGE_UPDATE: "1" })), true, "explicit '1' → ON");
  assert.equal(usageUpdateEnabled(env({ USAGE_UPDATE: "true" })), true, "explicit 'true' → ON");
});

test("OPT-OUT: only the exact strings '0' / 'false' → OFF (R1.1)", () => {
  assert.equal(usageUpdateEnabled(env({ USAGE_UPDATE: "0" })), false, "'0' is the opt-out → OFF");
  assert.equal(usageUpdateEnabled(env({ USAGE_UPDATE: "false" })), false, "'false' is the opt-out → OFF");
});

// === the parse is REUSED from src/usage-env.ts, not re-implemented here ============================

test("the flag test REUSES usageUpdateEnabled (no local re-impl) (R1.1)", () => {
  assert.equal(typeof usageUpdateEnabled, "function", "usageUpdateEnabled is the imported parse export");
  // established 018/019 self-guard: this file must not re-declare the parse locally.
  // (the `\s+`/`\b` form matches a genuine local decl only, never this assertion line.)
  const self = readFileSync(new URL("./index-usage-flag.test.ts", import.meta.url), "utf8");
  assert.ok(!/function\s+usageUpdateEnabled\b/.test(self), "must not re-implement the flag parse locally");
});
