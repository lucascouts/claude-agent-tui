// Story 057 / Task 2.2 — the `--mcp-config "<file>"` spawn flag (fresh + resume), DOUBLE-QUOTED, with
// the R2.2 HARD rule that `--strict-mcp-config` is emitted NOWHERE (so claude MERGES the fork's scratch
// MCP config with the user's own `.mcp.json`/settings servers, instead of discarding them).
//
// CONTRACT (story.md R2.2):
//  - `buildClaudeCmd`/`buildSpawnArgv` (fresh) and `buildResumeArgv` (resume) emit the scratch MCP-config
//    PATH as the DOUBLE-QUOTED, interactive-only `--mcp-config "<file>"` flag (same style as `--settings`
//    — a file path, so the secret-bearing JSON stays OFF the command line and survives `-lc`/`-c` shell
//    word-splitting). The resume argv carries the flag into BOTH the `--resume "<id>"` launch AND the
//    `|| claude` fresh fallback (the fragment is folded into the shared `flags`), so it appears TWICE.
//  - HARD RULE (R2.2): `--strict-mcp-config` / `--strict` appears NOWHERE in any output (set OR unset) —
//    without it claude MERGES the scratch with the user's MCP servers (the parity target); strict would
//    DISCARD them.
//  - BACKWARD COMPAT: unset/undefined → NO `--mcp-config`; the `|| claude` fallback stays intact.
//  - BILLING: the flag is interactive-only — it adds NO `-p`/`--print`/`--output-format`/`stream-json`
//    (billing stays subscription `cli`), and coexists with the other behavior flags WITHOUT disturbing
//    task 1.1's `--add-dir`.
//
// The value is just a string PATH here (this task only plumbs the param — task 2.3 wires the real
// mcp-config-writer scratch). Pure functions over the argv builders — no spawn, no claude. node:test
// (build first — behavioral imports resolve against ../dist):
//   node --experimental-strip-types --test test/spawn-mcp-config.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import { buildClaudeCmd, buildSpawnArgv } from "../dist/engine-pty.js";
import { buildResumeArgv } from "../dist/engine-lifecycle.js";

const ID = "22222222-2222-4222-8222-222222222222";

/** Whole-token billing guard — `--permission-mode` legitimately contains "-p" as a substring, so match
 *  the bare `-p` token / the credit fragments only. `--output-format stream-json` is the SDK/credit path.
 *  (Same helper as spawn-add-dir.test.ts.) */
function carriesNoCreditToken(cmd: string): boolean {
  return !/(^|\s)-p(\s|$)|--print|--output-format|stream-json/.test(cmd);
}

/** Count non-overlapping occurrences of `needle` in `haystack` (the "appears twice" resume idiom). */
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** The R2.2 HARD-RULE guard: `--strict-mcp-config` / a bare `--strict` token must appear NOWHERE. */
function carriesNoStrict(cmd: string): boolean {
  return !/--strict/.test(cmd);
}

// A plausible fork-controlled scratch path (a real existing dir basename keeps it realistic — but the
// builders never touch the filesystem for this flag, so any string is fine). Double-quoted on emit.
const MCP_FILE = `${os.tmpdir()}/fork-mcp-22222222-2222-4222-8222-222222222222.json`;

// ── Scenario 1: fresh-spawn emits EXACTLY ONE double-quoted --mcp-config when set (R2.2) ───────────────
test("2.2 buildClaudeCmd emits exactly one double-quoted --mcp-config \"<file>\" when set", () => {
  const cmd = buildClaudeCmd(ID, undefined, undefined, undefined, undefined, undefined, MCP_FILE);
  assert.ok(cmd.includes(`--mcp-config "${MCP_FILE}"`), `mcp-config quoted & present: ${cmd}`);
  assert.equal(count(cmd, "--mcp-config "), 1, `exactly one --mcp-config flag: ${cmd}`);
  assert.ok(carriesNoStrict(cmd), `R2.2: --strict must NEVER appear: ${cmd}`);
});

