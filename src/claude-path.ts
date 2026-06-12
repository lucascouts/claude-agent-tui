// Resolves the subscription `claude` binary from PATH (story 012, R1/R1.2).
//
// The fork must drive the user's *subscription* claude (resolved from PATH),
// NOT the binary embedded in @anthropic-ai/claude-agent-sdk — the SDK-embedded
// path bills as credit, while the PATH `claude` bills as signature
// (`entrypoint == 'cli'`, the E1 keystone — experiments/DEGRAU0-RESULTS.md).
// This helper is ported 1:1 from the E1-validated experiments/lib/claude-path.ts,
// preserving its resolution order: PATH first, then the documented native-binary
// fallback (IMPLEMENTACAO-FORK-ACP §17), else throw naming BOTH attempted
// locations (R1.3).
//
// Dependency-free on purpose: only node: builtins (FORK.md pins node-pty + the
// SDK as the only runtime deps; this adds none).
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

// Documented native-binary fallback (IMPLEMENTACAO-FORK-ACP §17), for claude
// 2.1.159 (frozen base doc anchor, §3). `~` is expanded via os.homedir.
const FALLBACK_RELATIVE_PATH = join(
  ".vscode",
  "extensions",
  "anthropic.claude-code-2.1.159-linux-x64",
  "resources",
  "native-binary",
  "claude",
);

/** True if `p` exists and is executable by the current process. */
function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve an absolute path to an executable subscription `claude` binary.
 *
 * Resolution order:
 *   1. `claude` found on `process.env.PATH` (which-style scan).
 *   2. The documented native-binary path under the vscode extension.
 *
 * @returns absolute path to an executable `claude`.
 * @throws Error naming both attempted locations if neither is executable.
 */
export function resolveClaudePath(): string {
  // 1. PATH lookup: scan each PATH entry for an executable `claude`.
  const pathEnv = process.env.PATH ?? "";
  const pathEntries = pathEnv.split(delimiter).filter((entry) => entry.length > 0);
  for (const entry of pathEntries) {
    const candidate = join(entry, "claude");
    if (isExecutable(candidate)) {
      return candidate;
    }
  }

  // 2. Documented native-binary fallback (~ expanded via os.homedir).
  const fallback = join(homedir(), FALLBACK_RELATIVE_PATH);
  if (isExecutable(fallback)) {
    return fallback;
  }

  // 3. Neither exists: throw naming BOTH attempted locations.
  throw new Error(
    `Could not resolve an executable "claude" binary. Tried: ` +
      `(1) PATH lookup over ${pathEntries.length} entr${pathEntries.length === 1 ? "y" : "ies"} ` +
      `("${pathEnv}"), and ` +
      `(2) the documented native-binary fallback "${fallback}". ` +
      `Install the Claude Code subscription CLI or ensure "claude" is on PATH.`,
  );
}
