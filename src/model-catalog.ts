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

/** Effort levels offered for reasoning-capable models — the SDK's `supportedEffortLevels` vocabulary. */
const REASONING_EFFORT_LEVELS: NonNullable<ModelInfo["supportedEffortLevels"]> = [
  "low",
  "medium",
  "high",
];

/**
 * The static curated catalog advertised to the Zed Agent Panel's `model` selector. Each `value` is a
 * `claude` TUI alias accepted by `/model <alias>` (live) and `--model <alias>` (spawn). `default` is
 * first and is the safe fallback. Effort-capable models (`sonnet`, `opus`) carry the metadata that
 * surfaces the effort selector; `default`/`haiku`/`opusplan` advertise no effort levels.
 */
export const MODEL_CATALOG: ModelInfo[] = [
  {
    value: "default",
    displayName: "Default",
    description: "Use the model the claude TUI is configured with (safe fallback).",
  },
  {
    value: "sonnet",
    displayName: "Sonnet",
    description: "Claude Sonnet — balanced speed and capability; supports reasoning effort.",
    supportsEffort: true,
    supportedEffortLevels: REASONING_EFFORT_LEVELS,
  },
  {
    value: "opus",
    displayName: "Opus",
    description: "Claude Opus — highest capability; supports reasoning effort.",
    supportsEffort: true,
    supportedEffortLevels: REASONING_EFFORT_LEVELS,
  },
  {
    value: "haiku",
    displayName: "Haiku",
    description: "Claude Haiku — fastest and most economical; no reasoning effort levels.",
  },
  {
    value: "opusplan",
    displayName: "Opus Plan",
    description: "Opus while planning, Sonnet for execution (plan-mode workflow).",
  },
];

/** The safe fallback entry, kept as a named export so callers can seed/anchor on it without a lookup. */
export const DEFAULT_MODEL_INFO: ModelInfo = MODEL_CATALOG[0];
