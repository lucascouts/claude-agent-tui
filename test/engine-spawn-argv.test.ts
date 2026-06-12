// Story 013 / Task 1.1 — the login-shell argv builder.
// node:test runner: `node --experimental-strip-types --test test/engine-spawn-argv.test.ts`
// (behavioral imports come from the built tree — run `npm run build` first).
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildClaudeCmd, buildSpawnArgv, resolveShell } from "../dist/engine-pty.js";

test("argv: buildSpawnArgv equals ['-lc', 'claude --session-id <id>'] with the id interpolated", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  assert.deepEqual(buildSpawnArgv(id), ["-lc", `claude --session-id ${id}`]);
});

test("argv: the -lc login-shell flag is always the first token (shebang honored, R1.3)", () => {
  assert.equal(buildSpawnArgv("abc")[0], "-lc");
});

test("argv: claudeCmd carries no -p/--print/stream-json (interactive TUI only, R3.2)", () => {
  const cmd = buildClaudeCmd("22222222-2222-4222-9222-222222222222");
  assert.equal(cmd, "claude --session-id 22222222-2222-4222-9222-222222222222");
  assert.ok(
    !/(^|\s)-p(\s|$)|--print|stream-json/.test(cmd),
    `unexpected non-interactive token in: ${cmd}`,
  );
});

test("shell: resolves process.env.SHELL when set", () => {
  assert.equal(resolveShell({ SHELL: "/usr/bin/zsh" } as NodeJS.ProcessEnv), "/usr/bin/zsh");
});

test("shell: falls back to /bin/bash when SHELL is unset (R1.2)", () => {
  assert.equal(resolveShell({} as NodeJS.ProcessEnv), "/bin/bash");
});
