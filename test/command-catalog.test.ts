// Story 063 / Task 1.1 (R1.1, R2, R3, R5) — unit tests for offline command discovery.
//
// `command-catalog.ts` mirrors the proven `agent-catalog.ts` pattern: PURE + dependency-injectable,
// so every test here drives discovery through an INJECTED FAKE FS (`deps.homedir` / `deps.readdirMd` /
// `deps.readFile`) and NEVER touches the real `~/.claude`. The built-in tier (R9, Task 1.5) is an
// injectable seam (`deps.builtins`); these disk-behaviour tests inject `builtins: []` so the command
// surface is isolated and the assertions stay stable once the real BUILTIN_COMMANDS lands in Task 1.5.
//
// node:test runner: `node --experimental-strip-types --test test/command-catalog.test.ts`
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  BUILTIN_COMMANDS,
  discoverCommands,
  isSafeCommandName,
  parseCommandFrontmatter,
  SAFE_COMMAND_NAME,
  type DiscoverCommandsDeps,
} from "../src/command-catalog.ts";

const HOME = "/home/tester";
const CWD = "/work/project";
const CWD_CMD = join(CWD, ".claude", "commands");
const USER_CMD = join(HOME, ".claude", "commands");
const CWD_SKILL = join(CWD, ".claude", "skills");
const USER_SKILL = join(HOME, ".claude", "skills");
const PLUGINS = join(HOME, ".claude", "plugins");
const MANIFEST = join(PLUGINS, "installed_plugins.json");
const MKTS = join(PLUGINS, "marketplaces");

/**
 * Build injectable `deps` from a flat in-memory fs (`files[absPath] = contents`). `readdirMd` lists the
 * `*.md` basenames whose parent dir is exactly `dir` (unknown dir → `[]`, matching the graceful
 * default); `readFile` returns the mapped contents or throws (so the "unreadable file" path is
 * exercised when a listing references a missing file). `homedir` is pinned to HOME; `builtins` defaults
 * to `[]` so these disk tests isolate the command surface from the R9 built-in tier.
 */
function fakeDeps(
  files: Record<string, string>,
  overrides: Partial<DiscoverCommandsDeps> = {},
): DiscoverCommandsDeps {
  return {
    homedir: () => HOME,
    readdirMd: (dir: string) =>
      Object.keys(files)
        .filter((p) => p.startsWith(dir + "/") && !p.slice(dir.length + 1).includes("/"))
        .filter((p) => p.toLowerCase().endsWith(".md"))
        .map((p) => p.slice(dir.length + 1))
        .sort(),
    readdirDirs: (dir: string) => {
      const prefix = dir + "/";
      const subs = new Set<string>();
      for (const p of Object.keys(files)) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        const slash = rest.indexOf("/");
        if (slash > 0) subs.add(rest.slice(0, slash));
      }
      return [...subs].sort();
    },
    readFile: (p: string) => {
      if (p in files) return files[p];
      throw new Error(`ENOENT: ${p}`);
    },
    builtins: [],
    ...overrides,
  };
}

test("empty command dirs and no built-ins → []", () => {
  assert.deepEqual(discoverCommands(CWD, fakeDeps({})), []);
});

test("valid command file → {name, description, input.hint}", () => {
  const deps = fakeDeps({
    [join(CWD_CMD, "say-hello.md")]:
      "---\ndescription: Say hello to someone\nargument-hint: <name>\n---\nBody text.",
  });
  assert.deepEqual(discoverCommands(CWD, deps), [
    { name: "say-hello", description: "Say hello to someone", input: { hint: "<name>" } },
  ]);
});

test("command name with a space is dropped (R3 allowlist)", () => {
  const deps = fakeDeps({
    [join(CWD_CMD, "say hello.md")]: "---\ndescription: bad\n---\n",
  });
  assert.deepEqual(discoverCommands(CWD, deps), []);
});

test("cwd command takes precedence over user command (single entry)", () => {
  const deps = fakeDeps({
    [join(CWD_CMD, "deploy.md")]: "---\ndescription: cwd deploy\n---\n",
    [join(USER_CMD, "deploy.md")]: "---\ndescription: user deploy\n---\n",
  });
  const out = discoverCommands(CWD, deps);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, "deploy");
  assert.equal(out[0].description, "cwd deploy");
});

