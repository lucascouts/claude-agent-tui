// Story 056 / Task 3.3 — the `--agent "<name>"` spawn flag (fresh + resume) with name quoting (R3.3).
//
// CONTRACT (story.md R3.3 + agent-catalog.ts header):
//  - `buildClaudeCmd`/`buildSpawnArgv` (fresh) and `buildResumeArgv` (resume) emit the agent persona as
//    the DOUBLE-QUOTED, interactive-only `--agent "<name>"`. The resume argv carries it into BOTH the
//    `--resume "<id>"` launch AND the `|| claude` fresh fallback (it is folded into `flags`).
//  - SECURITY (the highest-severity item): the flag is the SECOND layer of a two-layer command-injection
//    defense. It is emitted ONLY when the name passes the R3.3 allowlist (`/^[A-Za-z0-9_-]+$/`); an unsafe
//    name (spaces, shell metacharacters, command substitution, …) is DROPPED — never interpolated into the
//    `-lc` shell string. (The catalog already drops unsafe names at discovery; this re-asserts at spawn.)
//  - BILLING: the flag is interactive-only — it adds NO `-p`/`--print`/`--output-format`/`stream-json`
//    (billing stays subscription `cli`), and coexists with `--effort`/`--permission-mode`.
//
// Pure functions over the argv builders — no spawn, no claude. node:test (build first — behavioral
// imports resolve against ../dist):
//   node --experimental-strip-types --test test/spawn-agent-flag.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildClaudeCmd, buildSpawnArgv } from "../dist/engine-pty.js";
import { buildResumeArgv } from "../dist/engine-lifecycle.js";

const ID = "11111111-1111-4111-8111-111111111111";

/** Whole-token billing guard — `--permission-mode` legitimately contains "-p" as a substring, so match
 *  the bare `-p` token / the credit fragments only. `--output-format stream-json` is the SDK/credit path. */
function carriesNoCreditToken(cmd: string): boolean {
  return !/(^|\s)-p(\s|$)|--print|--output-format|stream-json/.test(cmd);
}

// ── Scenario 1: fresh-spawn buildClaudeCmd emits the double-quoted flag; absent → no flag ─────────────
test("3.3 buildClaudeCmd with agent='code-reviewer' emits --agent \"code-reviewer\" (double-quoted) (R3.3)", () => {
  const cmd = buildClaudeCmd(ID, undefined, undefined, undefined, "code-reviewer");
  assert.ok(
    cmd.includes('--agent "code-reviewer"'),
    `expected double-quoted --agent "code-reviewer" in: ${cmd}`,
  );
});

test("3.3 buildClaudeCmd with no agent emits NO --agent flag (backward compat)", () => {
  const cmd = buildClaudeCmd(ID, undefined, undefined, undefined, undefined);
  assert.ok(!cmd.includes("--agent"), `no agent must not add a --agent flag, got: ${cmd}`);
  // and with NO optional args at all it stays byte-for-byte the pre-056 fresh spawn.
  assert.equal(buildClaudeCmd(ID), `claude --session-id ${ID}`);
});

test("3.3 the 'default' agent sentinel emits NO --agent flag (= no persona, mirrors --effort/--permission-mode)", () => {
  // "default" is the no-persona sentinel in the agent config option (parity with the mode/effort
  // "default"); it must NOT spawn `--agent "default"` — there is no persona by that name.
  assert.ok(
    !buildClaudeCmd(ID, undefined, undefined, undefined, "default").includes("--agent"),
    "default sentinel must not emit --agent (fresh)",
  );
  const resume = buildResumeArgv(ID, undefined, undefined, "default")[1];
  assert.equal(resume, `claude --resume "${ID}" || claude`, "default sentinel keeps the no-flag resume skeleton");
});

test("3.3 buildSpawnArgv threads the agent: argv[0]==-lc and argv[1] carries the quoted flag (R3.3)", () => {
  const argv = buildSpawnArgv(ID, undefined, undefined, undefined, "code-reviewer");
  assert.equal(argv[0], "-lc", "login-shell flag stays -lc");
  assert.ok(
    argv[1].includes('--agent "code-reviewer"'),
    `expected double-quoted --agent in argv[1]: ${argv[1]}`,
  );
});

// ── Scenario 2: resume argv carries the flag into BOTH the --resume AND the || claude fallback ────────
test("3.3 buildResumeArgv carries --agent \"code-reviewer\" into BOTH resume halves (appears twice) (R3.3)", () => {
  const argv = buildResumeArgv(ID, undefined, undefined, "code-reviewer");
  assert.equal(argv[0], "-c", "resume argv keeps the -c shell flag");
  const cmd = argv[1];

  // The flag must reach BOTH the `--resume "<id>"` launch AND the `|| claude` fresh fallback.
  const occurrences = cmd.split('--agent "code-reviewer"').length - 1;
  assert.equal(occurrences, 2, `--agent must appear in BOTH resume halves (twice), got ${occurrences}: ${cmd}`);

  // Anchor each half explicitly: the --resume segment and the || claude fallback each carry the flag.
  assert.ok(
    /--resume "[^"]+"[^|]*--agent "code-reviewer"/.test(cmd),
    `the --resume launch must carry the agent flag: ${cmd}`,
  );
  assert.ok(
    /\|\| claude .*--agent "code-reviewer"/.test(cmd),
    `the || claude fallback must carry the agent flag: ${cmd}`,
  );
});

