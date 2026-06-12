// === Story 041 / §sidechain LIVE: guarded subagent-row sourcing (task 1.1) ====================
//
// Renders nested subagents (the `Task`/`Agent` tool spawns a sidechain conversation) at the LIVE
// read path. The SDK exposes two pure, billing-free readers for that sidechain:
//   - `listSubagents(sessionId, { dir })`        → the agentIds spawned in this session
//   - `getSubagentMessages(sessionId, id, { dir })` → that agent's reduced-shape SessionMessage[]
//
// R5.2 CHEAP PATH: `listSubagents` touches disk (it scans the session's subagent transcripts). When
// the main chain carries NO `Task`/`Agent` `tool_use` block there can be no sidechain, so we MUST
// skip `listSubagents` entirely and return `[]` — never pay the probe for the common no-subagent
// turn. This guard is the contract pinned by the unit test (a spy asserts 0 invocations).
//
// Both readers are LAZY-imported defaults (dynamic import at call time, mirroring linearize.ts
// `defaultGetMessages`) so this module — and the deterministic unit tests, which always inject
// stubs — never force-load the SDK at module-eval time. The two seams are fully injectable.

import type { SessionMessage } from "./engine-watcher.js";

/** The `tool_use` block `name`s whose presence in the main chain proves a sidechain may exist. */
const SUBAGENT_TOOL_NAMES = new Set(["Task", "Agent"]);

/**
 * Injectable seam matching the SDK `listSubagents` signature: returns the agentIds spawned in this
 * session. Async. Defaults to {@link defaultListSubagents}.
 */
export type ListSubagents = (sessionId: string, opts?: { dir?: string }) => Promise<string[]>;

/**
 * Injectable seam matching the SDK `getSubagentMessages` signature: returns one agent's sidechain
 * messages in the reduced {@link SessionMessage} shape. Async. Defaults to
 * {@link defaultGetSubagentMessages}.
 */
export type GetSubagentMessages = (
  sessionId: string,
  agentId: string,
  opts?: { dir?: string },
) => Promise<SessionMessage[]>;

/**
 * Default {@link ListSubagents}: the SDK's pure `listSubagents`. Imported lazily (dynamic import) so
 * the module never force-loads the SDK at eval time. Mirrors linearize.ts `defaultGetMessages`.
 */
export const defaultListSubagents: ListSubagents = async (sessionId, opts) => {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  return sdk.listSubagents(sessionId, opts) as Promise<string[]>;
};

/**
 * Default {@link GetSubagentMessages}: the SDK's pure `getSubagentMessages`. Imported lazily (dynamic
 * import) so the module never force-loads the SDK at eval time. Mirrors linearize.ts
 * `defaultGetMessages`.
 */
export const defaultGetSubagentMessages: GetSubagentMessages = async (sessionId, agentId, opts) => {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  return sdk.getSubagentMessages(sessionId, agentId, opts) as Promise<SessionMessage[]>;
};

/** Narrowing helper: a non-null plain object (so we can read string-keyed props safely). */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * True when ANY message in `mainChain` carries a `Task`/`Agent` `tool_use` block — the only signal
 * that a sidechain may exist (and thus the only justification for paying the `listSubagents` probe).
 * Scans each message's `message.content` array for a block with `type === "tool_use"` whose `name`
 * is `"Task"` or `"Agent"`. Tolerant of the reduced shape: missing/odd `content` is simply skipped.
 * Story 044 exports it for the watcher/pump arm decision (reuse over re-implementation).
 */
export function hasSubagentSpawn(mainChain: SessionMessage[]): boolean {
  for (const msg of mainChain) {
    if (!isObject(msg)) continue;
    const inner = msg.message;
    if (!isObject(inner)) continue;
    const content = inner.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (
        isObject(block) &&
        block.type === "tool_use" &&
        typeof block.name === "string" &&
        SUBAGENT_TOOL_NAMES.has(block.name)
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * True iff at least one `Task`/`Agent` `tool_use` id in `mainChain` has NO matching `tool_result`
 * block (`tool_use_id === id`) anywhere in the same chain; false when every spawn id is closed or
 * no spawn exists. Story 044 / R2.2 — the pump's teardown gate: the sub-agent watcher stays armed
 * only while a spawn is open. Single tolerant pass in the {@link hasSubagentSpawn} shape-reading
 * style (skip non-object rows/messages/non-array content); `tool_result` blocks are read off ANY
 * row type, mirroring the end-of-turn detector's `closedToolUseIds`.
 */
export function spawnIdsOpen(mainChain: SessionMessage[]): boolean {
  const spawnIds = new Set<string>();
  const closedIds = new Set<string>();
  for (const msg of mainChain) {
    if (!isObject(msg)) continue;
    const inner = msg.message;
    if (!isObject(inner)) continue;
    const content = inner.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!isObject(block)) continue;
      if (
        block.type === "tool_use" &&
        typeof block.id === "string" &&
        typeof block.name === "string" &&
        SUBAGENT_TOOL_NAMES.has(block.name)
      ) {
        spawnIds.add(block.id);
      } else if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
        closedIds.add(block.tool_use_id);
      }
    }
  }
  for (const id of spawnIds) {
    if (!closedIds.has(id)) return true;
  }
  return false;
}

/**
 * Source the merged subagent (sidechain) rows for a session, GUARDED by a main-chain `Task`/`Agent`
 * `tool_use` probe (R1.2, R5.2).
 *
 * - If the main chain carries no `Task`/`Agent` `tool_use`, return `[]` WITHOUT calling
 *   `listSubagents` — the R5.2 cheap path (no disk probe on the common no-subagent turn).
 * - Otherwise call `listSubagents(sessionId, { dir })` for the agentIds, then
 *   `getSubagentMessages(sessionId, agentId, { dir })` for each, and return the concatenation of all
 *   rows in agentId order.
 *
 * Both readers are injected via `opts` (the lazy defaults are {@link defaultListSubagents} /
 * {@link defaultGetSubagentMessages}); the deterministic unit tests pass stubs/spies.
 */
export async function sourceSubagentRows(
  sessionId: string,
  mainChain: SessionMessage[],
  opts: { dir?: string; listSubagents: ListSubagents; getSubagentMessages: GetSubagentMessages },
): Promise<SessionMessage[]> {
  // R5.2 cheap path: no main-chain Task/Agent → no sidechain possible → skip the disk probe.
  if (!hasSubagentSpawn(mainChain)) return [];

  const { dir, listSubagents, getSubagentMessages } = opts;
  const agentIds = await listSubagents(sessionId, { dir });

  const rows: SessionMessage[] = [];
  for (const agentId of agentIds) {
    const agentRows = await getSubagentMessages(sessionId, agentId, { dir });
    rows.push(...agentRows);
  }
  return rows;
}
