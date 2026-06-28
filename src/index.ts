#!/usr/bin/env node

import { resolveSettings } from "@anthropic-ai/claude-agent-sdk";
import { runAcp } from "./acp-agent.js";
import { resolveClaudePath } from "./claude-path.js";
import { usageUpdateEnabled } from "./usage-env.js";
import { liveDiffEnabled } from "./live-diff-env.js";
import { liveSubagentWatchEnabled } from "./live-subagent-env.js";

if (process.argv.includes("--cli")) {
  const { spawn } = await import("node:child_process");
  const args = process.argv.slice(2).filter((arg) => arg !== "--cli");
  const child = spawn(process.env.CLAUDE_CODE_EXECUTABLE ?? resolveClaudePath(), args, {
    stdio: "inherit",
  });

  const signals =
    process.platform === "win32"
      ? (["SIGINT", "SIGTERM"] as const)
      : (["SIGINT", "SIGTERM", "SIGHUP"] as const);
  for (const sig of signals) {
    process.on(sig, () => {
      if (!child.killed) child.kill(sig);
    });
  }

  child.on("exit", (code, signal) => {
    if (signal && process.platform !== "win32") {
      // Remove our listener so re-raising actually terminates instead of
      // re-entering the no-op handler, which would let us exit with code 0
      // instead of the signal's conventional 128+N.
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
    } else {
      process.exit(code ?? 1);
    }
  });
  child.on("error", (err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  // Apply env vars from the managed-policy tier before any SDK call so the
  // SDK subprocess inherits them. Going through resolveSettings (vs. a raw
  // read of managed-settings.json) also picks up MDM sources on macOS and
  // HKLM/HKCU on Windows.
  const policy = await resolveSettings({ settingSources: [] });
  for (const [key, value] of Object.entries(policy.effective.env ?? {})) {
    process.env[key] = value;
  }

  // stdout is used to send messages to the client
  // we redirect everything else to stderr to make sure it doesn't interfere with ACP
  console.log = console.error;
  console.info = console.error;
  console.warn = console.error;
  console.debug = console.error;

  process.on("unhandledRejection", (reason, promise) => {
    console.error("Unhandled Rejection at:", promise, "reason:", reason);
  });

  // Story 042 (R1.1): the UNSTABLE usage_update notification now defaults ON — unset/empty (or any
  // value other than the opt-out) → ON; opt OUT only via USAGE_UPDATE=0 / USAGE_UPDATE=false. This
  // flips the story-038 default-OFF posture now that story 039's ZED-CLIENT-STUDY confirmed the
  // user's Zed ACCEPTS+RENDERS usage_update by code; the per-session R8 reject latch still guards a
  // client that rejects it. Parsed by the pure `usageUpdateEnabled` (src/usage-env.ts) so the truth
  // table is unit-checkable; threaded through runAcp → AgentDeps → the agent.
  const usageUpdate = usageUpdateEnabled();

  // Story 034 (§9 / R3.3): the HYBRID permission gate is the v1 policy (PERMISSIONS.md §1), so the
  // production bootstrap resolves it ON by default — `FORK_GATE=off` is the documented diagnostic
  // escape hatch (and the R5 v1-no-gate fallback switch). With the gate OFF, createSession starts
  // NO hook server, writes NO scratch settings, and the spawn argv carries no `--settings` — the
  // ungated spawn is byte-for-byte pre-034. Any other value (absent, "1", "on", even "0") stays ON:
  // for a safety gate the conservative direction is gated, so only the exact documented escape
  // hatch disables it. Threaded through runAcp → AgentDeps → the agent (the usageUpdate pattern).
  const gate = process.env.FORK_GATE !== "off";

  // Story 043 (R2.2): the live Edit/Write diff now defaults ON — unset/empty (or any value other
  // than the opt-out) → ON; opt OUT only via LIVE_DIFF=0 / LIVE_DIFF=false. With the PTY engine the
  // PostToolUse hook that once produced diffs is gone, so the reduced-shape JSONL renders no diff
  // until `toolUseResult` is hydrated by uuid (diff-enriched-reader.ts, FORK.md 4.2); defaulting ON
  // restores the story-021 diff on BOTH the live pump and the session/load replay. OFF → byte-for-byte
  // the pre-043 reduced reader. Parsed by the pure `liveDiffEnabled` (src/live-diff-env.ts) so the
  // truth table is unit-checkable; threaded through runAcp → AgentDeps → the agent.
  const liveDiff = liveDiffEnabled();

  // Story 044 (R4.1): the live sub-agent watcher now defaults ON — unset/empty (or any value other
  // than the opt-out) → ON; opt OUT only via FORK_LIVE_SUBAGENT_WATCH=0 / =false. It arms the
  // Option-B 2nd watcher (a POLL of the SDK sidechain readers while a turn is in flight) so a
  // long-running sub-agent — whose rows land in subagents/*.jsonl while the MAIN transcript stays
  // silent — feeds the turn detector's noteActivity() seam and renders incrementally instead of
  // false-stalling the story-024 watchdog (the story-041 R4.2 live gap). OFF → byte-for-byte today's
  // pull-only path: NO 2nd watcher armed (R4.2). Parsed by the pure `liveSubagentWatchEnabled`
  // (src/live-subagent-env.ts) so the truth table is unit-checkable; threaded through
  // runAcp → AgentDeps → the agent.
  const liveSubagentWatch = liveSubagentWatchEnabled();

  // Story 056 / Task 7 (R3.5): enable the live agent-discovery probe in PRODUCTION only. The probe
  // (agent-catalog.ts) spawns `claude --agent <sentinel>` once per createSession to read `claude`'s
  // canonical persona list (enabled plugins + built-ins) for the 4th `agent` selector. Gated opt-in so
  // the unit suite — which imports modules directly without this flag — stays on the hermetic glob
  // fallback and never spawns the real binary. `??=` keeps a user opt-out (`FORK_AGENT_PROBE=0`).
  process.env.FORK_AGENT_PROBE ??= "1";

  const { connection, agent } = runAcp({ usageUpdate, gate, liveDiff, liveSubagentWatch });

  async function shutdown() {
    await agent.dispose().catch((err) => {
      console.error("Error during cleanup:", err);
    });
    process.exit(0);
  }

  // Exit cleanly when the ACP connection closes (e.g. stdin EOF, transport
  // error). Without this, `process.stdin.resume()` keeps the event loop
  // alive indefinitely, causing orphan process accumulation in oneshot mode.
  connection.closed.then(shutdown);

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Keep process alive while connection is open
  process.stdin.resume();
}