test("3.3 buildResumeArgv with no agent: no --agent and the || claude fallback is intact (backward compat)", () => {
  assert.deepEqual(buildResumeArgv(ID), ["-c", `claude --resume "${ID}" || claude`]);
  const argv = buildResumeArgv(ID, undefined, undefined, undefined);
  assert.ok(!argv[1].includes("--agent"), `no agent must not add a --agent flag, got: ${argv[1]}`);
  assert.ok(argv[1].includes("|| claude"), `the robust resume fallback must be preserved: ${argv[1]}`);
});

// ── Scenario 3: SECURITY — an unsafe name is DROPPED (no flag, no metacharacter leak) ─────────────────
test("3.3 SECURITY: an unsafe agent name is DROPPED — no --agent flag, no metacharacter leaks (fresh + resume)", () => {
  const unsafe = ["evil; rm -rf ~", "a b", "a$(whoami)", '"; cat /etc/passwd; "', "../../etc/passwd"];
  for (const name of unsafe) {
    const fresh = buildClaudeCmd(ID, undefined, undefined, undefined, name);
    const resume = buildResumeArgv(ID, undefined, undefined, name)[1];

    // The guard must drop the flag entirely on an unsafe name.
    assert.ok(!fresh.includes("--agent"), `unsafe name must NOT emit --agent (fresh): ${name} → ${fresh}`);
    assert.ok(
      !resume.includes("--agent"),
      `unsafe name must NOT emit --agent (resume): ${name} → ${resume}`,
    );

    // And no raw shell metacharacter from the rejected name may leak into either command string.
    for (const meta of [";", "$", "(", ")", " b", "..", "/etc"]) {
      if (name.includes(meta)) {
        assert.ok(
          !fresh.includes(meta),
          `metacharacter ${JSON.stringify(meta)} from rejected name leaked (fresh): ${fresh}`,
        );
        // The resume command legitimately contains "/" via no path here and "(" nowhere; assert the
        // rejected name's own metacharacters do not appear beyond the fixed argv skeleton.
        const skeleton = `claude --resume "${ID}" || claude`;
        assert.equal(resume, skeleton, `resume must stay the no-flag skeleton for ${name}: ${resume}`);
      }
    }
  }
});

// ── Scenario 4: billing-guard regression — no credit token, and coexists with effort + permission-mode ─
test("3.3 billing-guard: the --agent flag adds NO -p/--print/--output-format/stream-json (set OR unset)", () => {
  assert.ok(carriesNoCreditToken(buildClaudeCmd(ID, undefined, undefined, undefined, "code-reviewer")));
  assert.ok(carriesNoCreditToken(buildClaudeCmd(ID, undefined, undefined, undefined, undefined)));
  assert.ok(carriesNoCreditToken(buildResumeArgv(ID, undefined, undefined, "code-reviewer")[1]));
  assert.ok(carriesNoCreditToken(buildResumeArgv(ID, undefined, undefined, undefined)[1]));
});

test("3.3 the agent flag coexists with --effort and --permission-mode (all three present, agent quoted)", () => {
  // fresh: permission-mode + (settings undefined) + effort + agent
  const fresh = buildClaudeCmd(ID, "acceptEdits", undefined, "high", "code-reviewer");
  assert.ok(fresh.includes("--permission-mode acceptEdits"), `permission-mode present: ${fresh}`);
  assert.ok(fresh.includes("--effort high"), `effort present: ${fresh}`);
  assert.ok(fresh.includes('--agent "code-reviewer"'), `agent quoted & present: ${fresh}`);
  assert.ok(carriesNoCreditToken(fresh), `all-three combo smuggled a credit token: ${fresh}`);

  // resume: permission-mode + effort + agent, carried into both halves
  const resume = buildResumeArgv(ID, "bypassPermissions", "high", "code-reviewer")[1];
  assert.ok(resume.includes("--permission-mode bypassPermissions"), `resume permission-mode: ${resume}`);
  assert.ok(resume.includes("--effort high"), `resume effort: ${resume}`);
  assert.equal(
    resume.split('--agent "code-reviewer"').length - 1,
    2,
    `resume agent must appear in both halves: ${resume}`,
  );
  assert.ok(resume.includes("|| claude"), `resume fallback preserved: ${resume}`);
  assert.ok(carriesNoCreditToken(resume), `resume all-three combo smuggled a credit token: ${resume}`);
});
