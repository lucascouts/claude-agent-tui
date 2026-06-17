# Story 046 — De-risk Probe Findings (Group 0)

Date: 2026-06-13 · claude 2.1.176 · method: live PTY spike (`probe-a-shift-tab.mjs`) + real transcript corpus.

## Probe A — Shift+Tab mode-change observability (gates R3.3 / Tasks 4.3, 5.1)

**VERDICT: PASS** → closed-loop (design §6b) is viable.

- **Live spike:** writing raw `\x1b[Z` into the live claude TUI cycles the permission mode — the status
  line moved through `accept edits` and `plan mode` (`modeHintsSeenInTUI`) after consecutive Shift+Tab
  writes (node-pty, cols 120×40). The mechanism is confirmed live.
- **Producer field (Reviewer I2):** the transcript event is
  `{"type":"permission-mode","permissionMode":"<mode>", ...}` — field **`permissionMode`**. Confirmed
  across **138 real transcripts** under `~/.claude/projects`, values
  `default / acceptEdits / plan / auto / bypassPermissions`. Task 5.1 reads `event.permissionMode`.
- **Caveat (story 028):** the JSONL transcript is written only on the FIRST interaction, so a prompt-free
  spike emits 0 transcript lines (observed: `permissionModeEvents: 0`). The closed-loop runs on an IDLE
  (post-turn) session that already has a transcript, so this does not affect Task 4.3.
- **Δt:** the TUI repaints sub-second; the closed-loop uses a CONFIGURABLE per-step timeout (default
  2000 ms) + a one-full-cycle safety stop → abort rather than hang. No exact Δt is a gate.
- **Cycle order:** the closed-loop re-reads the live mode each step, so no hardcoded cycle order is needed;
  the safety stop = number of cyclable modes.

## Probe B — live effort-change mechanism (gates R2.2 / Task 3.2)

**VERDICT: re-spawn path** (no live mid-session effort change).

- `claude --effort <level>` exists as a **SPAWN flag** ("Effort level for the current session", confirmed
  in `--help`) — effort is seedable at spawn, like `--permission-mode`.
- **No** slash command, **no** `/model`-coupling, and **no** effort drift event: transcripts carry an
  `effort` field (`S`/`M`/`L`/`XL`) and `reasoning_effort` (`high`/`medium`), but there is no
  `type:"effort"` event to observe a mid-session change.
- **Decision:** effort = choose-at-start (`--effort`) + re-spawn on change (design D2 fallback, §7),
  inheriting the R3.5 passive restart warning and the R3.7 failure path. Task 3.2's Run-mode test mirrors
  `mode-respawn.test.ts` including the R3.7 failure path (Reviewer N1).

## Probe C — post-`/model` hang root cause (live, 2026-06-14, `probe-c-model-then-prompt.mjs`)

**VERDICT: the "next prompt hangs after a live model switch" bug is the claude `Switch model?` confirm dialog — NOT timing, idle-guard, or fork state.**

- **Root cause (proved on screen):** claude **2.1.176** does NOT apply `/model <alias>` inline mid-
  conversation. With GrowthBook `tengu_immediate_model_command=false` (this account's value, seen in
  `~/.claude.json`) it opens a **blocking dialog** `Switch model? → 1. Yes / 2. No` and leaves it OPEN.
  The fork's `injectModelCommand` fires `/model <alias>\r` and returns, so the dialog survives. The
  user's NEXT prompt's `\r` then confirms the dialog (the switch commits, "Set model to …") and the
  prompt **text is discarded** → no turn is born → the story-024 stall watchdog trips at 120 000 ms.
  This reproduces the live session `39a93bfc` exactly (its transcript shows "Set model to Haiku 4.5"
  with the next prompt missing, and the 25 s gap = the dialog sitting open until the next prompt hit it).
- **Refuted theories:** both arms of the two-arm probe (synchronous vs. timed `/model` injection) HUNG
  identically → **timing is irrelevant**; the offline state machine is clean (turnDetector / detectorCursor /
  respawning / pendingModelInjection all correct after an idle `/model`). The earlier "sync→timed" fix
  recommendation is wrong — no static analysis could see the TUI dialog.
- **Fix (validated headless):** after the `/model` write, schedule ONE blind confirm `Enter` after
  `MODEL_CONFIRM_DELAY_MS` (800 ms) to accept the default "Yes, switch" once the dialog has rendered;
  the dialog stays open until confirmed, so a late Enter still lands and an Enter-on-empty (no dialog)
  is a harmless no-op. Clean run: switch opus→haiku (`sawDialog:true, applied:Haiku`) → the next prompt
  **answered** (`started+done`, "2+2=4") → restore→opus confirmed. See `acp-agent.ts`
  `injectModelCommand` + the same-model guard in `applyModelSwitch`.
- **Detection note:** headless claude in a `/tmp` cwd did not flush a JSONL transcript live, so the probe
  reads the TUI (`onData`) — "started" = the working spinner (`esc to interrupt`); "hang" = no spinner
  ever appears (the prompt was eaten). Validated against a working baseline turn each run.