test("2.2 buildSpawnArgv threads the flag: argv[0]==-lc and argv[1] carries one quoted --mcp-config", () => {
  const argv = buildSpawnArgv(ID, undefined, undefined, undefined, undefined, undefined, MCP_FILE);
  assert.equal(argv[0], "-lc", "login-shell flag stays -lc");
  assert.ok(argv[1].includes(`--mcp-config "${MCP_FILE}"`), `mcp-config in argv[1]: ${argv[1]}`);
  assert.equal(count(argv[1], "--mcp-config "), 1, `exactly one --mcp-config in argv[1]: ${argv[1]}`);
  assert.ok(carriesNoStrict(argv[1]), `R2.2: --strict must NEVER appear: ${argv[1]}`);
});

// ── Scenario 2: resume argv carries the flag into BOTH halves (appears twice) (R2.2) ───────────────────
test("2.2 buildResumeArgv carries --mcp-config into BOTH resume halves (appears twice)", () => {
  const argv = buildResumeArgv(ID, undefined, undefined, undefined, undefined, MCP_FILE);
  assert.equal(argv[0], "-c", "resume argv keeps the -c shell flag");
  const cmd = argv[1];

  // The flag must reach BOTH the `--resume "<id>"` launch AND the `|| claude` fresh fallback.
  assert.equal(
    count(cmd, `--mcp-config "${MCP_FILE}"`),
    2,
    `--mcp-config must appear in BOTH resume halves: ${cmd}`,
  );

  // Anchor each half explicitly: the --resume segment and the || claude fallback each carry the flag.
  const escFile = MCP_FILE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.ok(
    new RegExp(`--resume "[^"]+"[^|]*--mcp-config "${escFile}"`).test(cmd),
    `the --resume launch must carry --mcp-config: ${cmd}`,
  );
  assert.ok(
    new RegExp(`\\|\\| claude .*--mcp-config "${escFile}"`).test(cmd),
    `the || claude fallback must carry --mcp-config: ${cmd}`,
  );
  assert.ok(cmd.includes("|| claude"), `the robust resume fallback must be preserved: ${cmd}`);
  assert.ok(carriesNoStrict(cmd), `R2.2: --strict must NEVER appear on the resume path: ${cmd}`);
});

// ── Scenario 3: unset / undefined → ZERO --mcp-config (backward compat; fallback intact) ───────────────
test("2.2 buildClaudeCmd with no mcpConfigFile emits NO --mcp-config (backward compat)", () => {
  assert.ok(
    !buildClaudeCmd(ID, undefined, undefined, undefined, undefined, undefined, undefined).includes(
      "--mcp-config",
    ),
    "undefined mcpConfigFile must add no --mcp-config flag",
  );
  // with NO optional args at all it stays byte-for-byte the pre-057 fresh spawn.
  assert.equal(buildClaudeCmd(ID), `claude --session-id ${ID}`);
});

test("2.2 buildResumeArgv with no mcpConfigFile: no --mcp-config and the || claude fallback is intact", () => {
  assert.deepEqual(buildResumeArgv(ID), ["-c", `claude --resume "${ID}" || claude`]);
  const argv = buildResumeArgv(ID, undefined, undefined, undefined, undefined, undefined);
  assert.ok(!argv[1].includes("--mcp-config"), `unset must not add a --mcp-config flag: ${argv[1]}`);
  assert.ok(argv[1].includes("|| claude"), `the robust resume fallback must be preserved: ${argv[1]}`);
});

// ── Scenario 4: R2.2 HARD RULE — --strict-mcp-config / --strict appears NOWHERE (set OR unset) ─────────
test("2.2 R2.2: --strict-mcp-config / --strict appears NOWHERE (fresh + resume, set AND unset)", () => {
  // set
  assert.ok(carriesNoStrict(buildClaudeCmd(ID, undefined, undefined, undefined, undefined, undefined, MCP_FILE)));
  assert.ok(carriesNoStrict(buildSpawnArgv(ID, undefined, undefined, undefined, undefined, undefined, MCP_FILE)[1]));
  assert.ok(carriesNoStrict(buildResumeArgv(ID, undefined, undefined, undefined, undefined, MCP_FILE)[1]));
  // unset
  assert.ok(carriesNoStrict(buildClaudeCmd(ID, undefined, undefined, undefined, undefined, undefined, undefined)));
  assert.ok(carriesNoStrict(buildResumeArgv(ID, undefined, undefined, undefined, undefined, undefined)[1]));
  // explicit literal sweep — the exact forbidden token must not be a substring anywhere.
  assert.ok(
    !buildClaudeCmd(ID, undefined, undefined, undefined, undefined, undefined, MCP_FILE).includes("--strict-mcp-config"),
    "fresh must never contain the literal --strict-mcp-config",
  );
  assert.ok(
    !buildResumeArgv(ID, undefined, undefined, undefined, undefined, MCP_FILE)[1].includes("--strict-mcp-config"),
    "resume must never contain the literal --strict-mcp-config",
  );
});

