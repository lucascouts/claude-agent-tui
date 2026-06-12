// Story 044 / Task 2.1 (R4.1, R4.2) — the FORK_LIVE_SUBAGENT_WATCH entrypoint flag parse truth
// table. The pure `liveSubagentWatchEnabled` (src/live-subagent-env.ts) is what index.ts calls to
// decide the default posture, so its truth table is unit-checkable here WITHOUT booting the
// entrypoint or mutating process.env: each case passes an explicit env object. Contract
// (DEFAULT-ON): unset / empty / any value other than the opt-out → ON; opt OUT only via the exact
// strings "0" / "false". Mirrors the story-042 usage-env.ts / story-043 live-diff-env.ts shape.
//
// node:test runner: `node --experimental-strip-types --test test/live-subagent-env.test.ts`
// (run `npm run build` first — the seam resolves against ../dist/live-subagent-env.js, an INTERNAL
// fork module imported directly, NOT via lib.ts whose public surface is frozen to upstream v0.39.0).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { liveSubagentWatchEnabled } from "../dist/live-subagent-env.js";

// A typed helper so the explicit env literals below are accepted as NodeJS.ProcessEnv shapes.
const env = (e: Record<string, string>): NodeJS.ProcessEnv => e as NodeJS.ProcessEnv;

test("DEFAULT-ON: unset / empty / any non-opt-out value → ON (R4.1)", () => {
  assert.equal(liveSubagentWatchEnabled(env({})), true, "unset FORK_LIVE_SUBAGENT_WATCH → ON (default)");
  assert.equal(liveSubagentWatchEnabled(env({ FORK_LIVE_SUBAGENT_WATCH: "" })), true, "empty → ON");
  assert.equal(liveSubagentWatchEnabled(env({ FORK_LIVE_SUBAGENT_WATCH: "1" })), true, "explicit '1' → ON");
  assert.equal(
    liveSubagentWatchEnabled(env({ FORK_LIVE_SUBAGENT_WATCH: "true" })),
    true,
    "explicit 'true' → ON",
  );
  assert.equal(
    liveSubagentWatchEnabled(env({ FORK_LIVE_SUBAGENT_WATCH: "anything-else" })),
    true,
    "unrecognized value → ON (only the exact opt-out strings disable)",
  );
});

test("OPT-OUT: only the exact strings '0' / 'false' → OFF (R4.2)", () => {
  assert.equal(liveSubagentWatchEnabled(env({ FORK_LIVE_SUBAGENT_WATCH: "0" })), false, "'0' → OFF");
  assert.equal(
    liveSubagentWatchEnabled(env({ FORK_LIVE_SUBAGENT_WATCH: "false" })),
    false,
    "'false' → OFF",
  );
});

// === the parse is REUSED from src/live-subagent-env.ts, not re-implemented here ===================

test("the flag test REUSES liveSubagentWatchEnabled (no local re-impl) (R4.1)", () => {
  assert.equal(
    typeof liveSubagentWatchEnabled,
    "function",
    "liveSubagentWatchEnabled is the imported parse export",
  );
  // established 018/019 self-guard: this file must not re-declare the parse locally.
  // (the `\s+`/`\b` form matches a genuine local decl only, never this assertion line.)
  const self = readFileSync(new URL("./live-subagent-env.test.ts", import.meta.url), "utf8");
  assert.ok(
    !/function\s+liveSubagentWatchEnabled\b/.test(self),
    "must not re-implement the flag parse locally",
  );
});

// === index.ts threads the resolved flag through runAcp (the 042/043 two-layer pattern) ============

test("index.ts parses the flag via liveSubagentWatchEnabled and threads it through runAcp (R4.1/R4.2)", () => {
  const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.ok(
    /liveSubagentWatchEnabled\(\)/.test(src),
    "index.ts must resolve the default posture via the pure helper (not an inline env read)",
  );
  // Tolerant to ADDITIONAL threaded flags (the story-043 lesson: assert only the contract this
  // test owns — the flag IS threaded through the runAcp object — not the exact flag set).
  assert.ok(
    /runAcp\(\{[^}]*\bliveSubagentWatch\b[^}]*\}\)/.test(src),
    "index.ts must thread the resolved liveSubagentWatch flag through runAcp's AgentDeps",
  );
});
