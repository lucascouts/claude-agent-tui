// Story 013 / Task 3.1 — interactive-only, never-force-entrypoint contract.
// node:test runner: `node --experimental-strip-types --test test/engine-interactive-only.test.ts`
// (run `npm run build` first).
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildClaudeCmd, spawnClaudePty } from "../dist/engine-pty.js";

function captureSpawn() {
  const calls: Array<{ opts: Record<string, unknown> }> = [];
  const spawn = ((_file: string, _args: readonly string[], opts: Record<string, unknown>) => {
    calls.push({ opts });
    return { __fake: true } as never;
  }) as never;
  return { calls, spawn };
}

test("interactive-only: claudeCmd contains no -p/--print/stream-json token (R3.2)", () => {
  const cmd = buildClaudeCmd("33333333-3333-4333-8333-333333333333");
  assert.ok(!/(^|\s)-p(\s|$)/.test(cmd), "no bare -p");
  assert.ok(!cmd.includes("--print"), "no --print");
  assert.ok(!cmd.includes("stream-json"), "no stream-json");
});

test("no-spoof: the spawn env passed to pty.spawn has CLAUDE_CODE_ENTRYPOINT === undefined (R3.1)", () => {
  const { calls, spawn } = captureSpawn();
  // Even when the parent env carried an SDK entrypoint, it must never reach the spawn.
  spawnClaudePty({
    cwd: "/x",
    baseEnv: { CLAUDE_CODE_ENTRYPOINT: "sdk-ts" } as NodeJS.ProcessEnv,
    spawn,
  });
  const env = calls[0].opts.env as Record<string, string | undefined>;
  assert.equal(
    env.CLAUDE_CODE_ENTRYPOINT,
    undefined,
    "the entrypoint label must never be forged/forced",
  );
});

test("no-spoof: a clean base env spawns with the entrypoint still unset (organic cli only)", () => {
  const { calls, spawn } = captureSpawn();
  spawnClaudePty({ cwd: "/x", baseEnv: { PATH: "/usr/bin" } as NodeJS.ProcessEnv, spawn });
  const env = calls[0].opts.env as Record<string, string | undefined>;
  assert.equal(
    env.CLAUDE_CODE_ENTRYPOINT,
    undefined,
    "nothing on the path may assign CLAUDE_CODE_ENTRYPOINT",
  );
});
