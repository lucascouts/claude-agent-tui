// Story 056 / Task 3.1 (R3.1, R3.3) — unit tests for the main-thread agent-persona discovery.
//
// `agent-catalog.ts` is GLOB-ONLY (no `claude` spawn — `claude agents` is the background-agents
// manager, not a persona list, per the orchestrator's LIVE-VERIFY) and PURE + dependency-injectable.
// Every test here drives discovery through an INJECTED FAKE FS (`deps.homedir` / `deps.readdirMd` /
// `deps.readFile`): the real `~/.claude/agents` and `<cwd>/.claude/agents` are never touched, and on
// the dev box both are empty anyway. That isolation is what lets us assert the security drop (R3.3)
// deterministically.
//
// node:test runner: `node --experimental-strip-types --test test/agent-catalog.test.ts`
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  discoverAgents,
  isSafeAgentName,
  isSafeAgentRef,
  parseAvailableAgents,
  parseFrontmatter,
  SAFE_AGENT_NAME,
  SAFE_AGENT_REF,
  type AgentCatalogEntry,
  type DiscoverAgentsDeps,
} from "../src/agent-catalog.ts";

const HOME = "/home/tester";
const CWD = "/work/project";
const PROJECT_DIR = join(CWD, ".claude", "agents");
const USER_DIR = join(HOME, ".claude", "agents");

/**
 * Build injectable `deps` from a flat in-memory fs: `files[absPath] = contents`. `readdirMd` lists the
 * `*.md` basenames whose parent dir is `dir` (unknown dir → `[]`, matching the real graceful default);
 * `readFile` returns the mapped contents or throws ENOENT-style (so the "unreadable file" path is
 * exercised when a listing references a missing file). `homedir` is pinned to {@link HOME}.
 */
function fakeDeps(files: Record<string, string>): DiscoverAgentsDeps {
  return {
    // Task 7: the probe is the PRIMARY source — force the glob FALLBACK for these on-disk tests by
    // making the probe yield nothing (binary absent). The probe path has its own dedicated tests below.
    probeClaudeAgents: () => null,
    homedir: () => HOME,
    readdirMd: (dir: string) =>
      Object.keys(files)
        .filter((p) => p.startsWith(dir + "/") && !p.slice(dir.length + 1).includes("/"))
        .filter((p) => p.toLowerCase().endsWith(".md"))
        .map((p) => p.slice(dir.length + 1)),
    readFile: (path: string) => {
      const c = files[path];
      if (c === undefined) throw new Error(`ENOENT: no such file '${path}'`);
      return c;
    },
  };
}

/** Look up an entry by `value` (or `undefined`), for precise per-entry assertions. */
function byValue(entries: AgentCatalogEntry[], value: string): AgentCatalogEntry | undefined {
  return entries.find((e) => e.value === value);
}

// === Scenario 1: frontmatter parsed from BOTH dirs ==============================================

test("discoverAgents: parses name + description frontmatter from BOTH user and project dirs", () => {
  const deps = fakeDeps({
    [join(PROJECT_DIR, "reviewer.md")]:
      "---\nname: reviewer\ndescription: Reviews diffs for bugs\n---\nBody.\n",
    [join(USER_DIR, "planner.md")]:
      "---\nname: planner\ndescription: Plans multi-step work\n---\nBody.\n",
  });

  const result = discoverAgents(CWD, deps);

  assert.equal(result.length, 2, "one entry per dir");
  assert.deepEqual(byValue(result, "reviewer"), {
    value: "reviewer",
    displayName: "reviewer",
    description: "Reviews diffs for bugs",
  });
  assert.deepEqual(byValue(result, "planner"), {
    value: "planner",
    displayName: "planner",
    description: "Plans multi-step work",
  });
});

// === Scenario 2: dedup — project wins =============================================================

test("discoverAgents: dedups by value across dirs — PROJECT entry wins (precedence)", () => {
  const deps = fakeDeps({
    [join(PROJECT_DIR, "shared.md")]: "---\nname: shared\ndescription: PROJECT version\n---\n",
    [join(USER_DIR, "shared.md")]: "---\nname: shared\ndescription: USER version\n---\n",
  });

  const result = discoverAgents(CWD, deps);

  assert.equal(result.length, 1, "duplicate value collapses to one entry");
  assert.equal(result[0].value, "shared");
  assert.equal(
    result[0].description,
    "PROJECT version",
    "the project-dir entry must win the dedup",
  );
});

