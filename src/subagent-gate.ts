// Story 054 / Group 1 (tasks 1.1 + 1.2) — pure helpers that turn the pump's already-sourced sidechain
// rows into the gate correlator's feed.
//
// The original `canUseTool` path covered subagent tool calls automatically; the JSONL+PTY rewrite's
// gate (request-permission.ts) only correlates ids it has been fed from the MAIN chain, so a subagent
// tool call has no clean match and fails closed (deny) — the gap proven by the story-053 in-Zed run.
// This module closes that gap by sourcing the inner `tool_use` ids from the sidechain rows the pump
// already reads (subagent-source.ts `sourceSubagentRows`) and registering each into the correlator
// EXACTLY ONCE, so the subagent tool call becomes a clean single match and reaches the ACP prompt with
// the inner tool's input (R3, R7).
//
// MODULE LOCATION (intentional, frozen by the pre-authored test): design.md/tasks.md name this
// `src/permissions/subagent-gate.ts`, but the test imports `../dist/subagent-gate.js` (the ROOT of
// dist/). With tsconfig rootDir:src → outDir:dist this module MUST live at `src/subagent-gate.ts` so it
// compiles to `dist/subagent-gate.js`. The test's import line is immutable; the file location bends to
// it (call-surface only, no behavior change).
//
// Pure: no I/O, no logging, no SDK eval. The only effects are the mutations of the passed-in
// `correlator` / `registered` Set / `parentMap` (the per-session feed state the pump owns).

// `SessionMessage` is the reduced row shape the pump hands us. Its canonical declaration is
// `export type SessionMessage` in engine-watcher.ts (subagent-source.ts imports it from there too, as
// `import type` — non-re-exporting — so we likewise source the type from its declaring module).
import type { SessionMessage } from "./engine-watcher.js";
// Type-only: the helper feeds ids into a ToolUseCorrelator but never constructs one.
import type { ToolUseCorrelator } from "./permissions/request-permission.js";

/**
 * One inner subagent `tool_use` extracted from a sidechain row — the unit the gate correlator is fed
 * and the dialog is built from.
 */
export interface SidechainToolUse {
  /** The inner `tool_use.id` — the correlation key fed into the gate correlator. */
  id: string;
  /** The spawning `Task`/`Agent` `tool_use.id` (the row's `parent_tool_use_id`); `null` = orphan. */
  parentId: string | null;
  /** The inner tool name (e.g. `"Bash"`, `"perplexity"`) — shown in the Zed prompt title. */
  toolName: string;
  /** The inner tool's raw input — forwarded to the dialog (R7). */
  toolInput: unknown;
}

/** Narrowing helper: a non-null, non-array plain object (so we can read string-keyed props safely). */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Collect every inner subagent `tool_use` from the pump's sidechain `rows` (R3, R7).
 *
 * Walks each SIDECHAIN `type === "assistant"` row's `message.content` and emits one
 * {@link SidechainToolUse} per `tool_use` block, in encounter order:
 *   - `id`        ← block.id
 *   - `parentId`  ← row.parent_tool_use_id ?? null (a row with NO parent field → `null`, an orphan)
 *   - `toolName`  ← block.name
 *   - `toolInput` ← block.input (raw, for the dialog — R7)
 *
 * A row counts as a SIDECHAIN row when flagged `isSidechain === true` (raw-shaped fixtures) OR — in the
 * SDK's reduced LIVE shape, which carries NO `isSidechain` field — when it has a non-empty string
 * `parent_tool_use_id` (the only sidechain signal in the reduced shape; mirrors `linearize.ts`
 * `isSidechainMsg`, which the proven story-041 nested render relies on). The spawning `Task`/`Agent`
 * `tool_use` lives on the MAIN chain (no `parent_tool_use_id`, no `isSidechain`), so it is excluded —
 * the gate owns the main chain separately. (In production the pump hands us sidechain-only rows from
 * `sourceSubagentRows`; the guard also keeps the helper correct when fed a full transcript.)
 *
 * Non-`tool_use` content blocks (text, tool_result, …) contribute nothing — a text-only sidechain row
 * yields no entries (the live fixture's sidechain rows are text-only → `[]`). Tolerant of the reduced
 * shape in the {@link import("./subagent-source.js").hasSubagentSpawn} style: non-object rows/messages
 * and non-array `content` are simply skipped.
 */
export function collectSidechainToolUses(rows: SessionMessage[]): SidechainToolUse[] {
  const uses: SidechainToolUse[] = [];
  for (const row of rows) {
    if (!isObject(row)) continue;
    if (row.type !== "assistant") continue;
    // Sidechain detection: `isSidechain === true` (raw-shaped fixtures) OR a non-empty string
    // `parent_tool_use_id` — the ONLY sidechain signal in the SDK's reduced LIVE shape, which omits
    // `isSidechain` (mirrors linearize.ts `isSidechainMsg`). A row with no `parent_tool_use_id` field is
    // an orphan → parentId is `null`, not `undefined`.
    const rawParent = row.parent_tool_use_id;
    const parentId = typeof rawParent === "string" && rawParent.length > 0 ? rawParent : null;
    // The main-chain Task/Agent spawn has neither the flag nor a parent → excluded; the gate owns it.
    if (row.isSidechain !== true && parentId === null) continue;

    const inner = row.message;
    if (!isObject(inner)) continue;
    const content = inner.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (!isObject(block)) continue;
      if (block.type !== "tool_use") continue;
      if (typeof block.id !== "string" || typeof block.name !== "string") continue;
      uses.push({
        id: block.id,
        parentId,
        toolName: block.name,
        toolInput: block.input,
      });
    }
  }
  return uses;
}

/**
 * Feed each collected {@link SidechainToolUse} into the gate `correlator` EXACTLY ONCE (R3).
 *
 * For every `use` whose `id` is NOT already in the `registered` dedup Set:
 *   - `correlator.register(use.id)` — record the id in the JSONL correlation map so a subsequent hook
 *     tool call is a clean single match (its return value is ignored; the Set is the dedup truth);
 *   - `registered.add(use.id)` — mark it fed for this session;
 *   - `parentMap.set(use.id, use)` — map the inner id to its use entry (carries parentId + input).
 *
 * Ids already in `registered` are SKIPPED. The pump re-reads overlapping rows on each pass; a naive
 * re-`register` of the same id would increment its count to 2 → the correlator treats it as a DUPLICATE
 * → fail-closed deny. The dedup Set is what keeps every clean id `isCleanMatch === true` across those
 * overlapping re-reads.
 *
 * Mutates `correlator`, `registered`, and `parentMap` in place; returns nothing.
 */
export function registerSidechainGateToolUses(
  uses: SidechainToolUse[],
  correlator: ToolUseCorrelator,
  registered: Set<string>,
  parentMap: Map<string, SidechainToolUse>,
): void {
  for (const use of uses) {
    if (registered.has(use.id)) continue; // already fed this session — never double-register.
    correlator.register(use.id);
    registered.add(use.id);
    parentMap.set(use.id, use);
  }
}