test("missing frontmatter → basename as name, empty description", () => {
  const deps = fakeDeps({
    [join(CWD_CMD, "plain.md")]: "Just a body, no frontmatter.\n",
  });
  assert.deepEqual(discoverCommands(CWD, deps), [{ name: "plain", description: "" }]);
});

test("SAFE_COMMAND_NAME / isSafeCommandName enforce /^[a-z0-9_-]+$/ (R3)", () => {
  assert.ok(SAFE_COMMAND_NAME.test("say-hello"));
  assert.ok(isSafeCommandName("deploy_2"));
  assert.ok(!isSafeCommandName("Say")); // uppercase rejected
  assert.ok(!isSafeCommandName("say hello")); // space rejected
  assert.ok(!isSafeCommandName("")); // empty rejected
  assert.ok(!isSafeCommandName(42 as unknown)); // non-string rejected
});

test("parseCommandFrontmatter extracts description + argument-hint", () => {
  const fm = parseCommandFrontmatter(
    "---\ndescription: A demo\nargument-hint: <path>\n---\nbody",
  );
  assert.equal(fm.description, "A demo");
  assert.equal(fm.argumentHint, "<path>");
  assert.deepEqual(parseCommandFrontmatter("no fence"), {});
});

// --- Task 1.3 (R7, R7.1) — skill discovery: `<cwd|~>/.claude/skills/<name>/SKILL.md` -------------

const byName = (out: readonly { name: string }[], name: string) => out.find((c) => c.name === name);

test("skill dir with SKILL.md → entry named by dir, description from frontmatter (R7/R7.1)", () => {
  const deps = fakeDeps({
    [join(CWD_SKILL, "deploy-helper", "SKILL.md")]: "---\ndescription: Helps deploy\n---\nbody",
  });
  assert.deepEqual(discoverCommands(CWD, deps), [
    { name: "deploy-helper", description: "Helps deploy" },
  ]);
});

test("skill dir with an invalid name is dropped (R3)", () => {
  const deps = fakeDeps({
    [join(CWD_SKILL, "Bad Name", "SKILL.md")]: "---\ndescription: nope\n---\n",
  });
  assert.equal(byName(discoverCommands(CWD, deps), "Bad Name"), undefined);
  assert.deepEqual(discoverCommands(CWD, deps), []);
});

test("a skills subdir WITHOUT SKILL.md is not treated as a command", () => {
  const deps = fakeDeps({
    [join(CWD_SKILL, "nofile", "README.md")]: "no SKILL.md here",
  });
  assert.equal(byName(discoverCommands(CWD, deps), "nofile"), undefined);
  assert.deepEqual(discoverCommands(CWD, deps), []);
});

test("cwd skill takes precedence over a same-named user skill", () => {
  const deps = fakeDeps({
    [join(CWD_SKILL, "audit", "SKILL.md")]: "---\ndescription: cwd audit\n---\n",
    [join(USER_SKILL, "audit", "SKILL.md")]: "---\ndescription: user audit\n---\n",
  });
  const out = discoverCommands(CWD, deps);
  assert.equal(out.length, 1);
  assert.equal(byName(out, "audit")?.description, "cwd audit");
});

test("a command outranks a same-named skill in the same scope (cmd > skill)", () => {
  const deps = fakeDeps({
    [join(CWD_CMD, "foo.md")]: "---\ndescription: cmd foo\n---\n",
    [join(CWD_SKILL, "foo", "SKILL.md")]: "---\ndescription: skill foo\n---\n",
  });
  const out = discoverCommands(CWD, deps);
  assert.equal(out.length, 1);
  assert.equal(byName(out, "foo")?.description, "cmd foo");
});

// --- Task 1.4 (R8, R8.1) — plugin discovery under ~/.claude/plugins/marketplaces, gated by manifest -

/** A minimal `installed_plugins.json` enabling one `pluginN@<marketplace>` key per marketplace. */
const manifest = (marketplaces: string[]) =>
  JSON.stringify({
    version: 2,
    plugins: Object.fromEntries(
      marketplaces.map((m, i) => [`plugin${i}@${m}`, [{ scope: "user" }]]),
    ),
  });