// === Scenario 3: SECURITY — unsafe names are DROPPED (R3.3 regression) ===========================

test("discoverAgents: DROPS personas whose resolved name is unsafe (R3.3 command-injection guard)", () => {
  const deps = fakeDeps({
    // Clearly-malicious: command-substitution / chaining in the frontmatter name.
    [join(PROJECT_DIR, "evil.md")]: "---\nname: evil; rm -rf ~\n---\n",
    [join(PROJECT_DIR, "subst.md")]: "---\nname: a$(whoami)\n---\n",
    // Spaces and embedded quotes also break the `--agent \"<name>\"` boundary → dropped.
    [join(USER_DIR, "spaced.md")]: "---\nname: a b\n---\n",
    [join(USER_DIR, "quoted.md")]: '---\nname: a"b\n---\n',
    // Unsafe filename WITHOUT frontmatter name (the fallback name must also be sanitized).
    [join(USER_DIR, "bad name.md")]: "no frontmatter here\n",
    // One legitimately-safe persona must survive to prove we drop only the unsafe ones.
    [join(PROJECT_DIR, "safe.md")]: "---\nname: safe_one-2\ndescription: ok\n---\n",
  });

  const result = discoverAgents(CWD, deps);

  // The malicious / malformed names are absent — this is the assertion that fails if the
  // sanitizer (isSafeAgentName) were removed.
  assert.equal(byValue(result, "evil; rm -rf ~"), undefined, "command-chaining name dropped");
  assert.equal(byValue(result, "a$(whoami)"), undefined, "command-substitution name dropped");
  assert.equal(byValue(result, "a b"), undefined, "spaced name dropped");
  assert.equal(byValue(result, 'a"b'), undefined, "embedded-quote name dropped");
  assert.equal(byValue(result, "bad name"), undefined, "unsafe filename-fallback dropped");

  // Only the one safe persona remains, and every returned value matches the allowlist.
  assert.deepEqual(
    result.map((e) => e.value),
    ["safe_one-2"],
    "exactly the safe persona survives",
  );
  for (const e of result) {
    assert.ok(SAFE_AGENT_NAME.test(e.value), `returned value must be safe: ${e.value}`);
  }
});

// === Scenario 4: empty / missing dirs ⇒ [] (no throw) ===========================================

test("discoverAgents: empty/missing dirs yield [] and never throw", () => {
  // No files at all → both readdirMd calls return [].
  assert.deepEqual(discoverAgents(CWD, fakeDeps({})), []);

  // Listing references a file that readFile cannot read → that file is skipped, result still [].
  const flaky: DiscoverAgentsDeps = {
    probeClaudeAgents: () => null, // force the glob fallback (no real `claude` spawn)
    homedir: () => HOME,
    readdirMd: (dir: string) => (dir === PROJECT_DIR ? ["ghost.md"] : []),
    readFile: () => {
      throw new Error("EACCES: permission denied");
    },
  };
  assert.deepEqual(discoverAgents(CWD, flaky), [], "unreadable file is skipped, no throw");
});

// === Scenario 5: filename-fallback when frontmatter has no name ==================================

test("discoverAgents: falls back to the filename stem when frontmatter has no name", () => {
  const deps = fakeDeps({
    // No `name` key → value is the stem; displayName is the humanized stem.
    [join(PROJECT_DIR, "code-reviewer.md")]: "---\ndescription: From the filename\n---\nBody.\n",
    // No frontmatter fence at all → still falls back to the stem (and stays since stem is safe).
    [join(USER_DIR, "db_admin.md")]: "Just a body, no frontmatter.\n",
  });

  const result = discoverAgents(CWD, deps);

  assert.deepEqual(byValue(result, "code-reviewer"), {
    value: "code-reviewer",
    displayName: "Code Reviewer",
    description: "From the filename",
  });
  assert.deepEqual(byValue(result, "db_admin"), {
    value: "db_admin",
    displayName: "Db Admin",
  });
});

// === Sorting + determinism ======================================================================

