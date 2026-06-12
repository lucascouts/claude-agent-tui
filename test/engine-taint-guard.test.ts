// Story 013 / Task 5.1 — refuse-to-spawn taint guard.
// node:test runner: `node --experimental-strip-types --test test/engine-taint-guard.test.ts`
// (run `npm run build` first).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertSpawnEnvUntainted,
  spawnClaudePty,
  FORBIDDEN_BILLING_VARS,
} from "../dist/engine-pty.js";

test("taint: guard throws naming the offending key when a forbidden var survives (R4.1/R4.2)", () => {
  const tainted = { PATH: "/usr/bin", CLAUDE_CODE_ENTRYPOINT: "sdk-ts" } as NodeJS.ProcessEnv;
  assert.throws(() => assertSpawnEnvUntainted(tainted), /CLAUDE_CODE_ENTRYPOINT/);
});

test("taint: guard names EVERY offending key when several survive", () => {
  const tainted = { CLAUDECODE: "1", CLAUDE_AGENT_SDK_VERSION: "0.3.156" } as NodeJS.ProcessEnv;
  assert.throws(
    () => assertSpawnEnvUntainted(tainted),
    (err: unknown) => {
      const m = (err as Error).message;
      return m.includes("CLAUDECODE") && m.includes("CLAUDE_AGENT_SDK_VERSION");
    },
  );
});

test("taint: guard passes (no throw) for a properly sanitized env", () => {
  assert.doesNotThrow(() =>
    assertSpawnEnvUntainted({ PATH: "/usr/bin", TERM: "xterm-256color" } as NodeJS.ProcessEnv),
  );
});

test("taint: a throwing guard halts before any spawn statement runs (pty.spawn never reached)", () => {
  let spawnCalls = 0;
  assert.throws(() => {
    assertSpawnEnvUntainted({ CLAUDE_AGENT_SDK_CLIENT_APP: "zed" } as NodeJS.ProcessEnv);
    spawnCalls++; // unreachable once the guard throws
  });
  assert.equal(spawnCalls, 0, "no spawn-equivalent statement may run after the guard throws");
});

test("taint: spawnClaudePty sanitizes a dirty base, the guard passes, and pty.spawn is reached", () => {
  let calls = 0;
  const spawn = (() => {
    calls++;
    return { __fake: true } as never;
  }) as never;
  // The base carries ALL four forbidden vars; sanitization must clear them so the guard passes.
  const base = Object.fromEntries(FORBIDDEN_BILLING_VARS.map((k) => [k, "x"])) as NodeJS.ProcessEnv;
  assert.doesNotThrow(() => spawnClaudePty({ cwd: "/x", baseEnv: base, spawn }));
  assert.equal(calls, 1, "a clean (post-sanitize) env must reach pty.spawn exactly once");
});
