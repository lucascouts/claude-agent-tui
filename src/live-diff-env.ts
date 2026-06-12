// Story 043 / Task 2.1 (R2.2) — the LIVE_DIFF entrypoint flag parse. Defaults ON: the live Edit/Write
// diff (the story-021 structuredPatch diff, hydrated onto the reduced-shape JSONL via the diff-enriched
// reader — see diff-enriched-reader.ts) is emitted by default on BOTH the live pump and the session/load
// replay, and only the explicit opt-out values "0"/"false" disable it (unset / empty / any other value
// → ON). This is the v2 default per the FORK.md 4.2 rationale: with the PTY engine the PostToolUse hook
// that once produced diffs is GONE, so the reduced shape renders no diff unless we hydrate `toolUseResult`
// by uuid; defaulting ON restores the story-021 diff for live Edit/Write. OFF → byte-for-byte the pre-043
// reduced reader (R5.1). Kept a self-contained, PURE module (cf. usage-env.ts) so the truth table is
// unit-checkable without booting the entrypoint; index.ts calls it and threads the result through
// runAcp → AgentDeps → the agent. It does NOT go through lib.ts (the frozen upstream export surface).

/**
 * Story 043 (R2.2) — the LIVE_DIFF entrypoint flag parse. Defaults ON: only the explicit
 * opt-out values "0"/"false" disable it (unset/empty/any other value → ON). Pure + testable;
 * index.ts calls this so the truth table is unit-checkable without running the entrypoint.
 */
export function liveDiffEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.LIVE_DIFF !== "0" && env.LIVE_DIFF !== "false";
}