test("discoverAgents: returns a stable array sorted by value", () => {
  const deps = fakeDeps({
    [join(PROJECT_DIR, "zeta.md")]: "---\nname: zeta\n---\n",
    [join(PROJECT_DIR, "alpha.md")]: "---\nname: alpha\n---\n",
    [join(USER_DIR, "mid.md")]: "---\nname: mid\n---\n",
  });

  const result = discoverAgents(CWD, deps);
  assert.deepEqual(
    result.map((e) => e.value),
    ["alpha", "mid", "zeta"],
  );
});

// === Direct unit coverage of the security predicate (belt-and-braces for R3.3) ===================

test("isSafeAgentName / SAFE_AGENT_NAME: accepts safe names, rejects unsafe ones", () => {
  for (const ok of ["a", "Code_Reviewer", "db-admin-2", "X9", "_under", "-dash"]) {
    assert.ok(isSafeAgentName(ok), `should accept ${ok}`);
  }
  for (const bad of [
    "",
    "a b",
    "evil; rm -rf ~",
    "a$(whoami)",
    'a"b',
    "a/b",
    "a.b",
    "héllo",
    "a\nb",
    null,
    undefined,
    42,
  ]) {
    assert.ok(!isSafeAgentName(bad as unknown), `should reject ${String(bad)}`);
  }
});

// === Frontmatter parser edge cases ==============================================================

test("parseFrontmatter: handles quotes, missing fence, and ignores non key:value lines", () => {
  assert.deepEqual(parseFrontmatter('---\nname: "quoted name"\ndescription: \'q\'\n---\n'), {
    name: "quoted name",
    description: "q",
  });
  // No opening fence → {}.
  assert.deepEqual(parseFrontmatter("name: nope\nbody\n"), {});
  // Fence present but no name/description keys, plus a list line that must be ignored.
  assert.deepEqual(parseFrontmatter("---\ntools:\n  - Read\nmodel: opus\n---\n"), {});
  // Empty value is treated as absent.
  assert.deepEqual(parseFrontmatter("---\nname:\ndescription: has\n---\n"), { description: "has" });
});

// === Task 7: HYBRID PROBE path (R3.5, R3.6) =====================================================

// The exact `claude --agent <invalid>` rejection line captured live against 2.1.195 — the PRIMARY
// discovery source. Namespaced plugin personas + bare built-ins; the bare `claude` is the no-persona
// default and must be dropped.
const PROBE_LINE =
  "--agent '__sentinel__' not found. Available agents: bentoo-dev:ebuild-bumper, " +
  "bentoo-dev:ebuild-creator, bentoo-dev:ebuild-editor, bentoo-dev:overlay-maintainer, " +
  "bentoo-dev:qa-checker, claude, claude-code-guide, epic:analyst, epic:architect, epic:auditor, " +
  "epic:executor, epic:reviewer, epic:tech-reviewer, epic:test-advisor, epic:validator, Explore, " +
  "general-purpose, Plan, statusline-setup\n";

test("parseAvailableAgents: extracts the comma list, ignores the prefix, trims, drops empties", () => {
  assert.deepEqual(parseAvailableAgents("x not found. Available agents: a, b:c ,  , d\n"), [
    "a",
    "b:c",
    "d",
  ]);
  // No `Available agents:` line ⇒ [] (the signal to fall back to the glob).
  assert.deepEqual(parseAvailableAgents("some unrelated error text"), []);
  assert.deepEqual(parseAvailableAgents(""), []);
});

test("discoverAgents: PRIMARY probe wins — namespaced personas + built-ins, `claude` dropped", () => {
  // A populated glob is also provided to prove the probe takes PRECEDENCE (glob never consulted).
  const result = discoverAgents(CWD, {
    probeClaudeAgents: () => PROBE_LINE,
    homedir: () => HOME,
    readdirMd: () => ["should-not-be-read.md"],
    readFile: () => {
      throw new Error("glob must not be consulted when the probe yields personas");
    },
  });

  // The bare `claude` no-persona default is dropped; everything else survives.
  assert.equal(result.length, 18, "19 listed minus the bare `claude` default");
  assert.equal(
    byValue(result, "claude"),
    undefined,
    "the bare `claude` built-in (no-persona default) is dropped",
  );
  // Namespaced plugin persona present, with the raw reference as both value and displayName.
  assert.deepEqual(byValue(result, "epic:analyst"), {
    value: "epic:analyst",
    displayName: "epic:analyst",
  });
  // Built-ins (no `:`) survive too.
  assert.ok(byValue(result, "Explore"), "built-in Explore present");
  assert.ok(byValue(result, "general-purpose"), "built-in general-purpose present");
  // Sorted by value, and every returned reference is allowlist-safe (R3.6).
  assert.deepEqual([...result].map((e) => e.value).sort(), result.map((e) => e.value));
  for (const e of result) {
    assert.ok(isSafeAgentRef(e.value), `probe value must be ref-safe: ${e.value}`);
  }
});

