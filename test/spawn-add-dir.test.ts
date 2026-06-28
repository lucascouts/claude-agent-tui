// Story 057 / Task 1.1 — the `--add-dir "<dir>"` spawn flag (fresh + resume), one flag per dir, with
// the isSafeDir directory allowlist (R1.1/R1.2).
//
// CONTRACT (story.md R1.1 + R1.2):
//  - `buildClaudeCmd`/`buildSpawnArgv` (fresh) and `buildResumeArgv` (resume) emit each additional
//    workspace directory as ONE DOUBLE-QUOTED, interactive-only `--add-dir "<dir>"` flag — never a
//    single space-joined value. The resume argv carries every dir into BOTH the `--resume "<id>"` launch
//    AND the `|| claude` fresh fallback (the dirs are folded into the shared `flags`).
//  - SECURITY (R1.2): a dir is emitted ONLY when isSafeDir passes — it must be ABSOLUTE, currently EXIST
//    on disk, and be FREE of the shell metacharacters `" $ ` backtick `\n` `\r`. A relative / nonexistent
//    / metacharacter dir is DROPPED — never interpolated into the `-lc` shell string.
//  - BILLING: the flag is interactive-only — it adds NO `-p`/`--print`/`--output-format`/`stream-json`
//    (billing stays subscription `cli`), and coexists with the other behavior flags.
//
// GOTCHA: isSafeDir calls existsSync, so every "safe" case below uses a REAL existing absolute dir
// (process.cwd() / os.tmpdir() / an mkdtempSync scratch dir). Pure functions over the argv builders — no
// spawn, no claude. node:test (build first — behavioral imports resolve against ../dist):
//   node --experimental-strip-types --test test/spawn-add-dir.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildClaudeCmd, buildSpawnArgv, isSafeDir } from "../dist/engine-pty.js";
import { buildResumeArgv } from "../dist/engine-lifecycle.js";

const ID = "11111111-1111-4111-8111-111111111111";

/** Whole-token billing guard — `--permission-mode` legitimately contains "-p" as a substring, so match
 *  the bare `-p` token / the credit fragments only. `--output-format stream-json` is the SDK/credit path. */
function carriesNoCreditToken(cmd: string): boolean {
  return !/(^|\s)-p(\s|$)|--print|--output-format|stream-json/.test(cmd);
}

/** Count non-overlapping occurrences of `needle` in `haystack` (the "appears twice" resume idiom). */
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

// Two REAL, existing, absolute dirs (isSafeDir requires existsSync to pass). cwd + tmpdir are always
// present and differ, giving us N=2 distinct flags to assert.
const DIR_A = process.cwd();
const DIR_B = os.tmpdir();

// ── Scenario 1: fresh-spawn emits ONE quoted flag PER dir (never space-joined) (R1.1) ─────────────────
test("1.1 buildClaudeCmd emits one double-quoted --add-dir per safe dir (N dirs → N flags)", () => {
  const cmd = buildClaudeCmd(ID, undefined, undefined, undefined, undefined, [DIR_A, DIR_B]);
  assert.ok(cmd.includes(`--add-dir "${DIR_A}"`), `dir A quoted & present: ${cmd}`);
  assert.ok(cmd.includes(`--add-dir "${DIR_B}"`), `dir B quoted & present: ${cmd}`);
  // EXACTLY two --add-dir flags — one per dir, not a single space-joined value.
  assert.equal(count(cmd, "--add-dir "), 2, `exactly one flag per dir (no space-join): ${cmd}`);
  // The space-joined anti-pattern (`--add-dir "A" "B"` with no second `--add-dir`) must NOT appear.
  assert.ok(
    !cmd.includes(`--add-dir "${DIR_A}" "${DIR_B}"`),
    `dirs must each get their own --add-dir, never a single joined value: ${cmd}`,
  );
});

test("1.1 buildSpawnArgv threads the dirs: argv[0]==-lc and argv[1] carries one flag per dir (R1.1)", () => {
  const argv = buildSpawnArgv(ID, undefined, undefined, undefined, undefined, [DIR_A, DIR_B]);
  assert.equal(argv[0], "-lc", "login-shell flag stays -lc");
  assert.ok(argv[1].includes(`--add-dir "${DIR_A}"`), `dir A in argv[1]: ${argv[1]}`);
  assert.ok(argv[1].includes(`--add-dir "${DIR_B}"`), `dir B in argv[1]: ${argv[1]}`);
  assert.equal(count(argv[1], "--add-dir "), 2, `exactly one flag per dir in argv[1]: ${argv[1]}`);
});

// ── Scenario 2: empty / undefined → ZERO flags (backward compat) ──────────────────────────────────────
test("1.1 buildClaudeCmd with no/empty additionalDirectories emits NO --add-dir (backward compat)", () => {
  assert.ok(
    !buildClaudeCmd(ID, undefined, undefined, undefined, undefined, undefined).includes("--add-dir"),
    "undefined dirs must add no --add-dir flag",
  );
  assert.ok(
    !buildClaudeCmd(ID, undefined, undefined, undefined, undefined, []).includes("--add-dir"),
    "empty dirs array must add no --add-dir flag",
  );
  // with NO optional args at all it stays byte-for-byte the pre-057 fresh spawn.
  assert.equal(buildClaudeCmd(ID), `claude --session-id ${ID}`);
});

