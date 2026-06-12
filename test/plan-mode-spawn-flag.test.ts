// Story 029 / Task 3.1 — Deterministic plan mode via --permission-mode plan (R4.1-R4.3).
// Validates: buildClaudeCmd/buildSpawnArgv include --permission-mode plan when planMode=true;
// they do NOT include it when planMode=false/undefined; and \x1b[Z is never written on the
// input path as a primary plan-mode trigger (documented fallback only, §5 / R4.3).
// node:test runner: `node --experimental-strip-types --test test/plan-mode-spawn-flag.test.ts`
// (run `npm run build` first)
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildClaudeCmd, buildSpawnArgv } from "../dist/engine-pty.js";

const ID = "11111111-1111-4111-8111-111111111111";

test("buildClaudeCmd with planMode=true includes --permission-mode plan (R4.1)", () => {
  const cmd = buildClaudeCmd(ID, true);
  assert.ok(
    cmd.includes("--permission-mode plan"),
    `expected --permission-mode plan in: ${cmd}`,
  );
});

test("buildSpawnArgv with planMode=true: the shell command includes --permission-mode plan (R4.1)", () => {
  const argv = buildSpawnArgv(ID, true);
  assert.equal(argv[0], "-lc", "login-shell flag is still -lc");
  assert.ok(
    argv[1].includes("--permission-mode plan"),
    `expected --permission-mode plan in argv[1]: ${argv[1]}`,
  );
});

test("buildClaudeCmd without planMode: --permission-mode plan is NOT present (backward compat)", () => {
  const cmdDefault = buildClaudeCmd(ID);
  assert.ok(
    !cmdDefault.includes("--permission-mode plan"),
    `expected NO --permission-mode plan in default cmd: ${cmdDefault}`,
  );

  const cmdFalse = buildClaudeCmd(ID, false);
  assert.ok(
    !cmdFalse.includes("--permission-mode plan"),
    `expected NO --permission-mode plan with planMode=false: ${cmdFalse}`,
  );
});

test("buildSpawnArgv without planMode: backward-compat — same output as before 029 (R4.1)", () => {
  const argv = buildSpawnArgv(ID);
  assert.deepEqual(argv, ["-lc", `claude --session-id ${ID}`]);
});

test("buildClaudeCmd planMode: session-id is preserved verbatim alongside the plan flag (R4.1)", () => {
  const cmd = buildClaudeCmd(ID, true);
  assert.ok(cmd.includes(`--session-id ${ID}`), "session-id preserved when planMode=true");
  assert.ok(!/(^|\s)-p(\s|$)|--print|stream-json/.test(cmd), "interactive-only: no -p/stream-json");
});

test("plan mode: \\x1b[Z is NOT written on the input path as a primary plan trigger (R4.3)", () => {
  // The \x1b[Z (Shift+Tab) sequence is documented as an untested fallback (§5 / R4.3) and
  // must NEVER appear in buildClaudeCmd output — it is a PTY input, not a spawn argv token.
  const cmdOn = buildClaudeCmd(ID, true);
  const cmdOff = buildClaudeCmd(ID, false);
  assert.ok(!cmdOn.includes("\x1b[Z"), "no \\x1b[Z in spawn command with planMode=true");
  assert.ok(!cmdOff.includes("\x1b[Z"), "no \\x1b[Z in spawn command with planMode=false");
});
