// Story 056 / Task 3.1 + Task 7 (R3.1, R3.3, R3.5, R3.6) — main-thread agent-persona discovery for
// the Zed Agent Panel's `agent` selector.
//
// HYBRID DISCOVERY (refined in Task 7 — was glob-only):
//   PRIMARY (R3.5): ask `claude` itself. We spawn `claude --agent <invalid-sentinel>` through a SAFE
//     args-array child process (NO shell, 8s timeout, EMPTY stdin ⇒ no prompt ⇒ NO tokens/billing).
//     `claude` rejects the sentinel and prints `Available agents: a, b, c` — listing EXACTLY what
//     `claude --agent` accepts: enabled plugin personas (namespaced `plugin:name`) AND the built-ins
//     (Explore, Plan, general-purpose, …). This is the same source the upstream SDK engine uses, so
//     the panel reaches real parity with the original. LIVE-VERIFIED against 2.1.195 (deterministic,
//     cwd-independent). The bare `claude` built-in = the no-persona default and is dropped (it maps to
//     the option's existing "default" sentinel). The spawn mirrors claude-path.ts (execFileSync,
//     args-list, NEVER a shell — C5); the only argument is a CONSTANT sentinel, never user input.
//   FALLBACK (R3.1): when the probe cannot run (binary missing / timeout) OR the error format changes
//     (no `Available agents:` line on a future version), discovery degrades to a glob of the on-disk
//     persona files: `<cwd>/.claude/agents/*.md` (project — PRECEDENCE) + `~/.claude/agents/*.md`
//     (user). Both dirs empty (the common case) yields `[]` and a later sub-task's gate hides the
//     picker entirely.
//
// NOTE: `claude agents` (the subcommand) is the *background-agents* manager — it lists dispatched
// cloud SESSIONS, NOT persona definitions — so we never call it; the persona list comes from the
// `--agent` rejection message above.
//
// SECURITY (R3.3 / R3.6 — the highest-severity item). The `value` we return is interpolated into a
// `-lc` shell string via `--agent "<name>"` (Task 3.3). A plugin persona is NAMESPACED (`plugin:name`),
// so the boundary allowlist is {@link SAFE_AGENT_REF} = `/^[A-Za-z0-9_-]+(?::[A-Za-z0-9_-]+)?$/`: one
// optional `:`-separated segment, each segment letters/digits/`_`/`-` only (the `:` is inert inside the
// double-quoted argument). Every resolved name is checked and DROPPED if it fails — a name with spaces,
// quotes, path separators, command substitution, chaining, … is NEVER returned. The second layer is
// double-quoting at spawn time. {@link SAFE_AGENT_NAME} (single segment) still guards the glob path,
// where on-disk `.md` persona names are always un-namespaced.
//
// PURE + dependency-injectable (cf. claude-path.ts / usage-env.ts): all fs/home/probe access goes
// through the {@link DiscoverAgentsDeps} seams so the unit tests inject fakes and never touch the real
// disk or spawn the real `claude` binary. The only `node:` builtins are os/fs/path/child_process; no
// shell is ever invoked. Dependency-free: a minimal inline frontmatter line-parser stands in for a YAML
// dependency (FORK.md pins node-pty + the SDK as the only runtime deps; this adds none).
//
// node:test runner: `node --experimental-strip-types --test test/agent-catalog.test.ts`
import { homedir as osHomedir } from "node:os";
import { readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

/** A single discoverable main-thread agent persona, as advertised to the Zed `agent` selector. */
export interface AgentCatalogEntry {
  /**
   * The persona reference passed to `claude --agent <value>`. GUARANTEED to match
   * {@link SAFE_AGENT_REF} (a single safe segment, or a namespaced `plugin:name`) — entries whose
   * resolved name fails this are dropped at discovery, so this string is always safe to double-quote
   * into a `-lc` shell command.
   */
  value: string;
  /**
   * Human-facing label. From the probe path it is the raw reference (e.g. `epic:analyst`); from the
   * glob path it is the frontmatter `name`, else a humanized form of the filename.
   */
  displayName: string;
  /** The frontmatter `description`, when present (glob path only — the probe lists names, not docs). */
  description?: string;
}

/**
 * Injectable seams for {@link discoverAgents} — defaults wire the `node:` stdlib. Tests pass fakes so
 * discovery is exercised against an in-memory fs / canned probe output, never the real disk, the real
 * `~/.claude`, or the real `claude` binary.
 */
export interface DiscoverAgentsDeps {
  /**
   * Probe `claude` for its canonical agent list (the PRIMARY source). Returns the raw combined
   * stdout+stderr of `claude --agent <invalid>` (which contains the `Available agents: …` line), or
   * `null` when the probe cannot run (missing binary / timeout) so discovery falls back to the glob.
   * Default: {@link defaultProbeClaudeAgents}. Tests inject a canned string (or `null`) to stay
   * hermetic — a glob-path test MUST pass `() => null` to force the fallback.
   */
  probeClaudeAgents?: () => string | null;
  /** Resolve the user's home directory (default: `os.homedir`). Glob path only. */
  homedir?: () => string;
  /** List the `*.md` filenames in `dir`; MUST return `[]` when `dir` is missing/unreadable. */
  readdirMd?: (dir: string) => string[];
  /** Read a file's UTF-8 contents (default: `fs.readFileSync(p, "utf8")`). */
  readFile?: (path: string) => string;
}

/**
 * The persona-SEGMENT allowlist (R3.3). A single un-namespaced segment: letters/digits/underscore/
 * hyphen only (no spaces, no shell metacharacters, no path separators, no `:`). Guards the glob path
 * (on-disk `.md` names) and is the per-segment building block of {@link SAFE_AGENT_REF}.
 */
export const SAFE_AGENT_NAME = /^[A-Za-z0-9_-]+$/;

/** True iff `name` is a non-empty string matching {@link SAFE_AGENT_NAME} (R3.3). */
export function isSafeAgentName(name: unknown): name is string {
  return typeof name === "string" && SAFE_AGENT_NAME.test(name);
}

/**
 * The persona-REFERENCE allowlist (R3.6). A `--agent "<value>"` reference is either a single safe
 * segment (a built-in like `Explore`, or a user/project `.md` persona) OR a namespaced plugin persona
 * `plugin:name` — exactly ONE optional `:`-separated second segment, each segment a
 * {@link SAFE_AGENT_NAME}. The `:` is inert inside the double-quoted shell argument.
 */
export const SAFE_AGENT_REF = /^[A-Za-z0-9_-]+(?::[A-Za-z0-9_-]+)?$/;

/** True iff `name` is a non-empty string matching {@link SAFE_AGENT_REF} (R3.6). */
export function isSafeAgentRef(name: unknown): name is string {
  return typeof name === "string" && SAFE_AGENT_REF.test(name);
}

/** A sentinel `--agent` value that can never be a real persona — forces the "not found" + list. */
const PROBE_SENTINEL = "__acp_agent_probe_sentinel__";

/** The bare built-in `claude` = the no-persona default (the option's existing "default" sentinel). */
const DEFAULT_PERSONA = "claude";

/**
 * Default {@link DiscoverAgentsDeps.probeClaudeAgents}: spawn `claude --agent <sentinel>` and return
 * its combined output. `execFileSync` (args-array — NO shell, mirroring claude-path.ts / C5) throws on
 * the expected non-zero exit; the `Available agents: …` line is carried on the error's stdout/stderr.
 * Empty stdin + an 8s timeout keep it cheap and tokenless. Any failure (missing binary, timeout,
 * unexpected shape) → `null`, which routes the caller to the glob fallback. The sole argument is the
 * CONSTANT {@link PROBE_SENTINEL} — never user input — so there is no injection surface.
 *
 * OPT-IN (`FORK_AGENT_PROBE=1`): the spawn runs ONLY when production enables it (the fork entrypoint
 * `index.ts` sets the flag). Unit tests import this module directly WITHOUT the flag, so the default
 * probe is a no-op (`null` → glob fallback) — they never spawn the real `claude` and stay hermetic and
 * fast. Tests that DO exercise the probe path inject {@link DiscoverAgentsDeps.probeClaudeAgents}
 * directly, bypassing this gate.
 */
function defaultProbeClaudeAgents(): string | null {
  if (process.env.FORK_AGENT_PROBE !== "1") return null; // opt-in — production (index.ts) enables it
  try {
    // stdio: stdin IGNORED (claude reads EOF → no hang, no prompt → no tokens); stdout+stderr PIPED so
    // the `Available agents:` line (claude writes it to stderr) is captured, NEVER leaked to the fork's
    // own stdout (the ACP wire) or stderr (the log). The list lands on the throw's stderr below.
    const out = execFileSync("claude", ["--agent", PROBE_SENTINEL], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 8000,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    return out.length > 0 ? out : null;
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    const out = `${e?.stdout ?? ""}${e?.stderr ?? ""}`;
    return out.length > 0 ? out : null;
  }
}

/**
 * Extract the agent names from a `claude --agent <invalid>` probe output. Matches the
 * `Available agents: a, b, c` line (tolerant of leading text and a trailing newline — `.` stops at the
 * newline so only that line is captured), splits on commas, trims, and drops empties. Returns `[]` when
 * the line is absent (format changed → the caller falls back to the glob).
 */
export function parseAvailableAgents(probeOutput: string): string[] {
  const m = /Available agents:\s*(.+)/.exec(probeOutput);
  if (!m) return [];
  return m[1]
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Resolve a probe-listed agent name into an entry, or `null` to drop it. The bare `claude` built-in is
 * the no-persona default (mapped to the option's existing "default" sentinel) so it is dropped; any
 * name failing the R3.6 reference allowlist is dropped. `displayName` is the raw reference (e.g.
 * `epic:analyst`), which is what the panel shows.
 */
function entryFromProbeName(name: string): AgentCatalogEntry | null {
  if (name === DEFAULT_PERSONA) return null;
  if (!isSafeAgentRef(name)) return null;
  return { value: name, displayName: name };
}

/**
 * Default `readdirMd`: list `*.md` filenames in `dir`, returning `[]` when the directory is missing or
 * unreadable (the empty-state — never throws). Sorted for a stable first-wins ordering within a dir.
 */
function defaultReaddirMd(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith(".md"))
      .sort();
  } catch {
    return [];
  }
}

/** Default `readFile`: UTF-8 file read via the `node:fs` stdlib. */
function defaultReadFile(path: string): string {
  return readFileSync(path, "utf8");
}

/** The leading `name` (sans `.md`) of a persona file, used as the value/displayName fallback. */
function baseName(filename: string): string {
  return filename.replace(/\.md$/i, "");
}

/**
 * Humanize a filename stem into a display label when the frontmatter has no `name`:
 * `code-reviewer` → `Code Reviewer`, `db_admin` → `Db Admin`. Pure string cosmetics.
 */
function humanize(stem: string): string {
  return stem
    .split(/[-_]+/)
    .filter((w) => w.length > 0)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Frontmatter fields we extract — only `name`/`description` matter for the catalog. */
interface Frontmatter {
  name?: string;
  description?: string;
}

/**
 * Minimal `---`-fenced frontmatter line-parser (NOT a full YAML dep). Reads the leading
 * `---\n … \n---` block and pulls `key: value` lines for the keys we care about; surrounding quotes on
 * a value are stripped. A file without an opening `---` fence yields `{}` (filename-fallback applies).
 * Tiny + pure on purpose — the persona frontmatter we consume is flat `key: value`.
 */
export function parseFrontmatter(content: string): Frontmatter {
  // The opening fence must be the very first line (allowing a leading BOM / blank lines is overkill
  // for this format). Bail to `{}` when there is no fenced block.
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return {};

  const out: Frontmatter = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "---") break; // closing fence — stop
    const m = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) continue; // not a `key: value` line — skip (lists/comments/blanks)
    const key = m[1].toLowerCase();
    if (key !== "name" && key !== "description") continue;
    let value = m[2].trim();
    // Strip a single pair of matching surrounding quotes.
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (value.length > 0) out[key] = value;
  }
  return out;
}