test("discoverAgents: SECURITY — a probe-listed unsafe/multi-segment name is DROPPED", () => {
  const result = discoverAgents(CWD, {
    probeClaudeAgents: () =>
      "Available agents: epic:analyst, evil;rm -rf ~, a:b:c, plug:in:agent, ok-one\n",
    homedir: () => HOME,
    readdirMd: () => [],
    readFile: () => "",
  });
  assert.deepEqual(
    result.map((e) => e.value),
    ["epic:analyst", "ok-one"],
    "command-chaining and >1-segment names dropped; safe single/namespaced survive",
  );
});

test("discoverAgents: FALLBACK to glob when the probe is unavailable or its format changed", () => {
  const files = {
    [join(PROJECT_DIR, "local.md")]: "---\nname: local\ndescription: on-disk\n---\n",
  };
  const readdirMd = (dir: string) =>
    dir === PROJECT_DIR ? ["local.md"] : ([] as string[]);
  const readFile = (p: string) => {
    const c = files[p];
    if (c === undefined) throw new Error("ENOENT");
    return c;
  };

  // (a) probe returns null (binary missing) → glob.
  assert.deepEqual(
    discoverAgents(CWD, { probeClaudeAgents: () => null, homedir: () => HOME, readdirMd, readFile })
      .map((e) => e.value),
    ["local"],
  );
  // (b) probe returns text WITHOUT an `Available agents:` line → glob.
  assert.deepEqual(
    discoverAgents(CWD, {
      probeClaudeAgents: () => "claude: command failed (some new error shape)",
      homedir: () => HOME,
      readdirMd,
      readFile,
    }).map((e) => e.value),
    ["local"],
  );
  // (c) probe lists ONLY the bare `claude` (nothing selectable) → falls back to glob.
  assert.deepEqual(
    discoverAgents(CWD, {
      probeClaudeAgents: () => "Available agents: claude\n",
      homedir: () => HOME,
      readdirMd,
      readFile,
    }).map((e) => e.value),
    ["local"],
  );
});

test("discoverAgents: the DEFAULT probe is OPT-IN — without FORK_AGENT_PROBE it never spawns (glob)", () => {
  // Drive the REAL default probe (no injected `probeClaudeAgents`) with the flag cleared: the gate
  // must short-circuit to `null` so discovery falls back to the (here empty) glob — no `claude` spawn.
  const saved = process.env.FORK_AGENT_PROBE;
  delete process.env.FORK_AGENT_PROBE;
  try {
    assert.deepEqual(
      discoverAgents(CWD, { homedir: () => HOME, readdirMd: () => [], readFile: () => "" }),
      [],
      "gated-off default probe yields the empty glob, never spawning the real claude",
    );
  } finally {
    if (saved === undefined) delete process.env.FORK_AGENT_PROBE;
    else process.env.FORK_AGENT_PROBE = saved;
  }
});

test("isSafeAgentRef / SAFE_AGENT_REF: accepts single + namespaced, rejects multi-segment/unsafe", () => {
  for (const ok of ["a", "Explore", "general-purpose", "epic:analyst", "bentoo-dev:qa-checker", "_x:y-2"]) {
    assert.ok(isSafeAgentRef(ok), `should accept ${ok}`);
    assert.ok(SAFE_AGENT_REF.test(ok), `regex should accept ${ok}`);
  }
  for (const bad of [
    "",
    "a:b:c", // more than one namespace segment
    "a:", // empty second segment
    ":b", // empty first segment
    "a b",
    "epic:ana lyst",
    "evil;rm -rf ~",
    "a$(whoami)",
    "a/b",
    "a.b",
    null,
    undefined,
    42,
  ]) {
    assert.ok(!isSafeAgentRef(bad as unknown), `should reject ${String(bad)}`);
  }
  // The single-segment allowlist still rejects the `:` that the ref allows.
  assert.ok(!isSafeAgentName("epic:analyst"), "SAFE_AGENT_NAME stays single-segment (no colon)");
});
