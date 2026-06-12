import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSanitizedEnv, FORBIDDEN_BILLING_VARS } from "../dist/engine-pty.js";
import { buildZedAgentEntry } from "../dist/zed-register.js";

// Story 027 / Task 2.1 — pin the env-sanitization LOCATION (R6.1, R6.2).
//
// The decision: billing sanitization happens at ONE authoritative point — the internal
// PTY spawn (story 013, buildSanitizedEnv) — NOT via Zed's `agent_servers` `env` block.
// The Zed entry therefore carries an EMPTY `env: {}`; duplicating the scrub there would
// create a second, drift-prone scrubbing point. Zed-`env`-only sufficiency is left
// UNTESTED by choice (the §15 open 🧪) because the internal spawn supersedes it.
//
// This test is the executable record of that decision: it asserts BOTH halves —
// (a) the built Zed entry's env is empty, and (b) the spawn-side builder removes all
// four SDK/billing vars — and names the spawn as the single source of truth.

const ABS = "/home/otaku/Projetos/Pessoais/zed/agent-painel-ui/fork/dist/index.js";

// --- R6.2: the Zed entry leaves env empty — no scrubbing happens in Zed's env block --

test("location: the built Zed agent_servers entry leaves env EMPTY (R6.2)", () => {
  const entry = buildZedAgentEntry(ABS);
  assert.deepEqual(entry.env, {}, "Zed entry env must be {} — sanitization is NOT done in Zed's env block");
});

// --- R6.1: the spawn (story 013) is the single authoritative scrub of all four vars --

test("location: the spawn env-builder (story 013) is the single authoritative scrub of the four SDK vars (R6.1)", () => {
  // A base env pre-tainted with every billing/SDK var the spawn must strip.
  const tainted = {
    PATH: "/usr/bin",
    CLAUDECODE: "1",
    CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
    CLAUDE_AGENT_SDK_VERSION: "0.3.156",
    CLAUDE_AGENT_SDK_CLIENT_APP: "zed",
  };
  const spawnEnv = buildSanitizedEnv(tainted);
  for (const key of FORBIDDEN_BILLING_VARS) {
    assert.equal(spawnEnv[key], undefined, `${key} must be scrubbed at the spawn (the single scrub point)`);
  }
  // The four vars the spawn owns are exactly the four §10 billing vars — no more, no less.
  assert.deepEqual(
    [...FORBIDDEN_BILLING_VARS].sort(),
    ["CLAUDECODE", "CLAUDE_AGENT_SDK_CLIENT_APP", "CLAUDE_AGENT_SDK_VERSION", "CLAUDE_CODE_ENTRYPOINT"].sort(),
    "the spawn-side scrub set is exactly the four documented §10 vars",
  );
});

// --- the two locations are consistent: Zed defers, spawn scrubs (no split sanitization) --

test("location: sanitization is not split — Zed defers (env {}), the spawn scrubs (no second point)", () => {
  const zedEnv = buildZedAgentEntry(ABS).env;
  // Zed contributes NO scrubbing keys; whatever the spawn inherits, the spawn alone scrubs.
  assert.equal(Object.keys(zedEnv).length, 0, "Zed env must contribute nothing — a single scrub point only");
});