/**
 * Resolve a single persona `*.md` file into an {@link AgentCatalogEntry}, or `null` when it cannot
 * contribute a SAFE entry. The resolved name is the frontmatter `name` if present, else the filename
 * stem; it is then run through the R3.3 allowlist and the file is DROPPED (→ `null`) on any failure —
 * including an unreadable file. `displayName` falls back to a humanized stem.
 */
function resolveEntry(
  dir: string,
  filename: string,
  readFile: (p: string) => string,
): AgentCatalogEntry | null {
  let fm: Frontmatter;
  try {
    fm = parseFrontmatter(readFile(join(dir, filename)));
  } catch {
    return null; // unreadable file — skip it, never throw (R3.1 graceful)
  }

  const stem = baseName(filename);
  const resolvedName = fm.name ?? stem;

  // SECURITY (R3.3): drop any entry whose name escapes the single-segment allowlist — never returned.
  if (!isSafeAgentName(resolvedName)) return null;

  return {
    value: resolvedName,
    displayName: fm.name ?? humanize(stem),
    ...(fm.description ? { description: fm.description } : {}),
  };
}

/** Sort entries by `value` for a stable, scope-independent ordering. */
function sortByValue(entries: AgentCatalogEntry[]): AgentCatalogEntry[] {
  return entries.sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
}

