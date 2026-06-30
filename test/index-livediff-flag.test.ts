// Story 043 / Task 2.1 (R2.2) — the LIVE_DIFF entrypoint flag parse truth table. The pure
// `liveDiffEnabled` (src/live-diff-env.ts) is what index.ts calls to decide the default posture, so
// its truth table is unit-checkable here WITHOUT booting the entrypoint or mutating process.env: each
// case passes an explicit env object. Contract (DEFAULT-ON): unset / empty / any value other than the
// opt-out → ON; opt OUT only via the exact strings "0" / "false".
//
// node:test runner: `node --experimental-strip-types --test test/index-livediff-flag.test.ts`
// (run `npm run build` first — the seam resolves against ../dist/live-diff-env.js, an INTERNAL fork
// module imported directly, NOT via lib.ts whose public surface is frozen to upstream v0.53.0).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { liveDiffEnabled } from "../dist/live-diff-env.js";

// A typed helper so the explicit env literals below are accepted as NodeJS.ProcessEnv shapes.
const env = (e: Record<string, string>): NodeJS.ProcessEnv => e as NodeJS.ProcessEnv;

test("DEFAULT-ON: unset / empty / any non-opt-out value → ON (R2.2)", () => {
  assert.equal(liveDiffEnabled(env({})), true, "unset LIVE_DIFF → ON (the new default)");
  assert.equal(liveDiffEnabled(env({ LIVE_DIFF: "" })), true, "empty LIVE_DIFF → ON");
  assert.equal(liveDiffEnabled(env({ LIVE_DIFF: "1" })), true, "explicit '1' → ON");
  assert.equal(liveDiffEnabled(env({ LIVE_DIFF: "true" })), true, "explicit 'true' → ON");
});

test("OPT-OUT: only the exact strings '0' / 'false' → OFF (R2.2)", () => {
  assert.equal(liveDiffEnabled(env({ LIVE_DIFF: "0" })), false, "'0' is the opt-out → OFF");
  assert.equal(liveDiffEnabled(env({ LIVE_DIFF: "false" })), false, "'false' is the opt-out → OFF");
});

// === the parse is REUSED from src/live-diff-env.ts, not re-implemented here ========================

test("the flag test REUSES liveDiffEnabled (no local re-impl) (R2.2)", () => {
  assert.equal(typeof liveDiffEnabled, "function", "liveDiffEnabled is the imported parse export");
  // established 018/019 self-guard: this file must not re-declare the parse locally.
  // (the `\s+`/`\b` form matches a genuine local decl only, never this assertion line.)
  const self = readFileSync(new URL("./index-livediff-flag.test.ts", import.meta.url), "utf8");
  assert.ok(!/function\s+liveDiffEnabled\b/.test(self), "must not re-implement the flag parse locally");
});
