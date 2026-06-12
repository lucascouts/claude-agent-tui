// Story 033 / Task 2.3 — deny enforcement: map a `deny` decision to a hook response that intercepts
// BEFORE the tool runs (R2.3), and a matcher-scoped deny so per-tool reliability can be characterized.
//
// BINDING Degrau-0 finding (experiments/GATE_FINDINGS.md / IMPLEMENTACAO-FORK-ACP.md §9): a
// `PreToolUse` `permissionDecision:'deny'` body (or process exit code 2) INTERCEPTS the tool before it
// executes — `intercepted=true` across Bash/Edit/MCP. DENY is the load-bearing capability of the
// hybrid gate; ALLOW is best-effort (story 033 allow-inject). This module owns ONLY the deny→response
// translation and the matcher scope; the loopback server is hook-server.ts and the ACP correlation is
// request-permission.ts.
//
// Two response forms, both honored by claude (§9):
//   - DECISION BODY: `{ hookSpecificOutput: { hookEventName:'PreToolUse', permissionDecision:'deny',
//     permissionDecisionReason } }` returned as the http hook's JSON response (preferred — carries a
//     reason the TUI/log can show);
//   - EXIT CODE 2: a process-exit form for a command/exec hook. Captured here as a constant + helper so
//     a caller that drives an exec-style hook can fail closed with the right code.
//
// NUANCE (#37210 Edit / #33106 MCP — review #18453): the broad `"*"` matcher denied the PRECURSOR tool
// claude attempted first (Read before Edit; ToolSearch before the MCP), so per-tool deny reliability
// was NOT isolated in Degrau 0. A MATCHER-SCOPED deny ({@link denyMatchesTool}) targets the intended
// tool so its reliability can be characterized at wire time (story 034) instead of re-masking it.

/** The §9 hook `permissionDecision` values (the allow path is best-effort — see allow-inject.ts). */
export type PermissionDecision = "allow" | "deny";

/** Process exit code that a PreToolUse hook uses to intercept the tool (the exit-2 form, §9). */
export const HOOK_DENY_EXIT_CODE = 2;

/** The §9 PreToolUse hook-specific output block carried in a decision-body response. */
export interface HookSpecificOutput {
  hookEventName: "PreToolUse";
  permissionDecision: PermissionDecision;
  /** Human-readable reason surfaced to the TUI/log; never silently empty on a deny. */
  permissionDecisionReason: string;
}

/** The JSON body a PreToolUse http hook returns to claude (the decision-body form). */
export interface HookResponse {
  hookSpecificOutput: HookSpecificOutput;
}

/** Minimal view of the tool call a deny decision is built for (the hook-payload subset). */
export interface DenyToolCall {
  /** The tool name from the hook payload / JSONL `tool_use.name` (e.g. `Bash`, `Edit`). */
  toolName: string;
  /** The correlation key — hook `tool_use_id` == JSONL `tool_use.id`. */
  toolUseId: string;
}

/**
 * Default deny reason when the caller supplies none. Names the tool so the TUI/log is never a blank
 * "denied" — a silent deny is as confusing as a silent approve.
 */
export function defaultDenyReason(toolCall: DenyToolCall): string {
  return (
    `Denied by the Zed permission gate (tool "${toolCall.toolName}", tool_use ${toolCall.toolUseId}). ` +
    `The tool was intercepted before it ran.`
  );
}

/**
 * Translate a `deny` outcome into the §9 hook decision body that INTERCEPTS the tool before it runs
 * (R2.3). The returned object is the JSON the loopback hook server writes back to claude.
 *
 * @param toolCall the tool the decision is for (names it in the default reason).
 * @param reason optional explicit reason; defaults to {@link defaultDenyReason} (never blank).
 * @returns `{ hookSpecificOutput: { hookEventName:'PreToolUse', permissionDecision:'deny', … } }`.
 */
export function denyDecision(toolCall: DenyToolCall, reason?: string): HookResponse {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason ?? defaultDenyReason(toolCall),
    },
  };
}

/**
 * Translate an `allow` outcome into the §9 hook decision body. NOTE: per #52822 an allow body does
 * NOT reliably suppress the native TUI prompt — the allow path also drives the keystroke-injection
 * mitigation (allow-inject.ts). This helper only produces the body half.
 *
 * @param toolCall the tool the decision is for.
 * @param reason optional explicit reason; defaults to a tool-naming allow reason.
 * @returns `{ hookSpecificOutput: { hookEventName:'PreToolUse', permissionDecision:'allow', … } }`.
 */
export function allowDecision(toolCall: DenyToolCall, reason?: string): HookResponse {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason:
        reason ?? `Allowed by the Zed permission gate (tool "${toolCall.toolName}").`,
    },
  };
}

/**
 * Matcher-scoped deny predicate (R2.3 NUANCE): does this deny matcher target the given tool?
 *
 * `"*"` matches every tool (the broad shape the Degrau-0 probe fired, which masked per-tool reliability
 * by denying a precursor tool). A specific matcher (e.g. `"Edit"`, `"Bash"`) matches ONLY that tool, so
 * #37210 (Edit) / #33106 (MCP) can be isolated and characterized at wire time. Matching is exact and
 * case-sensitive on the tool name — the same convention the §9 settings matcher uses.
 *
 * @param matcher the deny matcher (`"*"` or an exact tool name).
 * @param toolName the tool from the hook payload.
 * @returns true iff the matcher scopes the deny to this tool.
 */
export function denyMatchesTool(matcher: string, toolName: string): boolean {
  return matcher === "*" || matcher === toolName;
}
