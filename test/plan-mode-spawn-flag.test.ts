// Story 029 / Task 3.1 — Deterministic plan mode via --permission-mode plan (R4.1-R4.3).
// GENERALIZED by story 046 / Task 4.2: the `planMode: boolean` seam became `permissionMode: string`.
// `permissionMode: "plan"` reproduces the old planMode=true path; "default"/undefined emit no flag.
// Validates: buildClaudeCmd/buildSpawnArgv include --permission-mode plan for "plan"; they do NOT
// include it for "default"/undefined; and \x1b[Z is never written on the input path as a primary
// plan-mode trigger (documented fallback only, §5 / R4.3).
// node:test runner: `node --experimental-strip-types --test test/plan-mode-spawn-flag.test.ts`
// (run `npm run build` first)
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildClaudeCmd, buildSpawnArgv } from "../dist/engine-pty.js";

const ID = "11111111-1111-4111-8111-111111111111";

test("buildClaudeCmd with permissionMode='plan' includes --permission-mode plan (R4.1)", () => {
  const cmd = buildClaudeCmd(ID, "plan");
  assert.ok(
    cmd.includes("--permission-mode plan"),
    `expected --permission-mode plan in: ${cmd}`,
  );
});

test("buildSpawnArgv with permissionMode='plan': the shell command includes --permission-mode plan (R4.1)", () => {
  const argv = buildSpawnArgv(ID, "plan");
  assert.equal(argv[0], "-lc", "login-shell flag is still -lc");
  assert.ok(
    argv[1].includes("--permission-mode plan"),
    `expected --permission-mode plan in argv[1]: ${argv[1]}`,
  );
});

test("buildClaudeCmd without a mode: --permission-mode plan is NOT present (backward compat)", () => {
  const cmdDefault = buildClaudeCmd(ID);
  assert.ok(
    !cmdDefault.includes("--permission-mode plan"),
    `expected NO --permission-mode plan in default cmd: ${cmdDefault}`,
  );

  const cmdExplicitDefault = buildClaudeCmd(ID, "default");
  assert.ok(
    !cmdExplicitDefault.includes("--permission-mode"),
    `expected NO --permission-mode with permissionMode='default': ${cmdExplicitDefault}`,
  );
});

test("buildSpawnArgv without a mode: backward-compat — same output as before 029 (R4.1)", () => {
  const argv = buildSpawnArgv(ID);
  assert.deepEqual(argv, ["-lc", `claude --session-id ${ID}`]);
});

test("buildClaudeCmd plan mode: session-id is preserved verbatim alongside the plan flag (R4.1)", () => {
  const cmd = buildClaudeCmd(ID, "plan");
  assert.ok(cmd.includes(`--session-id ${ID}`), "session-id preserved when permissionMode='plan'");
  assert.ok(!/(^|\s)-p(\s|$)|--print|stream-json/.test(cmd), "interactive-only: no -p/stream-json");
});

test("plan mode: \\x1b[Z is NOT written on the input path as a primary plan trigger (R4.3)", () => {
  // The \x1b[Z (Shift+Tab) sequence is the closed-loop driver's PTY input (story 046 Task 4.3),
  // NOT a spawn argv token — it must NEVER appear in buildClaudeCmd output.
  const cmdOn = buildClaudeCmd(ID, "plan");
  const cmdOff = buildClaudeCmd(ID, "default");
  assert.ok(!cmdOn.includes("\x1b[Z"), "no \\x1b[Z in spawn command with permissionMode='plan'");
  assert.ok(!cmdOff.includes("\x1b[Z"), "no \\x1b[Z in spawn command with permissionMode='default'");
});