// ── Scenario 3: resume argv carries each dir into BOTH the --resume AND the || claude fallback (R1.1) ──
test("1.1 buildResumeArgv carries each --add-dir into BOTH resume halves (each appears twice) (R1.1)", () => {
  const argv = buildResumeArgv(ID, undefined, undefined, undefined, [DIR_A, DIR_B]);
  assert.equal(argv[0], "-c", "resume argv keeps the -c shell flag");
  const cmd = argv[1];

  // Each dir must reach BOTH the `--resume "<id>"` launch AND the `|| claude` fresh fallback.
  assert.equal(count(cmd, `--add-dir "${DIR_A}"`), 2, `dir A must appear in BOTH resume halves: ${cmd}`);
  assert.equal(count(cmd, `--add-dir "${DIR_B}"`), 2, `dir B must appear in BOTH resume halves: ${cmd}`);

  // Anchor each half explicitly: the --resume segment and the || claude fallback each carry dir A.
  assert.ok(
    new RegExp(`--resume "[^"]+"[^|]*--add-dir "${DIR_A.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).test(cmd),
    `the --resume launch must carry --add-dir for dir A: ${cmd}`,
  );
  assert.ok(
    new RegExp(`\\|\\| claude .*--add-dir "${DIR_A.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).test(cmd),
    `the || claude fallback must carry --add-dir for dir A: ${cmd}`,
  );
  assert.ok(cmd.includes("|| claude"), `the robust resume fallback must be preserved: ${cmd}`);
});

test("1.1 buildResumeArgv with no dirs: no --add-dir and the || claude fallback is intact (backward compat)", () => {
  assert.deepEqual(buildResumeArgv(ID), ["-c", `claude --resume "${ID}" || claude`]);
  const argv = buildResumeArgv(ID, undefined, undefined, undefined, []);
  assert.ok(!argv[1].includes("--add-dir"), `empty dirs must not add a --add-dir flag: ${argv[1]}`);
  assert.ok(argv[1].includes("|| claude"), `the robust resume fallback must be preserved: ${argv[1]}`);
});

// ── Scenario 4: SECURITY — unsafe dirs are DROPPED (metacharacter / relative / nonexistent) ────────────
test("1.2 SECURITY: a dir with a shell metacharacter is DROPPED — no --add-dir, no metacharacter leak", () => {
  // Absolute-looking but each carries a forbidden metacharacter (" $ ` newline). They must be dropped.
  const unsafe = ['/tmp/a"b', "/tmp/a$b", "/tmp/a`b", "/tmp/a\nb", "/tmp/a\rb"];
  for (const dir of unsafe) {
    const fresh = buildClaudeCmd(ID, undefined, undefined, undefined, undefined, [dir]);
    const resume = buildResumeArgv(ID, undefined, undefined, undefined, [dir])[1];
    assert.ok(!fresh.includes("--add-dir"), `metacharacter dir must NOT emit --add-dir (fresh): ${JSON.stringify(dir)} → ${fresh}`);
    assert.equal(
      resume,
      `claude --resume "${ID}" || claude`,
      `metacharacter dir must keep the no-flag resume skeleton: ${JSON.stringify(dir)} → ${resume}`,
    );
  }
});

test("1.2 SECURITY: a RELATIVE path is DROPPED (isSafeDir requires path.isAbsolute)", () => {
  const rel = "relative/dir";
  assert.ok(
    !buildClaudeCmd(ID, undefined, undefined, undefined, undefined, [rel]).includes("--add-dir"),
    "relative path must NOT emit --add-dir (fresh)",
  );
  assert.equal(
    buildResumeArgv(ID, undefined, undefined, undefined, [rel])[1],
    `claude --resume "${ID}" || claude`,
    "relative path must keep the no-flag resume skeleton",
  );
});

test("1.2 SECURITY: a NON-EXISTENT absolute path is DROPPED (isSafeDir requires existsSync)", () => {
  const ghost = path.join(os.tmpdir(), "fork-add-dir-does-not-exist-__nope__", "deep", "ghost");
  assert.ok(
    !buildClaudeCmd(ID, undefined, undefined, undefined, undefined, [ghost]).includes("--add-dir"),
    "non-existent absolute path must NOT emit --add-dir (fresh)",
  );
  assert.equal(
    buildResumeArgv(ID, undefined, undefined, undefined, [ghost])[1],
    `claude --resume "${ID}" || claude`,
    "non-existent absolute path must keep the no-flag resume skeleton",
  );
});

test("1.2 a mixed list keeps ONLY the safe dir and drops the unsafe ones (fresh + both resume halves)", () => {
  const ghost = path.join(os.tmpdir(), "fork-add-dir-__nope__");
  const mixed = ["relative/x", ghost, '/tmp/a"b', DIR_A];
  const fresh = buildClaudeCmd(ID, undefined, undefined, undefined, undefined, mixed);
  assert.equal(count(fresh, "--add-dir "), 1, `only the one safe dir survives (fresh): ${fresh}`);
  assert.ok(fresh.includes(`--add-dir "${DIR_A}"`), `the safe dir is the survivor (fresh): ${fresh}`);

  const resume = buildResumeArgv(ID, undefined, undefined, undefined, mixed)[1];
  assert.equal(count(resume, `--add-dir "${DIR_A}"`), 2, `the safe dir reaches both resume halves: ${resume}`);
  assert.equal(count(resume, "--add-dir "), 2, `ONLY the safe dir (×2 halves) survives on resume: ${resume}`);
});

// ── Scenario 5: isSafeDir predicate — direct true/false cases (R1.2) ──────────────────────────────────
test("1.2 isSafeDir is TRUE for a real absolute dir (cwd, tmpdir, mkdtemp scratch)", () => {
  assert.equal(isSafeDir(DIR_A), true, "process.cwd() is absolute + existing + clean");
  assert.equal(isSafeDir(DIR_B), true, "os.tmpdir() is absolute + existing + clean");
  const scratch = mkdtempSync(path.join(os.tmpdir(), "fork-add-dir-"));
  try {
    assert.equal(isSafeDir(scratch), true, "a freshly mkdtemp'd absolute dir is safe");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("1.2 isSafeDir is FALSE for relative, non-existent, and metacharacter paths", () => {
  assert.equal(isSafeDir("relative/dir"), false, "relative → false (not absolute)");
  assert.equal(
    isSafeDir(path.join(os.tmpdir(), "fork-add-dir-__definitely-missing__")),
    false,
    "non-existent absolute → false (existsSync)",
  );
  // Metacharacter cases: each forbidden char rejected even if the rest looked absolute+existing-ish.
  assert.equal(isSafeDir(`${DIR_B}/a"b`), false, 'double-quote → false');
  assert.equal(isSafeDir(`${DIR_B}/a$b`), false, "dollar → false");
  assert.equal(isSafeDir(`${DIR_B}/a\`b`), false, "backtick → false");
  assert.equal(isSafeDir(`${DIR_B}/a\nb`), false, "newline → false");
  assert.equal(isSafeDir(`${DIR_B}/a\rb`), false, "carriage-return → false");
});

// ── Scenario 6: billing-guard regression — no credit token; coexists with the other flags ─────────────
test("1.1 billing-guard: --add-dir adds NO -p/--print/--output-format/stream-json (set OR unset, fresh + resume)", () => {
  assert.ok(carriesNoCreditToken(buildClaudeCmd(ID, undefined, undefined, undefined, undefined, [DIR_A, DIR_B])));
  assert.ok(carriesNoCreditToken(buildClaudeCmd(ID, undefined, undefined, undefined, undefined, undefined)));
  assert.ok(carriesNoCreditToken(buildResumeArgv(ID, undefined, undefined, undefined, [DIR_A, DIR_B])[1]));
  assert.ok(carriesNoCreditToken(buildResumeArgv(ID, undefined, undefined, undefined, undefined)[1]));
});

test("1.1 --add-dir coexists with --effort, --permission-mode and --agent (all present, dirs quoted)", () => {
  // fresh: permission-mode + (settings undefined) + effort + agent + dirs
  const fresh = buildClaudeCmd(ID, "acceptEdits", undefined, "high", "code-reviewer", [DIR_A]);
  assert.ok(fresh.includes("--permission-mode acceptEdits"), `permission-mode present: ${fresh}`);
  assert.ok(fresh.includes("--effort high"), `effort present: ${fresh}`);
  assert.ok(fresh.includes('--agent "code-reviewer"'), `agent quoted & present: ${fresh}`);
  assert.ok(fresh.includes(`--add-dir "${DIR_A}"`), `dir quoted & present: ${fresh}`);
  assert.ok(carriesNoCreditToken(fresh), `combo smuggled a credit token: ${fresh}`);

  // resume: permission-mode + effort + agent + dirs, carried into both halves
  const resume = buildResumeArgv(ID, "bypassPermissions", "high", "code-reviewer", [DIR_A])[1];
  assert.ok(resume.includes("--permission-mode bypassPermissions"), `resume permission-mode: ${resume}`);
  assert.ok(resume.includes("--effort high"), `resume effort: ${resume}`);
  assert.equal(count(resume, '--agent "code-reviewer"'), 2, `resume agent in both halves: ${resume}`);
  assert.equal(count(resume, `--add-dir "${DIR_A}"`), 2, `resume dir in both halves: ${resume}`);
  assert.ok(resume.includes("|| claude"), `resume fallback preserved: ${resume}`);
  assert.ok(carriesNoCreditToken(resume), `resume combo smuggled a credit token: ${resume}`);
});
