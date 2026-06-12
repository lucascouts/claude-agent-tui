// === Story 044 / Option B: poll-based sub-agent activity watcher (task 3.2) ======================
//
// While a `Task`/`Agent` spawn is in flight on the main chain, the turn's real progress happens on
// the SIDECHAIN (`subagents/*.jsonl`) — which the story-023 tail does not observe, so a long
// sub-agent looks like a stall and trips the turn watchdog (the story-041 R4.2 live gap). This
// watcher feeds that missing liveness: it POLLS the story-041 SDK readers (`listSubagents` +
// `getSubagentMessages`, via `sourceSubagentRows`) instead of tailing the raw `subagents/*.jsonl`
// files. Design rationale (Option B as planned):
//   - reuses the 041 data path verbatim — same readers, same reduced shape, same R5.2 guard;
//   - dissolves the class-028 late-discovery gap: before the sidechain materializes the readers
//     simply return `[]`, so polling is harmless and needs no fs.watch arming dance (R2.1);
//   - keeps engine-watcher.ts frozen — no second tail, no new fs seam.
//
// Liveness is PROGRESS-GATED (R5.2): `onActivity` fires at most once per poll, and only when the
// poll observed at least one NEW row (a `uuid` not seen before). An empty poll, a no-change poll,
// or a reader error fires NOTHING — a hung sub-agent must still let the stall watchdog trip.

import type { SessionMessage } from "./engine-watcher.js";
import {
  hasSubagentSpawn,
  sourceSubagentRows,
  type ListSubagents,
  type GetSubagentMessages,
} from "./subagent-source.js";

/** Default poll interval (ms) between sub-agent reader probes. */
export const SUBAGENT_POLL_MS = 1000;

export interface SubagentWatcherOptions {
  sessionId: string;
  /** session.cwd — passed to the readers as `{ dir }`. */
  dir?: string;
  /** Latest main chain (for the hasSubagentSpawn guard); refreshed by the pump via update(). */
  mainChain: SessionMessage[];
  listSubagents: ListSubagents;
  getSubagentMessages: GetSubagentMessages;
  /** Fired once per poll that observed >=1 NEW sub-agent row (new uuid). Never on an empty/no-change poll. */
  onActivity: () => void | Promise<void>;
  /** Injected for tests; defaults to a setTimeout/clearTimeout-backed one-shot scheduler. */
  schedule?: (fn: () => void, ms: number) => () => void;
  /** Poll interval (ms); default {@link SUBAGENT_POLL_MS}. */
  pollMs?: number;
}

export interface SubagentWatcher {
  /** Refresh the cached main chain so the spawn guard tracks the current turn. */
  update(mainChain: SessionMessage[]): void;
  /** Stop the poll, drop the seen-uuid set; idempotent. */
  stop(): void;
}

/**
 * Default one-shot scheduler: `setTimeout`/`clearTimeout` with `.unref?.()` so an armed watcher
 * never keeps the process alive on its own (mirrors `defaultSchedule` in end-of-turn.ts).
 */
const defaultSchedule = (fn: () => void, ms: number): (() => void) => {
  const handle = setTimeout(fn, ms);
  (handle as { unref?: () => void }).unref?.();
  return () => clearTimeout(handle);
};

/**
 * Create a sub-agent activity watcher: poll the story-041 readers every `pollMs` while armed, fire
 * `onActivity` only on observed progress (a new-uuid row), stop cleanly.
 *
 * SCHEDULING: `schedule` is ONE-SHOT — the same `DetectorSchedule` semantics as end-of-turn.ts
 * (schedule(fn, ms) fires fn once after ms, returns a cancel) — and the watcher CHAINS one-shots:
 * the first tick is armed at construction (`pollMs` from now); after each async poll body completes
 * the next tick is re-armed, unless stopped. Why one-shot chaining instead of setInterval:
 *   (a) one shared semantics with the rest of the fork's timer seams, so the SAME fake clock
 *       drives detector + watcher in tests;
 *   (b) re-arming AFTER the poll completes prevents overlapping polls when a read outlasts the
 *       interval (setInterval would overlap).
 */
export function createSubagentWatcher(opts: SubagentWatcherOptions): SubagentWatcher {
  const {
    sessionId,
    dir,
    listSubagents,
    getSubagentMessages,
    onActivity,
    schedule = defaultSchedule,
    pollMs = SUBAGENT_POLL_MS,
  } = opts;

  let mainChain = opts.mainChain;
  const seen = new Set<string>();
  let stopped = false;
  /** Cancel for the currently pending one-shot, if any (cleared when it fires). */
  let cancelPending: (() => void) | undefined;

  /** Arm the next one-shot tick — never after stop(). */
  const arm = (): void => {
    if (stopped) return;
    cancelPending = schedule(() => {
      cancelPending = undefined;
      void poll();
    }, pollMs);
  };

  /** One poll body; always re-arms afterwards unless stopped (errors included — next poll retries). */
  const poll = async (): Promise<void> => {
    try {
      // R5.2 cheap path: no main-chain Task/Agent spawn → no sidechain possible → skip the
      // readers entirely (zero sub-agent IO on the common no-subagent turn).
      if (hasSubagentSpawn(mainChain)) {
        const rows = await sourceSubagentRows(sessionId, mainChain, {
          dir,
          listSubagents,
          getSubagentMessages,
        });
        // Progress = rows with a NEW non-empty-string uuid. A uuid-less row is skipped — it never
        // counts as progress and never crashes the poll.
        const fresh: string[] = [];
        for (const row of rows) {
          const uuid = row.uuid;
          if (typeof uuid !== "string" || uuid === "") continue;
          if (!seen.has(uuid)) fresh.push(uuid);
        }
        if (fresh.length > 0 && !stopped) {
          for (const uuid of fresh) seen.add(uuid);
          await onActivity();
        }
      }
    } catch {
      // A reader rejection (transient FS/SDK error) must not kill the chain: swallow and re-arm —
      // the NEXT poll retries. Errors never fire onActivity (no liveness from failure).
    }
    if (!stopped) arm();
  };

  // Arm the first tick at construction: the first probe lands `pollMs` from now.
  arm();

  return {
    update(next: SessionMessage[]): void {
      mainChain = next;
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      cancelPending?.();
      cancelPending = undefined;
      seen.clear();
    },
  };
}
