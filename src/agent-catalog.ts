// Story 056 / Task 3.1 (R3.1, R3.3) — main-thread agent-persona discovery for the Zed Agent Panel's
// `agent` selector.
//
// DISCOVERY IS GLOB-ONLY (a deliberate, LIVE-VERIFIED deviation from the design's "subprocess
// primary" idea): `claude agents [--json]` is the *background-agents* manager — it lists dispatched
// cloud SESSIONS, NOT the main-thread persona definitions that `claude --agent <name>` selects. So we
// never spawn `claude agents` here; the personas live as `*.md` files on disk:
//   • <cwd>/.claude/agents/*.md   (project-scoped — takes PRECEDENCE)
//   • ~/.claude/agents/*.md       (user-scoped)
// matching how `claude` itself resolves a `--agent` name (project overrides user). Both dirs being
// empty (the common case) is the correct empty-state: we return `[]` and a later sub-task's gate hides
// the picker entirely.
//
// SECURITY (R3.3 — the highest-severity item). The `value` we return is the persona name a later
// sub-task interpolates into a `-lc` shell string via `--agent "<name>"`. This module is the
// catalog-BOUNDARY half of a two-layer command-injection defense: every resolved name is checked
// against /^[A-Za-z0-9_-]+$/ and DROPPED if it fails — an unsafe name (spaces, shell metacharacters,
// quotes, path separators, command substitution, …) is NEVER returned. The second layer is
// double-quoting at spawn time (Task 3.3).
//
// PURE + dependency-injectable (cf. claude-path.ts / usage-env.ts): all fs/home access goes through
// the `DiscoverAgentsDeps` seams so the unit tests inject a fake fs and never touch the real disk or
// the real `claude` binary. This module spawns NOTHING — there is no child_process import and no
// shell here; the only `node:` builtins used are os/fs/path. Dependency-free on purpose: a minimal
// inline frontmatter line-parser stands in for a full YAML dependency (FORK.md pins node-pty + the
// SDK as the only runtime deps; this adds none).
//
// node:test runner: `node --experimental-strip-types --test test/agent-catalog.test.ts`
import { homedir as osHomedir } from "node:os";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** A single discoverable main-thread agent persona, as advertised to the Zed `agent` selector. */
export interface AgentCatalogEntry {
  /**
   * The persona name passed to `claude --agent <value>`. GUARANTEED to match
   * {@link SAFE_AGENT_NAME} (`/^[A-Za-z0-9_-]+$/`) — entries whose resolved name fails this are
   * dropped at discovery, so this string is always safe to double-quote into a `-lc` shell command.
   */
  value: string;
  /** Human-facing label: the frontmatter `name`, else a humanized form of the filename. */
  displayName: string;
  /** The frontmatter `description`, when present. */
  description?: string;
}

/**
 * Injectable seams for {@link discoverAgents} — defaults wire the `node:` stdlib. Tests pass fakes so
 * discovery is exercised against an in-memory fs, never the real disk or `~/.claude`.
 */
export interface DiscoverAgentsDeps {
  /** Resolve the user's home directory (default: `os.homedir`). */
  homedir?: () => string;
  /** List the `*.md` filenames in `dir`; MUST return `[]` when `dir` is missing/unreadable. */
  readdirMd?: (dir: string) => string[];
  /** Read a file's UTF-8 contents (default: `fs.readFileSync(p, "utf8")`). */
  readFile?: (path: string) => string;
}

/**
 * The persona-name allowlist (R3.3). The `value` we hand to `--agent "<name>"` MUST match this — it is
 * the catalog-boundary guard of the two-layer command-injection defense. Anchored, single-segment:
 * letters/digits/underscore/hyphen only (no spaces, no shell metacharacters, no path separators).
 */
export const SAFE_AGENT_NAME = /^[A-Za-z0-9_-]+$/;

/** True iff `name` is a non-empty string matching {@link SAFE_AGENT_NAME} (R3.3). */
export function isSafeAgentName(name: unknown): name is string {
  return typeof name === "string" && SAFE_AGENT_NAME.test(name);
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

  // SECURITY (R3.3): drop any entry whose name escapes the allowlist — it is never returned.
  if (!isSafeAgentName(resolvedName)) return null;

  return {
    value: resolvedName,
    displayName: fm.name ?? humanize(stem),
    ...(fm.description ? { description: fm.description } : {}),
  };
}

/**
 * Discover the main-thread agent personas selectable via `claude --agent <name>`.
 *
 * Scans the project dir (`<cwd>/.claude/agents/*.md`) and the user dir (`~/.claude/agents/*.md`),
 * GLOB-ONLY (no `claude` spawn — see file header). Frontmatter `name`/`description` are parsed, with
 * the filename stem as the `name` fallback. Names are sanitized against the R3.3 allowlist and unsafe
 * ones are DROPPED. Results are deduplicated by `value` (PROJECT beats user; first-wins within a dir)
 * and returned sorted by `value`.
 *
 * Never throws: a missing/unreadable dir or file is skipped, and an empty/all-unsafe result yields
 * `[]` (the empty-state that hides the picker in a later sub-task).
 *
 * @param cwd  the SESSION cwd (project dir) whose `.claude/agents` takes precedence.
 * @param deps injectable fs/home seams (default: `node:` stdlib).
 */
export function discoverAgents(cwd: string, deps: DiscoverAgentsDeps = {}): AgentCatalogEntry[] {
  const homedir = deps.homedir ?? osHomedir;
  const readdirMd = deps.readdirMd ?? defaultReaddirMd;
  const readFile = deps.readFile ?? defaultReadFile;

  const projectDir = join(cwd, ".claude", "agents");
  const userDir = join(homedir(), ".claude", "agents");

  // Dedup by `value`: PROJECT scanned first so it wins; within a dir the first filename wins. Map
  // preserves insertion order, but we sort the final array for a stable, scope-independent ordering.
  const byValue = new Map<string, AgentCatalogEntry>();
  for (const dir of [projectDir, userDir]) {
    for (const filename of readdirMd(dir)) {
      const entry = resolveEntry(dir, filename, readFile);
      if (entry && !byValue.has(entry.value)) {
        byValue.set(entry.value, entry);
      }
    }
  }

  return [...byValue.values()].sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
}
