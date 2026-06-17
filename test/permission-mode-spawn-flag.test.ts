// Story 046 / Task 4.2 + 4.4 — the generalized `--permission-mode <mode>` spawn flag + the
// flag-carrying resume argv (R3.2, R3.4).
//
// CONTRACT (story.md R3.2 / R3.4 + design.md §6a/§6c):
//  - `buildClaudeCmd`/`buildSpawnArgv` generalize the `planMode` seam: a NON-default permission mode is
//    emitted as `--permission-mode <mode>`; `default` emits nothing; `plan` stays equivalent to the old
//    planMode=true path. The flag is interactive-only — it adds NO `-p`/`--print`/`stream-json` (billing
//    stays subscription `cli`, story.md "Unchanged Behavior" 1 + Constraints).
//  - `buildResumeArgv` gains a flag-carrying variant: the resume argv for a re-spawn (R3.4 dontAsk/bypass)
//    carries `--permission-mode <mode>` while preserving the `--resume "<id>" || claude` robustness, so
//    the same sessionId/transcript is reattached under the new mode.
//
// Pure functions over the argv builders — no spawn, no claude. node:test (build first):
//   node --experimental-strip-types --test test/permission-mode-spawn-flag.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildClaudeCmd, buildSpawnArgv } from "../dist/engine-pty.js";
import { buildResumeArgv } from "../dist/engine-lifecycle.js";

const ID = "11111111-1111-4111-8111-111111111111";

/** Whole-token billing guard — `--permission-mode` legitimately contains "-p" as a substring, so
 *  match credit tokens as whole tokens / the stream-json fragment only. */
function carriesNoCreditToken(cmd: string): boolean {
  return !/(^|\s)-p(\s|$)|--print|stream-json/.test(cmd);
}

test("4.2 buildClaudeCmd with permissionMode='acceptEdits' emits --permission-mode acceptEdits (R3.2)", () => {
  const cmd = buildClaudeCmd(ID, "acceptEdits");
  assert.ok(
    cmd.includes("--permission-mode acceptEdits"),
    `expected --permission-mode acceptEdits in: ${cmd}`,
  );
});

test("4.2 buildClaudeCmd with permissionMode='plan' is equivalent to the old planMode path (R3.2)", () => {
  const cmd = buildClaudeCmd(ID, "plan");
  assert.ok(cmd.includes("--permission-mode plan"), `expected --permission-mode plan in: ${cmd}`);
});

test("4.2 buildClaudeCmd with permissionMode='default' emits NO --permission-mode flag (no-op)", () => {
  const cmd = buildClaudeCmd(ID, "default");
  assert.ok(
    !cmd.includes("--permission-mode"),
    `the default mode must not add a --permission-mode flag, got: ${cmd}`,
  );
});

test("4.2 buildClaudeCmd with no mode is byte-for-byte the pre-046 spawn (backward compat)", () => {
  assert.equal(buildClaudeCmd(ID), `claude --session-id ${ID}`);
});

test("4.2 buildSpawnArgv threads the mode: argv[0]==-lc and argv[1] carries the flag (R3.2)", () => {
  const argv = buildSpawnArgv(ID, "dontAsk");
  assert.equal(argv[0], "-lc", "login-shell flag stays -lc");
  assert.ok(
    argv[1].includes("--permission-mode dontAsk"),
    `expected --permission-mode dontAsk in argv[1]: ${argv[1]}`,
  );
});

test("4.2 the --permission-mode spawn flag adds NO -p/--print/stream-json (billing unchanged)", () => {
  for (const mode of ["acceptEdits", "plan", "dontAsk", "bypassPermissions"] as const) {
    const cmd = buildClaudeCmd(ID, mode);
    assert.ok(carriesNoCreditToken(cmd), `mode ${mode} smuggled a credit-path token: ${cmd}`);
  }
});

test("4.4 buildResumeArgv carries --permission-mode <mode> for the re-spawn (R3.4, flag-carrying resume)", () => {
  const argv = buildResumeArgv(ID, "bypassPermissions");
  assert.equal(argv[0], "-c", "resume argv keeps the -c shell flag");
  assert.ok(
    argv[1].includes(`--resume "${ID}"`),
    `the re-spawn must reattach the SAME sessionId/transcript: ${argv[1]}`,
  );
  assert.ok(
    argv[1].includes("--permission-mode bypassPermissions"),
    `the flag-carrying resume argv must carry the mode: ${argv[1]}`,
  );
  assert.ok(
    argv[1].includes("|| claude"),
    `the robust resume fallback (|| claude) must be preserved: ${argv[1]}`,
  );
});

test("4.4 buildResumeArgv with no mode is unchanged from the pre-046 resume argv (backward compat)", () => {
  assert.deepEqual(buildResumeArgv(ID), ["-c", `claude --resume "${ID}" || claude`]);
});

test("4.4 the flag-carrying resume argv adds NO -p/--print/stream-json (billing unchanged on re-spawn)", () => {
  const argv = buildResumeArgv(ID, "dontAsk");
  assert.ok(carriesNoCreditToken(argv[1]), `the re-spawn argv smuggled a credit token: ${argv[1]}`);
});