// ── Scenario 5: billing-guard regression — no credit token (set OR unset, fresh + resume) ──────────────
test("2.2 billing-guard: --mcp-config adds NO -p/--print/--output-format/stream-json (set OR unset)", () => {
  assert.ok(carriesNoCreditToken(buildClaudeCmd(ID, undefined, undefined, undefined, undefined, undefined, MCP_FILE)));
  assert.ok(carriesNoCreditToken(buildClaudeCmd(ID, undefined, undefined, undefined, undefined, undefined, undefined)));
  assert.ok(carriesNoCreditToken(buildResumeArgv(ID, undefined, undefined, undefined, undefined, MCP_FILE)[1]));
  assert.ok(carriesNoCreditToken(buildResumeArgv(ID, undefined, undefined, undefined, undefined, undefined)[1]));
});

// ── Scenario 6: coexistence — --mcp-config with --add-dir, --effort, --permission-mode, --agent ────────
// Confirms task 2.2 did NOT disturb task 1.1's --add-dir (both present, file double-quoted).
test("2.2 --mcp-config coexists with --add-dir, --effort, --permission-mode, --agent (fresh + resume)", () => {
  const DIR = process.cwd(); // a real existing absolute dir → isSafeDir passes → --add-dir is emitted

  // fresh: permission-mode + effort + agent + add-dir + mcp-config
  const fresh = buildClaudeCmd(ID, "acceptEdits", undefined, "high", "code-reviewer", [DIR], MCP_FILE);
  assert.ok(fresh.includes("--permission-mode acceptEdits"), `permission-mode present: ${fresh}`);
  assert.ok(fresh.includes("--effort high"), `effort present: ${fresh}`);
  assert.ok(fresh.includes('--agent "code-reviewer"'), `agent quoted & present: ${fresh}`);
  assert.ok(fresh.includes(`--add-dir "${DIR}"`), `1.1's --add-dir still present & quoted: ${fresh}`);
  assert.ok(fresh.includes(`--mcp-config "${MCP_FILE}"`), `mcp-config quoted & present: ${fresh}`);
  assert.ok(carriesNoStrict(fresh), `R2.2: --strict must NEVER appear: ${fresh}`);
  assert.ok(carriesNoCreditToken(fresh), `combo smuggled a credit token: ${fresh}`);

  // resume: all flags carried into BOTH halves
  const resume = buildResumeArgv(ID, "bypassPermissions", "high", "code-reviewer", [DIR], MCP_FILE)[1];
  assert.ok(resume.includes("--permission-mode bypassPermissions"), `resume permission-mode: ${resume}`);
  assert.ok(resume.includes("--effort high"), `resume effort: ${resume}`);
  assert.equal(count(resume, '--agent "code-reviewer"'), 2, `resume agent in both halves: ${resume}`);
  assert.equal(count(resume, `--add-dir "${DIR}"`), 2, `1.1's --add-dir in both halves: ${resume}`);
  assert.equal(count(resume, `--mcp-config "${MCP_FILE}"`), 2, `mcp-config in both halves: ${resume}`);
  assert.ok(resume.includes("|| claude"), `resume fallback preserved: ${resume}`);
  assert.ok(carriesNoStrict(resume), `R2.2: --strict must NEVER appear: ${resume}`);
  assert.ok(carriesNoCreditToken(resume), `resume combo smuggled a credit token: ${resume}`);
});
