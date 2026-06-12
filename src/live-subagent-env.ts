// Story 044 / Task 2.1 (R4.1, R4.2) — the FORK_LIVE_SUBAGENT_WATCH entrypoint flag parse. Defaults
// ON: the live sub-agent watcher (the story-044 Option-B 2nd watcher that POLLs the SDK sidechain
// readers while a turn is in flight, feeding the story-024 detector's noteActivity() seam and the
// incremental nested render) is armed by default, and only the explicit opt-out values "0"/"false"
// disable it (unset / empty / any other value → ON). This closes the story-041 R4.2 live gap: a
// long-running sub-agent (e.g. a ~7-minute `Agent` Task) writes only subagents/*.jsonl while the
// MAIN transcript stays silent, so the turn watchdog false-stalls a turn that is actually
// progressing. OFF → byte-for-byte today's pull-only path: NO 2nd watcher armed (R4.2). Kept a
// self-contained, PURE module (cf. usage-env.ts / live-diff-env.ts) so the truth table is
// unit-checkable without booting the entrypoint; index.ts calls it and threads the result through
// runAcp → AgentDeps → the agent. It does NOT go through lib.ts (the frozen upstream export surface).

/**
 * Story 044 (R4.1) — the FORK_LIVE_SUBAGENT_WATCH entrypoint flag parse. Defaults ON: only the
 * explicit opt-out values "0"/"false" disable it (unset/empty/any other value → ON). Pure + testable;
 * index.ts calls this so the truth table is unit-checkable without running the entrypoint.
 */
export function liveSubagentWatchEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.FORK_LIVE_SUBAGENT_WATCH !== "0" && env.FORK_LIVE_SUBAGENT_WATCH !== "false";
}
