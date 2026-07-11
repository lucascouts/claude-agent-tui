// Story 033 / Task 3.2 — the `--permission-mode acceptEdits`/`bypassPermissions` deny-only alternative,
// with billing UNCHANGED (R4.1, R4.2).
//
// THE ALTERNATIVE (IMPLEMENTACAO-FORK-ACP.md §9): spawn the TUI with `--permission-mode acceptEdits`
// (or `bypassPermissions`) so the TUI AUTO-APPROVES, paired with the PreToolUse hook acting as a
// DENY-ONLY gate: dangerous tools are denied; the rest auto-approve in the TUI with NO second prompt.
// This removes the #52822 double-prompt surface entirely on the allow path while keeping a deny safety
// net — a structurally simpler posture than the keystroke-injection mitigation (allow-inject.ts).
//
// BILLING IS SACRED (§10 / story 022): switching the permission MODE does NOT change billing.
//   - the spawn argv stays interactive-only (no `-p`/`stream-json`), so the run still labels
//     `entrypoint=='cli'` ORGANICALLY (the E1 keystone);
//   - `CLAUDE_CODE_ENTRYPOINT` is NEVER spoofed (forcing it toward 'cli' would be evasion — the
//     OpenClaw case);
//   - the story-022 guard-rail is RE-ASSERTED on the first observed message: a `sdk-*`/`print` label
//     ABORTS the session with the observed entrypoint named (we never proceed on a credit-class label).
//
// This module owns the flag/matcher selection + the guard-rail re-assertion; the actual spawn wiring
// in `startEngine` consumes {@link permissionModeFlag} and the deny-only matcher.

import { guardEvent, type GuardHooks, type WatchedMessage } from "../billing/entrypoint-guard.js";

/** The two auto-approve permission modes the alternative supports (§9). */
export type AltPermissionMode = "acceptEdits" | "bypassPermissions";

/**
 * Build the `--permission-mode <mode>` spawn flag fragment for the alternative (R4.1). Returns the two
 * argv tokens; the spawn path appends them to the interactive `claude` argv. NOTE: this flag changes
 * only how the TUI PROMPTS — it does NOT add `-p`/`stream-json` and therefore does NOT change billing.
 *
 * @param mode `acceptEdits` (the safe default) or `bypassPermissions`.
 * @returns the argv tokens `['--permission-mode', mode]`.
 * @throws {Error} on an unrecognized mode (never silently fall through to a non-gating flag).
 */
export function permissionModeFlag(mode: AltPermissionMode): [string, string] {
  if (mode !== "acceptEdits" && mode !== "bypassPermissions") {
    throw new Error(
      `permissionModeFlag: unsupported alternative permission mode ${JSON.stringify(mode)} — ` +
        `expected 'acceptEdits' or 'bypassPermissions'.`,
    );
  }
  return ["--permission-mode", mode];
}

/**
 * The DENY-ONLY policy for the alternative: the set of dangerous tools (or matchers) the hook denies
 * while everything else auto-approves in the TUI. Kept as a caller-supplied list so the dangerous set
 * is an explicit, reviewable decision (not a hidden default). The matcher uses the same exact/`"*"`
 * convention as the §9 settings matcher.
 */
export interface DenyOnlyPolicy {
  /** Tool names (or `"*"`) the hook DENIES; everything not listed auto-approves. */
  denyMatchers: string[];
}

/**
 * Decide whether the deny-only hook should DENY this tool (R4.1). Returns true iff the tool matches a
 * deny matcher (exact name or `"*"`); otherwise the tool is allowed to auto-approve in the TUI.
 *
 * @param policy the deny-only policy (the dangerous-tool matchers).
 * @param toolName the tool from the hook payload.
 * @returns true → the hook denies this tool; false → auto-approve.
 */
export function denyOnlyShouldDeny(policy: DenyOnlyPolicy, toolName: string): boolean {
  return policy.denyMatchers.some((m) => m === "*" || m === toolName);
}

/**
 * Re-assert the story-022 billing guard-rail (§10) for one observed message under the alternative mode
 * (R4.2). This is the SAME guard-rail the read-only pump runs — re-asserted here so enabling
 * auto-approve does NOT weaken billing. Delegates to {@link guardEvent} (it never re-derives the class
 * and never mutates/spoofs `entrypoint`): on a `sdk-*`/`print` (or unknown) label it alerts + stops the
 * session via the injected hooks; on `cli` it is a silent no-op.
 *
 * @param event one watched message event (the story-015 watcher shape).
 * @param hooks the alert/stop sink (wired to the engine-lifecycle stop in production).
 * @returns the guard decision (`allow`/`abort`/`skip`) so the caller can branch.
 */
export function reassertBillingGuard(event: WatchedMessage, hooks: GuardHooks) {
  return guardEvent(event, hooks);
}

/** Result of {@link assertEntrypointCli}: the session may proceed, or it must abort (credit-class). */
export type EntrypointAssertion =
  { ok: true; entrypoint: string } | { ok: false; entrypoint: string; reason: string };

/**
 * Convenience post-spawn assertion (R4.2): given the FIRST observed billing message's entrypoint
 * self-label, decide whether the alternative-mode session may proceed. ABORTS (`ok:false`) on anything
 * that is not the subscription `cli` label, naming the observed entrypoint in the reason — never
 * proceeds on a `sdk-*`/`print` label and never spoofs the value toward `cli`.
 *
 * This is a thin, pure wrapper over {@link guardEvent} for the spawn path that wants a boolean rather
 * than the hook side-effects; the side-effecting {@link reassertBillingGuard} is used by the live pump.
 *
 * @param event the first observed `assistant`/`user` event under the alternative mode.
 * @returns `{ ok:true, entrypoint }` for `cli`; `{ ok:false, entrypoint, reason }` otherwise.
 */
export function assertEntrypointCli(event: WatchedMessage): EntrypointAssertion {
  const captured: { entrypoint: string; entrypointClass: string }[] = [];
  const hooks: GuardHooks = {
    alert() {
      /* captured via stopSession below */
    },
    stopSession(info) {
      captured.push({ entrypoint: info.entrypoint, entrypointClass: info.entrypointClass });
    },
  };
  const decision = guardEvent(event, hooks);
  const aborted = captured[0] ?? null;
  if (decision.action === "abort" || aborted !== null) {
    const ep = aborted?.entrypoint ?? (decision.action === "abort" ? decision.entrypoint : "");
    const cls =
      aborted?.entrypointClass ??
      (decision.action === "abort" ? decision.entrypointClass : "unknown");
    return {
      ok: false,
      entrypoint: ep,
      reason:
        `[billing §10] alternative permission-mode session observed a ${cls}-class entrypoint ` +
        `"${ep}" — aborting (the run would bill on API credit, not the subscription). The entrypoint ` +
        `is NOT being rewritten toward 'cli'.`,
    };
  }
  // 'allow' (subscription cli) — proceed. 'skip' (lightweight) is treated as not-yet-decided → proceed.
  const entrypoint = decision.action === "allow" ? decision.entrypoint : "";
  return { ok: true, entrypoint };
}
