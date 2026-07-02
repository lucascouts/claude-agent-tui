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
 * ORDER + membership: `Default (recommended)`, `Fable 5`, `Opus`, `Sonnet`, `Haiku`. The original gets
 * its list from the SDK `supportedModels()` the fork cut, so we curate it statically. `fable5` (`/model
 * fable5` — the Claude 5 family's top model, released 2026-07-01) sits right after `default`. The
 * redundant `sonnet[1m]` alias was dropped: Sonnet 5 is natively 1M, so plain `sonnet` already IS the 1M
 * model. The fork-only `opusplan` extra was dropped too (three Sonnet-flavored entries + inconsistent
 * Opus thinking made it more confusing than useful).
 *
 * Effort-capable models (`default`/`fable5`/`opus`/`sonnet`) carry `supportsEffort` +
 * `supportedEffortLevels`; `haiku` advertises none. `supportsAutoMode: true` on the same four surfaces
 * the `auto` permission mode (a model classifier) — the original drops `auto` on `haiku` (the SDK signal
 * `reconcileModeFromTranscript` clamps), so haiku omits it.
 */
export const MODEL_CATALOG: ModelInfo[] = [
  {
    value: "default",
    displayName: "Default (recommended)",
    // Story 069 (R3): `default` resolves to the recommended Opus, so it carries the Opus description.
    description: "Best for everyday, complex tasks",
    supportsEffort: true,
    supportedEffortLevels: REASONING_EFFORT_LEVELS,
    supportsAutoMode: true,
  },
  {
    value: "fable5",
    // Bare family name in the title (like Opus/Sonnet/Haiku); the "Fable 5" version lives in the
    // MODEL_VERSION_LABELS prefix that composes the selector description.
    displayName: "Fable",
    // Fable 5 (Claude 5 family, released 2026-07-01) — the most advanced generally available model.
    // Description verbatim from the live `/model` picker of the interactive `claude` CLI.
    description: "Most capable for your hardest and longest-running tasks",
    supportsEffort: true,
    supportedEffortLevels: REASONING_EFFORT_LEVELS,
    supportsAutoMode: true,
  },
  {
    value: "opus",
    displayName: "Opus",
    description: "Best for everyday, complex tasks",
    supportsEffort: true,
    supportedEffortLevels: REASONING_EFFORT_LEVELS,
    supportsAutoMode: true,
  },
  {
    value: "sonnet",
    displayName: "Sonnet",
    description: "Efficient for routine tasks",
    supportsEffort: true,
    supportedEffortLevels: REASONING_EFFORT_LEVELS,
    supportsAutoMode: true,
  },
  {
    value: "haiku",
    displayName: "Haiku",
    description: "Fastest for quick answers",
  },
];

/**
 * Story 068 (R1, R1.1, R2) — the REAL per-alias context window, keyed by the EXACT {@link MODEL_CATALOG}
 * `value`. These windows are NOT uniform: `default`/`fable5`/`opus`/`sonnet` are natively 1M and `haiku`
 * is 200K. This map is the single source of truth that `inferContextWindowFromModel` (acp-agent.ts)
 * consults BEFORE the `\b1m\b` regex fallback — the bug it fixes is `opus` having wrongly reported 200K
 * (the regex only ever matched the literal `1m` token).
 *
 * `sonnet` seeds to 1M because plain `sonnet` now resolves to Sonnet 5, which is natively 1M (the
 * redundant `sonnet[1m]` alias was dropped). `default` is the recommended Opus (the claude TUI's `/model
 * default` resolves to `claude-opus-4-8[1m]`, a 1M model) and `fable5` is Fable 5 (1M). This is only the
 * PRE-FIRST-TURN seed: once a turn arrives, `inferContextWindowFromModelId` (story 069) AUTHORITATIVELY
 * refines the window from the transcript's real `model`. Keys MIRROR `MODEL_CATALOG` `value`s; the drift
 * guard lives in the test (068 anti-drift: every catalog value has an explicit entry).
 */
export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  default: 1_000_000,
  fable5: 1_000_000,
  opus: 1_000_000,
  sonnet: 1_000_000,
  haiku: 200_000,
};