test("enabled plugin's command AND skill are discovered (R8)", () => {
  const deps = fakeDeps({
    [MANIFEST]: manifest(["mktA"]),
    [join(MKTS, "mktA", "commands", "ship.md")]: "---\ndescription: ship it\n---",
    [join(MKTS, "mktA", "skills", "analyze", "SKILL.md")]: "---\ndescription: analyze code\n---",
  });
  const out = discoverCommands(CWD, deps);
  assert.deepEqual(byName(out, "ship"), { name: "ship", description: "ship it" });
  assert.deepEqual(byName(out, "analyze"), { name: "analyze", description: "analyze code" });
});

test("a marketplace with no installed plugin is skipped (disabled)", () => {
  const deps = fakeDeps({
    [MANIFEST]: manifest(["mktA"]), // only mktA enabled
    [join(MKTS, "mktB", "commands", "nope.md")]: "---\ndescription: no\n---",
  });
  assert.equal(byName(discoverCommands(CWD, deps), "nope"), undefined);
});

test("a malformed manifest skips plugins but keeps other surfaces (never crashes)", () => {
  const deps = fakeDeps({
    [MANIFEST]: "{ this is not valid json",
    [join(MKTS, "mktA", "commands", "ship.md")]: "---\ndescription: ship it\n---",
    [join(USER_CMD, "keep.md")]: "---\ndescription: keep me\n---",
  });
  assert.deepEqual(discoverCommands(CWD, deps), [{ name: "keep", description: "keep me" }]);
});

test("a missing manifest skips plugins gracefully", () => {
  const deps = fakeDeps({
    [join(MKTS, "mktA", "commands", "ship.md")]: "---\ndescription: ship it\n---",
  });
  assert.deepEqual(discoverCommands(CWD, deps), []);
});

test("plugin command loses a name collision to a user command (R8.1)", () => {
  const deps = fakeDeps({
    [MANIFEST]: manifest(["mktA"]),
    [join(MKTS, "mktA", "commands", "deploy.md")]: "---\ndescription: plugin deploy\n---",
    [join(USER_CMD, "deploy.md")]: "---\ndescription: user deploy\n---",
  });
  const out = discoverCommands(CWD, deps);
  assert.equal(out.length, 1);
  assert.equal(byName(out, "deploy")?.description, "user deploy");
});

// --- Task 1.5 (R9, R1) — curated BUILTIN_COMMANDS tier (lowest precedence) + merge/rank ------------

/** deps with NO `builtins` override → exercises the default BUILTIN_COMMANDS tier resolution. */
const emptyDiskDefaultBuiltins = (): DiscoverCommandsDeps => ({
  homedir: () => HOME,
  readdirMd: () => [],
  readdirDirs: () => [],
  readFile: () => {
    throw new Error("no files");
  },
});

test("BUILTIN_COMMANDS is a non-empty curated tier incl. model/clear/compact/help (R9)", () => {
  const names = BUILTIN_COMMANDS.map((c) => c.name);
  for (const n of ["model", "clear", "compact", "help"]) {
    assert.ok(names.includes(n), `missing built-in: ${n}`);
  }
  for (const c of BUILTIN_COMMANDS) {
    assert.ok(isSafeCommandName(c.name), `unsafe built-in name: ${c.name}`);
    assert.equal(typeof c.description, "string");
    assert.ok(c.description.length > 0, `built-in ${c.name} has empty description`);
  }
});

test("empty disk → exactly the built-ins via the default tier, sorted by name (R9)", () => {
  const out = discoverCommands(CWD, emptyDiskDefaultBuiltins());
  assert.deepEqual(
    out.map((c) => c.name),
    BUILTIN_COMMANDS.map((c) => c.name).sort(),
  );
});

test("a custom command overrides a same-named built-in (precedence; R9/R1)", () => {
  const deps = fakeDeps(
    { [join(CWD_CMD, "model.md")]: "---\ndescription: my custom model cmd\n---" },
    { builtins: BUILTIN_COMMANDS },
  );
  const out = discoverCommands(CWD, deps);
  const models = out.filter((c) => c.name === "model");
  assert.equal(models.length, 1);
  assert.equal(models[0].description, "my custom model cmd"); // disk wins over the built-in
});
