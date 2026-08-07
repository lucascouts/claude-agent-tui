// === Story 080 / Task 4.2 (R3.1–R3.3) — the `--version` payload: pure collect + pure format ======
//
// Ports upstream #813's `--version` flag. The entrypoint (src/index.ts) short-circuits on the flag,
// prints the three fields this module produces, and exits 0 BEFORE any session is opened, any PTY is
// spawned or any turn is started (R3.2).
//
// WHY ITS OWN MODULE: src/index.ts is a side-effecting entrypoint with a top-level await into the ACP
// bootstrap — importing it from a test WOULD start the agent. Keeping the collect/format halves here
// makes them reachable as plain functions, so the whole payload is unit-checkable without a process
// (the usage-env.ts / live-diff-env.ts precedent). It imports nothing from the ACP, PTY or engine
// side of the tree, and it is pinned that way by test/version-flag.test.ts.
//
// WHY THE FORK POINT IS TWO CONSTANTS, NOT A READ OF .fork-provenance.json: that file is NOT listed in
// package.json `files`, so a published install ships no such file to read — a runtime read would work
// in the repo and fail for every user. The constants are instead held in lockstep with the JSON by an
// assertion in test/version-flag.test.ts, which is what stops them drifting. Same precedent as
// PROVENANCE_CLAUDE_VERSION in src/claude-path.ts.
//
// INVARIANTS:
//   - formatVersionInfo is PURE and returns a BARE 3-line string (no trailing newline — the caller
//     adds it), so the shape is assertable without touching stdout.
//   - collectVersionInfo NEVER throws when `claude` is missing from PATH: the fail-loud resolver error
//     is caught and degraded to `claudeVersion: null`, the remaining fields are still collected, and
//     the entrypoint still exits 0 (R3.3).
//   - The `claude` binary is spawned AT MOST ONCE (see resolveQuietly below), and only to read its
//     version — args-list, no shell, via claude-path.ts's detector.
//
// node:test runner: `node --experimental-strip-types --test test/version-flag.test.ts`
import { readFileSync } from "node:fs";
import { detectClaudeVersion, resolveClaudePath } from "./claude-path.js";

/**
 * Upstream tag currently vendored into src/ — kept in lockstep with `.fork-provenance.json`'s `tag`
 * (re-anchored by sync stories; v0.57.0 came from story 074). A constant rather than a runtime read
 * because the provenance JSON is not published with the package (see the header).
 */
export const FORK_POINT_TAG = "v0.57.0";

/** Full 40-char upstream commit for {@link FORK_POINT_TAG} — lockstep with `.fork-provenance.json`'s `sha`. */
export const FORK_POINT_SHA = "2bf865eb42bbe744c476d38a005444eab8f4b624";

/**
 * Printed in place of the `claude` version when the binary is not resolvable on PATH (R3.3).
 *
 * Deliberately carries NO `x.y.z` triple: a reader (or a test) scanning the output for a version must
 * never mistake the marker for one, and a stale pin must never leak in as a consolation value.
 */
export const CLAUDE_UNRESOLVED = "unresolved (not found on PATH)";

/** Fallback for line 1 when the shipped package.json carries no readable `version` string. */
const UNKNOWN_PACKAGE_VERSION = "unknown";

/** The three facts `--version` reports (R3.1). `claudeVersion` is `null` when unresolved/undetected. */
export interface VersionInfo {
  /** `version` of THIS tree's package.json — read, never pinned (fork 0.5.2 vs mirror 0.8.0, R3.4). */
  packageVersion: string;
  /** Upstream tag the vendored src/ is anchored to ({@link FORK_POINT_TAG}). */
  forkPointTag: string;
  /** Full upstream commit for that tag ({@link FORK_POINT_SHA}). */
  forkPointSha: string;
  /** Live `claude --version`, or `null` when the binary is unresolvable or the probe failed. */
  claudeVersion: string | null;
}

/**
 * PURE renderer: three lines, one fact each — package version, fork point (tag + FULL sha), `claude`
 * version or {@link CLAUDE_UNRESOLVED}.
 *
 * Returns a BARE string with NO trailing newline; the caller appends it. Depends only on its argument.
 */
