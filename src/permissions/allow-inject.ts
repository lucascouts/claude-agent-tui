// Story 033 / Task 3.1 — hybrid ALLOW path: on a non-suppressed native prompt (#52822), inject the
// keystroke into the PTY via the story-032 input driver; on timeout, WARN — never silently approve
// (R3.1, R3.2).
//
// WHY (IMPLEMENTACAO-FORK-ACP.md §9 / GATE_FINDINGS.md #52822): allow does NOT reliably suppress the
// native TUI prompt. The Degrau-0 probe saw suppression on claude 2.1.161, but that is VERSION-FRAGILE
// (it may depend on the absence of an `ask` rule + the user's own permissions.allow rules) and is NOT
// guaranteed. So after the gate returns `allow`, if the native prompt is STILL shown we clear it by
// typing the keystroke into the PTY: `'1\r'` = Yes (the first/affirmative option), or `'No'` for a
// refusal. We NEVER assume suppression, and we NEVER spoof an affirmative keystroke for a tool the user
// actually denied.
//
// FAIL CLOSED (design.md): if the injection does not clear the prompt within a timeout, we surface a
// stuck-prompt warning and HOLD — we do NOT report success / silently approve. The caller treats a
// stuck prompt as unresolved, not as an allow.
//
// REUSE: the keystroke goes through the story-032 PTY input primitive (`IPty.write` — the same
// primitive `sendPrompt` and the cancel ladder `interrupt`/`escape` use). We write the raw keystroke
// directly (NOT via `sendPrompt`, which would append its own delayed `\r` for a normal prompt); the
// `'1\r'` already carries its Enter. Injected behind a minimal `PtyWriter` seam so this is unit-testable
// OFFLINE with a fake PTY.

/** The story-032 PTY input primitive this module needs — structurally satisfied by node-pty's IPty. */
export interface PtyWriter {
  write(data: string): void;
}

/** The keystrokes the native TUI permission prompt accepts (§9): Yes = `'1\r'`, refusal types `'No'`. */
export const KEYSTROKE_YES = "1\r";
export const KEYSTROKE_NO = "No";

/** Default time (ms) to wait for the native prompt to clear after a keystroke before warning. */
export const DEFAULT_INJECT_TIMEOUT_MS = 2000;

/** Default poll interval (ms) between prompt-cleared probes. */
export const DEFAULT_INJECT_POLL_MS = 50;

/**
 * Pick the keystroke for a decision (R3.1). `'allow'` → `'1\r'` (Yes / first option); `'deny'` →
 * `'No'` (refusal). Exposed as a pure function so the choice is unit-testable without a PTY.
 *
 * @param decision the gate's enforced decision.
 * @returns the keystroke string to type into the native prompt.
 */
export function keystrokeFor(decision: "allow" | "deny"): string {
  return decision === "allow" ? KEYSTROKE_YES : KEYSTROKE_NO;
}

/** Injectable timer seam (the same `schedule`/clock discipline as end-of-turn + sendPrompt). */
export type Schedule = (fn: () => void, ms: number) => void;

const defaultSchedule: Schedule = (fn, ms) => {
  setTimeout(fn, ms);
};

/** The outcome of an allow-path keystroke injection. */
export type InjectResult =
  | { status: "cleared"; keystroke: string }
  | { status: "suppressed" } // the native prompt was already gone — nothing to inject (the 2.1.161 case)
  | { status: "stuck"; keystroke: string }; // injected but the prompt did not clear → warn + HOLD

/** Options for {@link clearNativePrompt}. */
export interface ClearNativePromptOptions {
  /** The story-032 PTY input primitive (production: the session's IPty). */
  pty: PtyWriter;
  /** The gate's enforced decision (`'allow'` types Yes; `'deny'` types No). */
  decision: "allow" | "deny";
  /**
   * Probe whether the native TUI prompt is CURRENTLY shown. Production wires this to an ANSI-mirror /
   * TUI-state check; injected so a unit test models "prompt shown → cleared after keystroke" or
   * "prompt stuck". Called before injecting (to skip the suppressed case) and after (to confirm it
   * cleared).
   */
  isPromptShown: () => boolean;
  /** Max ms to wait for the prompt to clear before warning (default {@link DEFAULT_INJECT_TIMEOUT_MS}). */
  timeoutMs?: number;
  /** Poll interval (ms) between cleared-probes (default {@link DEFAULT_INJECT_POLL_MS}). */
  pollMs?: number;
  /** Injectable timer (default setTimeout). */
  schedule?: Schedule;
  /** Warning sink for the stuck-prompt case (default no-op; production wires the logger). */
  onWarn?: (message: string) => void;
}

/**
 * Clear the native TUI prompt for an allow/deny decision when it is NOT suppressed (#52822 mitigation).
 *
 * 1. If `isPromptShown()` is already false, the native prompt was suppressed (the 2.1.161 case) — return
 *    `'suppressed'` WITHOUT typing anything (we never type into a prompt that is not there).
 * 2. Otherwise type the keystroke (`'1\r'`=Yes for allow, `'No'` for deny) via the PTY writer, then
 *    poll `isPromptShown()` until it clears or the timeout elapses.
 * 3. On clear → `'cleared'`. On timeout → surface a stuck-prompt warning and return `'stuck'` (the
 *    caller must NOT treat this as an approval — R3.2: no silent approve).
 *
 * @returns an {@link InjectResult}: `'suppressed'` | `'cleared'` | `'stuck'`.
 */
export function clearNativePrompt(opts: ClearNativePromptOptions): Promise<InjectResult> {
  const {
    pty,
    decision,
    isPromptShown,
    timeoutMs = DEFAULT_INJECT_TIMEOUT_MS,
    pollMs = DEFAULT_INJECT_POLL_MS,
    schedule = defaultSchedule,
    onWarn,
  } = opts;

  return new Promise<InjectResult>((resolve) => {
    // (1) Already suppressed → nothing to clear; never type into a non-existent prompt.
    if (!isPromptShown()) {
      resolve({ status: "suppressed" });
      return;
    }

    // (2) Type the keystroke for the decision. We NEVER spoof Yes for a denied tool: deny types No.
    const keystroke = keystrokeFor(decision);
    pty.write(keystroke);

    // (3) Poll for the prompt to clear, bounded by timeoutMs. On timeout → stuck warning, HOLD.
    const deadline = timeoutMs;
    let elapsed = 0;
    const poll = (): void => {
      if (!isPromptShown()) {
        resolve({ status: "cleared", keystroke });
        return;
      }
      elapsed += pollMs;
      if (elapsed >= deadline) {
        onWarn?.(
          `[gate §9] STUCK PROMPT: injected "${JSON.stringify(keystroke)}" but the native TUI ` +
            `permission prompt did not clear within ${timeoutMs}ms (#52822). NOT approving silently — ` +
            `holding for manual resolution.`,
        );
        resolve({ status: "stuck", keystroke });
        return;
      }
      schedule(poll, pollMs);
    };
    schedule(poll, pollMs);
  });
}
