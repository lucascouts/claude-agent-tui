// Story 013 / Task 2.1 — the single shared env-sanitize function.
// node:test runner: `node --experimental-strip-types --test test/engine-env-sanitize.test.ts`
// (run `npm run build` first).
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSanitizedEnv, FORBIDDEN_BILLING_VARS } from "../dist/engine-pty.js";

// A base env pre-seeded with ALL four billing vars set, plus unrelated keys.
function taintedBase(): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/local/bin:/usr/bin",
    HOME: "/home/u",
    CLAUDECODE: "1",
    CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
    CLAUDE_AGENT_SDK_VERSION: "0.3.156",
    CLAUDE_AGENT_SDK_CLIENT_APP: "zed",
  } as NodeJS.ProcessEnv;
}

test("env: all four billing/SDK vars are deleted (R2.2, R2.3)", () => {
  const env = buildSanitizedEnv(taintedBase());
  for (const key of FORBIDDEN_BILLING_VARS) {
    assert.equal(env[key], undefined, `${key} must be deleted from the sanitized env`);
  }
});

test("env: the three terminal vars are set (R2.1)", () => {
  const env = buildSanitizedEnv(taintedBase());
  assert.equal(env.TERM, "xterm-256color");
  assert.equal(env.COLORTERM, "truecolor");
  assert.equal(env.FORCE_COLOR, "3");
});

test("env: unrelated keys survive untouched", () => {
  const env = buildSanitizedEnv(taintedBase());
  assert.equal(env.PATH, "/usr/local/bin:/usr/bin");
  assert.equal(env.HOME, "/home/u");
});

test("env: the input env is not mutated (a fresh object is returned)", () => {
  const base = taintedBase();
  buildSanitizedEnv(base);
  assert.equal(base.CLAUDECODE, "1", "buildSanitizedEnv must not delete keys on the caller's env");
});

test("env: FORBIDDEN_BILLING_VARS is exactly the four documented keys", () => {
  assert.deepEqual(
    [...FORBIDDEN_BILLING_VARS].sort(),
    [
      "CLAUDECODE",
      "CLAUDE_AGENT_SDK_CLIENT_APP",
      "CLAUDE_AGENT_SDK_VERSION",
      "CLAUDE_CODE_ENTRYPOINT",
    ].sort(),
  );
});