export function formatVersionInfo(info: VersionInfo): string {
  return [
    `claude-agent-tui ${info.packageVersion}`,
    `fork point: ${info.forkPointTag} (${info.forkPointSha})`,
    `claude: ${info.claudeVersion ?? CLAUDE_UNRESOLVED}`,
  ].join("\n");
}

/** Injectable seams for {@link collectVersionInfo} so tests never spawn a real `claude`. */
export interface VersionInfoDeps {
  /** Override the package.json read (default: {@link readOwnPackageVersion}). */
  readPackageVersion?: () => string;
  /** Override the PATH resolve (default: {@link resolveQuietly}); throwing means "not installed". */
  resolveClaude?: () => string;
  /** Override the version probe (default: `detectClaudeVersion` — claude-path.ts). */
  detectVersion?: (binPath: string) => string | null;
}

/**
 * Read `version` out of the package.json that ships NEXT TO this module's own directory.
 *
 * Resolved against `import.meta.url`, not `process.cwd()`, so it reports the installed package's own
 * version from `dist/` no matter where the binary was invoked from. Falls back to
 * {@link UNKNOWN_PACKAGE_VERSION} if the field is missing or not a string.
 */
function readOwnPackageVersion(): string {
  const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  const parsed = JSON.parse(raw) as { version?: unknown };
  return typeof parsed.version === "string" ? parsed.version : UNKNOWN_PACKAGE_VERSION;
}

/**
 * Resolve `claude` from PATH with the resolver's own observability DISABLED.
 *
 * `resolveClaudePath` normally runs a best-effort `claude --version` probe and logs a resolve/drift
 * line to stderr. Both are unwanted here: `--version` must print the version block and nothing else,
 * and the binary must be spawned exactly once. Passing a null-returning `detectVersion` plus a no-op
 * `log` suppresses the probe and the log, leaving {@link detectResolvedClaudeVersion}'s own detector
 * call the single spawn (measured: one `claude --version`, no other argv). Still THROWS when nothing
 * is on PATH — that fail-loud signal is exactly what R3.3 degrades to `null`.
 */
function resolveQuietly(): string {
  return resolveClaudePath({ detectVersion: () => null, log: () => {} });
}

/**
 * Resolve `claude`, then read its version — degrading BOTH failure modes to `null` (R3.3).
 *
 * The two steps are deliberately sequential rather than combined: when `resolve` throws (the fail-loud
 * "no claude on PATH" error) this returns EARLY, so `detect` is never handed a path that does not
 * exist. When `detect` itself fails it already answers `null` by contract (`detectClaudeVersion` never
 * throws — claude-path.ts). Either way the caller gets `null` and no exception escapes.
 */
function detectResolvedClaudeVersion(
  resolve: () => string,
  detect: (binPath: string) => string | null,
): string | null {
  let binPath: string;
  try {
    binPath = resolve();
  } catch {
    // A missing `claude` is not an error for `--version`: report the rest and exit 0 (R3.3).
    return null;
  }
  return detect(binPath);
}

/**
 * Collect the three `--version` facts (R3.1), degrading instead of failing (R3.3).
 *
 * Every source of truth is an injectable seam with a production default, so the whole payload is
 * unit-checkable without spawning a `claude`. An unresolvable binary costs only the `claudeVersion`
 * field: the package version and the fork point are still collected and nothing escapes to the caller.
 */
export function collectVersionInfo(deps: VersionInfoDeps = {}): VersionInfo {
  const readPackageVersion = deps.readPackageVersion ?? readOwnPackageVersion;
  const resolveClaude = deps.resolveClaude ?? resolveQuietly;
  const detectVersion = deps.detectVersion ?? detectClaudeVersion;

  return {
    packageVersion: readPackageVersion(),
    forkPointTag: FORK_POINT_TAG,
    forkPointSha: FORK_POINT_SHA,
    claudeVersion: detectResolvedClaudeVersion(resolveClaude, detectVersion),
  };
}