/**
 * FALLBACK glob discovery (R3.1): scan `<cwd>/.claude/agents/*.md` (project — PRECEDENCE) and
 * `~/.claude/agents/*.md` (user), parsing frontmatter `name`/`description` (filename stem as the
 * fallback name), sanitizing against the R3.3 allowlist, deduping by `value` (project beats user;
 * first-wins within a dir), and sorting by `value`. Never throws.
 */
function globDiscoverAgents(cwd: string, deps: DiscoverAgentsDeps): AgentCatalogEntry[] {
  const homedir = deps.homedir ?? osHomedir;
  const readdirMd = deps.readdirMd ?? defaultReaddirMd;
  const readFile = deps.readFile ?? defaultReadFile;

  const projectDir = join(cwd, ".claude", "agents");
  const userDir = join(homedir(), ".claude", "agents");

  const byValue = new Map<string, AgentCatalogEntry>();
  for (const dir of [projectDir, userDir]) {
    for (const filename of readdirMd(dir)) {
      const entry = resolveEntry(dir, filename, readFile);
      if (entry && !byValue.has(entry.value)) {
        byValue.set(entry.value, entry);
      }
    }
  }

  return sortByValue([...byValue.values()]);
}

/**
 * Discover the main-thread agent personas selectable via `claude --agent <name>`.
 *
 * PRIMARY (Task 7, R3.5): the {@link DiscoverAgentsDeps.probeClaudeAgents} probe asks `claude` for its
 * canonical list (enabled plugin personas + built-ins, exactly as `claude --agent` resolves them) and
 * we parse the `Available agents:` line; the bare `claude` default and any name failing the R3.6
 * reference allowlist are dropped, and the rest are deduped + sorted by `value`. When the probe yields
 * at least one persona, that is the result.
 *
 * FALLBACK (R3.1): when the probe returns `null` (binary missing / timeout) OR its output has no
 * `Available agents:` line OR every listed name was dropped, discovery degrades to the on-disk glob
 * ({@link globDiscoverAgents}).
 *
 * Never throws: a failed probe, a missing/unreadable dir or file, or an empty/all-unsafe result yields
 * `[]` (the empty-state that hides the picker in a later sub-task).
 *
 * @param cwd  the SESSION cwd (project dir) whose `.claude/agents` takes precedence in the fallback.
 * @param deps injectable probe/fs/home seams (default: `node:` stdlib + the real `claude` probe).
 */
export function discoverAgents(cwd: string, deps: DiscoverAgentsDeps = {}): AgentCatalogEntry[] {
  // PRIMARY: ask `claude` — the source of truth for what `--agent` accepts.
  const probe = deps.probeClaudeAgents ?? defaultProbeClaudeAgents;
  const probeOut = probe();
  if (probeOut) {
    const byValue = new Map<string, AgentCatalogEntry>();
    for (const name of parseAvailableAgents(probeOut)) {
      const entry = entryFromProbeName(name);
      if (entry && !byValue.has(entry.value)) byValue.set(entry.value, entry);
    }
    if (byValue.size > 0) return sortByValue([...byValue.values()]);
  }

  // FALLBACK: the probe is unavailable or its format changed — glob the on-disk personas.
  return globDiscoverAgents(cwd, deps);
}
