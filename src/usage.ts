// Story 025 / Group 3 (R3.1, R3.2) — the optional UNSTABLE `usage_update` mapping.
// `usage_update` exists ONLY in the @agentclientprotocol/sdk 0.22.1 schema and is
// best-effort per §1; it maps the JSONL message-event `usage.{input,output}_tokens` into the
// SDK's { sessionUpdate:"usage_update", size, used } shape. Story 042 FLIPPED the default to ON
// (story 039 confirmed the user's Zed ACCEPTS+RENDERS it by code); only the explicit opt-out
// USAGE_UPDATE=0/false disables it (see usage-env.ts). A rejected emission is still suppressed by
// the pump's per-session reject latch (Task 5.1, R8).
//
// Kept a self-contained module (cf. diff-source.ts) imported by the acp-agent pump; it does
// NOT go through lib.ts (the frozen upstream export surface).

import type { SessionUpdate } from "@agentclientprotocol/sdk";

/** The UNSTABLE `usage_update` variant of the SDK 0.22.1 SessionUpdate union. */
export type UsageUpdateNotification = Extract<SessionUpdate, { sessionUpdate: "usage_update" }>;

/** Defensive view of a JSONL message-event's `usage` block (§7). All fields optional. */
export interface UsageCarrier {
  usage?: { input_tokens?: number | null; output_tokens?: number | null } | null;
}

export interface UsageOptions {
  /**
   * Total context-window size for the notification's `size` field. The pump supplies
   * SessionState.contextWindowSize; absent it, `size` best-effort falls back to `used`
   * (never an invented number — §1 "never fabricate counts").
   */
  contextWindowSize?: number;
}

/**
 * Task 3.2 (R3.2) — map a message-event `usage.{input,output}_tokens` into the UNSTABLE
 * `usage_update` notification. PURE and TOTAL: returns `undefined` (best-effort skip, §1)
 * when neither token count is present; never throws on a partial/absent usage block.
 *
 * Story 042 — the EMITTED SHAPE is pinned to the Zed v1 `UsageUpdate` struct (story 039):
 * EXACTLY `{ sessionUpdate: "usage_update", size, used }`, camelCase, and nothing more.
 *   • R2.2 — `used = input_tokens + output_tokens`; `size = contextWindowSize` (the inferred
 *     window). The `?? used` here is ONLY a library fallback for a caller that omits the window;
 *     the live pump (acp-agent.ts) ALWAYS supplies `contextWindowSize`, so the live path never
 *     takes it (the degenerate `size === used` cannot occur over the wire).
 *   • R3.1 — the optional `cost` field is INTENTIONALLY OMITTED and must NEVER be fabricated:
 *     the JSONL usage block carries only token counts, and `cost` is optional in the Zed v1 struct,
 *     so omitting it is contract-correct (an invented cost would violate §1 "never fabricate").
 *     Story 059 EVIDENCE (2026-06-28): an audit of 5169 local transcripts found 0 carrying
 *     `total_cost_usd` as a JSON key — it lives only in the SDK `result` envelope (`claude -p`), never
 *     in the interactive PTY+tail JSONL mapped here (the 68 substring hits were all conversation text).
 */
export function toUsageUpdate(
  message: UsageCarrier,
  options: UsageOptions = {},
): UsageUpdateNotification | undefined {
  const input = message.usage?.input_tokens;
  const output = message.usage?.output_tokens;
  // best-effort: no usage tokens at all -> emit nothing, never fabricate.
  if ((input === undefined || input === null) && (output === undefined || output === null)) {
    return undefined;
  }
  const used = (input ?? 0) + (output ?? 0);
  const size = options.contextWindowSize ?? used;
  return { sessionUpdate: "usage_update", size, used };
}

export interface UsageFlagOptions extends UsageOptions {
  /** Feature flag (Task 3.1, R3.1) — defaults OFF. When false, NOTHING is constructed. */
  usageUpdate?: boolean;
}

/**
 * Task 3.1 (R3.1) — the feature-flag gate. Returns the `usage_update` notifications to append
 * to a turn's session/update stream: an EMPTY array when the flag is OFF, so the stream is
 * byte-for-byte unaffected by the flag's presence; a single notification when the flag is ON and
 * the message carries usage tokens. A no-op when OFF — `toUsageUpdate` is not even called — not a
 * suppressed-after-build.
 *
 * Story 042 — the flag DEFAULT is decided by the caller: the entrypoint (src/usage-env.ts,
 * `usageUpdateEnabled`) now defaults it ON, while a directly-constructed/test agent stays opt-in
 * (acp-agent.ts `?? false`). Each emitted object is EXACTLY the pinned `{ sessionUpdate, size, used }`
 * shape (see {@link toUsageUpdate}): no `cost`, and `size` is the inferred window on the live path.
 */
export function usageUpdatesFor(
  message: UsageCarrier,
  options: UsageFlagOptions = {},
): UsageUpdateNotification[] {
  if (!options.usageUpdate) return []; // flag OFF (default) -> construct nothing
  const update = toUsageUpdate(message, options);
  return update ? [update] : [];
}