/**
 * Story 069 (R1.1) — the REAL context window per concrete model ID, mirroring the claude CLI's
 * `context:{window}` table. Used to AUTHORITATIVELY refine the window from a turn's actual `model`
 * (the JSONL `model` field), correcting the alias seed. Opus is NOT uniform: 4.6 = 200K, 4.7+ = 1M.
 * Dated snapshots / future versions are covered by the family+version heuristic in
 * `inferContextWindowFromModelId`; this table is the exact-ID source of truth for today's gateway IDs.
 */
export const MODEL_ID_CONTEXT_WINDOWS: Record<string, number> = {
  "claude-opus-4-8": 1_000_000,
  "claude-opus-4-7": 1_000_000,
  "claude-opus-4-6": 200_000,
  "claude-fable-5": 1_000_000,
  "claude-sonnet-5": 1_000_000,
  "claude-sonnet-4-6": 200_000,
  "claude-sonnet-4-5-20250929": 200_000,
  "claude-sonnet-4-20250514": 200_000,
  "claude-haiku-4-5": 200_000,
};

/**
 * Story 072 — the version/context PREFIX the claude `/model` picker now shows before the static tagline
 * (e.g. "Opus 4.8 with 1M context · Best for everyday, complex tasks"). Keyed by catalog `value`.
 *
 * CURATED + DRIFT-PRONE, exactly like MODEL_CATALOG membership: the fork holds only aliases pre-turn and
 * cannot derive the concrete version (the SDK `supportedModels()` was cut), so these MIRROR the LIVE
 * picker and MUST be re-verified on each model launch (source: the user's live `/model` output). The
 * static tagline stays on `ModelInfo.description` (069 R3 untouched); this only prepends "<version> · ".
 * Every current catalog entry carries a label; the no-label branch in {@link modelSelectorDescription}
 * stays as a total-function safeguard for any future label-less entry.
 */
export const MODEL_VERSION_LABELS: Record<string, string> = {
  default: "Opus 4.8 with 1M context",
  fable5: "Fable 5 with 1M context",
  opus: "Opus 4.8 with 1M context",
  sonnet: "Sonnet 5 with 1M context",
  haiku: "Haiku 4.5",
};

/**
 * Story 072 — compose the Zed selector description: "<version label> · <tagline>", or the bare tagline
 * when no label exists. PURE + TOTAL: never throws on a missing label or tagline.
 */
export function modelSelectorDescription(info: ModelInfo): string {
  const label = MODEL_VERSION_LABELS[info.value];
  const tagline = info.description ?? "";
  if (!label) return tagline;
  return tagline ? `${label} · ${tagline}` : label;
}

/**
 * Story 073 (R5.1) — the catalog `value`s that support fast mode (`/fast on|off`). Fast mode "uses
 * Claude Opus with faster output (it does not downgrade to a smaller model)" and is available on Opus
 * 4.8/4.7 only; the CLI turns it off when switching to a non-Opus model. `default` resolves to the
 * recommended Opus, so both `default` and `opus` qualify; `fable5`/`sonnet`/`haiku` do NOT.
 *
 * Kept HERE (not on {@link ModelInfo}) because `ModelInfo` is the SDK shape and cannot carry a
 * fork-only `supportsFastMode` field — the same reason the effort/auto flags that DO exist on the SDK
 * type live inline while this predicate is external.
 */
export const FAST_MODE_MODELS: ReadonlySet<string> = new Set(["default", "opus"]);

/** Story 073 (R5.1) — true when the catalog `value` is an Opus alias that supports fast mode. */
export function isFastModeCapableModel(value: string): boolean {
  return FAST_MODE_MODELS.has(value);
}

/** The safe fallback entry, kept as a named export so callers can seed/anchor on it without a lookup. */
export const DEFAULT_MODEL_INFO: ModelInfo = MODEL_CATALOG[0];
