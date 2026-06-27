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
  parseFrontmatter,
  SAFE_AGENT_NAME,
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
