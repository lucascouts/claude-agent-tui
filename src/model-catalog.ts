// Story 046 / Task 2.1 — the static curated model catalog (R1.1, R2.1).
//
// Replaces the single `[DEGRAU1_DEFAULT_MODEL_INFO]` entry that collapsed the Zed model selector to
// "Default" and kept the effort selector from ever appearing. These are the interactive `claude` TUI's
// accepted model aliases — the same tokens `/model <alias>` (live switch, design §5) and `--model
// <alias>` (spawn) accept. `default` stays the safe fallback (keep whatever the TUI is configured with).
//
// Effort-capable entries declare `supportsEffort` + a non-empty `supportedEffortLevels`, which is
// exactly what unlocks the effort configOption via `buildConfigOptions` (design §7). The level
// vocabulary is the SDK's (`'low'|'medium'|'high'|'xhigh'|'max'`), which aligns with the
// `reasoning_effort` field seen in real transcripts (NOT the legacy S/M/L/XL display values).
//
// PURE DATA — no spawn, no agent, no `claude`. `ModelInfo` is the SDK shape from
// `@anthropic-ai/claude-agent-sdk` (the same type `acp-agent.ts` builds its model list from).
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";

/**
 * Effort levels offered for reasoning-capable models — the SDK's `supportedEffortLevels` vocabulary.
 * Story 060: exported so the ultracode guard test can assert membership stays the five real levels
 * (it must NEVER contain {@link ULTRACODE_EFFORT}; the real `--effort` enum is exactly this set).
 */
export const REASONING_EFFORT_LEVELS: NonNullable<ModelInfo["supportedEffortLevels"]> = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/**
 * Story 060 — the "ultracode" pseudo-level sentinel for the effort selector. NOT a real `--effort`
 * value (claude 2.1.195 rejects `--effort ultracode`; the enum stays {@link REASONING_EFFORT_LEVELS}).
 * Selecting it maps to `--effort xhigh` PLUS activating the ultracode keyword-trigger for the session
 * (story 060 Task 3). Kept OUT of REASONING_EFFORT_LEVELS so no real-effort code path ever emits it.
 */
export const ULTRACODE_EFFORT = "ultracode";

/** The real effort level the ultracode pseudo-level maps to (its documented effort component). */
export const ULTRACODE_EFFORT_LEVEL = "xhigh";

/** Selector label — makes clear it is xhigh + orchestration, NOT a duplicate of the plain `xhigh` entry. */
export const ULTRACODE_EFFORT_LABEL = "ultracode (xhigh + orchestration)";

/**
 * The static curated catalog advertised to the Zed Agent Panel's `model` selector. Each `value` is a
 * `claude` TUI alias accepted by `/model <alias>` (live) and `--model <alias>` (spawn). `default` is
 * first and is the safe fallback.
 *
 * ORDER + membership mirror the ORIGINAL's `/model` picker, LIVE-VERIFIED against 2.1.195 (PTY probe):
 * `Default (recommended)`, `Opus`, `Sonnet`, `Sonnet (1M context)`, `Haiku`. The original gets this
 * from the SDK `supportedModels()` the fork cut, so we curate it statically. The 1M alias is literally
 * `sonnet[1m]` (`/model sonnet[1m]` accepted; `sonnet-1m` → "not found"). `opusplan` is a fork-only
 * EXTRA (a real `claude` plan-mode preset the original does not list) kept as the trailing entry.
 *
 * Effort-capable models (`default`/`opus`/`sonnet`/`sonnet[1m]`) carry `supportsEffort` +
 * `supportedEffortLevels`; `haiku`/`opusplan` advertise none. `supportsAutoMode: true` on the same four
 * surfaces the `auto` permission mode (a model classifier) — the original drops `auto` on `haiku`
 * (the SDK signal `reconcileModeFromTranscript` clamps), so haiku/opusplan omit it.
 */
export const MODEL_CATALOG: ModelInfo[] = [
  {
    value: "default",
    displayName: "Default (recommended)",
    description:
      "Use the model the claude TUI is configured with (safe fallback); supports reasoning effort.",
    supportsEffort: true,
    supportedEffortLevels: REASONING_EFFORT_LEVELS,
    supportsAutoMode: true,
  },
  {
    value: "opus",
    displayName: "Opus",
    description: "Claude Opus — highest capability; supports reasoning effort.",
    supportsEffort: true,
    supportedEffortLevels: REASONING_EFFORT_LEVELS,
    supportsAutoMode: true,
  },
  {
    value: "sonnet",
    displayName: "Sonnet",
    description: "Claude Sonnet — balanced speed and capability; supports reasoning effort.",
    supportsEffort: true,
    supportedEffortLevels: REASONING_EFFORT_LEVELS,
    supportsAutoMode: true,
  },
  {
    value: "sonnet[1m]",
    displayName: "Sonnet (1M context)",
    description:
      "Claude Sonnet with a 1M-token context window; draws from usage credits; supports reasoning effort.",
    supportsEffort: true,
    supportedEffortLevels: REASONING_EFFORT_LEVELS,
    supportsAutoMode: true,
  },
  {
    value: "haiku",
    displayName: "Haiku",
    description: "Claude Haiku — fastest and most economical; no reasoning effort levels.",
  },
  {
    value: "opusplan",
    displayName: "Opus Plan",
    description: "Opus while planning, Sonnet for execution (plan-mode workflow; fork extra).",
  },
];

/** The safe fallback entry, kept as a named export so callers can seed/anchor on it without a lookup. */
export const DEFAULT_MODEL_INFO: ModelInfo = MODEL_CATALOG[0];
