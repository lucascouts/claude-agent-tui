// Story 042 / Task 1.1 (R1.1) — the USAGE_UPDATE entrypoint flag parse. Defaults ON: the optional
// UNSTABLE `usage_update` notification (src/usage.ts) is emitted by default, and only the explicit
// opt-out values "0"/"false" disable it (unset / empty / any other value → ON). This FLIPS the
// story-038 default-OFF posture now that story 039 confirmed the user's Zed ACCEPTS+RENDERS
// usage_update by code (the ZED-CLIENT-STUDY verdict); the per-session R8 reject latch still guards a
// client that rejects it. Kept a self-contained, PURE module (cf. usage.ts) so the truth table is
// unit-checkable without booting the entrypoint; index.ts calls it and threads the result through
// runAcp → AgentDeps → the agent. It does NOT go through lib.ts (the frozen upstream export surface).

/**
 * Story 042 (R1.1) — the USAGE_UPDATE entrypoint flag parse. Defaults ON: only the explicit
 * opt-out values "0"/"false" disable it (unset/empty/any other value → ON). Pure + testable;
 * index.ts calls this so the truth table is unit-checkable without running the entrypoint.
 */
export function usageUpdateEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.USAGE_UPDATE !== "0" && env.USAGE_UPDATE !== "false";
}
