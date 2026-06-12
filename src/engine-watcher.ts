// === §6 JSONL tail watcher orchestrator (story 015, Task Group 3) =============================
//
// BINDING DECISION E5 "REUSE-live" (story.md R5, constraint 1): this watcher does NOT hand-parse
// `message.content`. It WRAPS the SDK's pure, billing-free reader `getSessionMessages(sessionId,
// { dir })` and RE-INVOKES it (a) on a debounced write SIGNAL (live streaming) and (b) on a forced
// final re-read when the story-024 end-of-turn signal fires. There is exactly ONE parser — the
// SDK's — and we surface its parentUuid-linked chronological order UNCHANGED (R5.3; linearization
// of sidechains/forks is deferred to story 017).
//
// Division of labour:
//   - `tailTranscript` (Task 2, jsonl.ts) is the TRIGGER: its newline-atomic line reader + residue
//     buffer decide *when* a new COMPLETE line has landed. We use each forwarded record only as a
//     write SIGNAL — never as the event source. A torn ~630 KB image append is therefore withheld
//     by the residue buffer until its `\n` arrives, so no signal fires for a half-written line.
//   - `getSessionMessages` is the SOURCE: every re-read returns the full monotonic ordered superset.
//   - the per-`uuid` `Set` is the EMIT-ONCE guard: across re-reads of the growing superset, each
//     message is forwarded to `onEvent` at most once, preserving the SDK array order (R4.1, R4.2).
//
// The story-024 end-of-turn detector (terminal `stop_reason` + 200 ms quiescence) is NOT
// implemented here — this watcher only CONSUMES its signal via `notifyEndOfTurn()` as the
// forced-final-re-read cadence.

import type { SessionWatcher } from "./engine-lifecycle.js";
import { tailTranscript } from "./jsonl.js";
import type { TranscriptTail, TailOptions } from "./jsonl.js";

/**
 * A conversation message as returned by `getSessionMessages`. We rely ONLY on `.uuid` here (the
 * dedupe key); everything else is forwarded opaque. Typed as an optional `uuid` superset so the
 * injectable seam structurally accepts both the real SDK `SessionMessage` (whose `uuid` is a
 * required `string`) and lightweight test fixtures.
 */
export type SessionMessage = { uuid?: string; [k: string]: unknown };

/**
 * Injectable seam matching the SDK `getSessionMessages` signature (the pure, billing-free reader).
 * May be sync or async — the orchestrator awaits the result either way and then performs the
 * check-add-emit synchronously (see {@link createJsonlWatcher}). Defaults to the SDK function.
 */
export type GetMessages = (
  sessionId: string,
  opts?: { dir?: string },
) => Promise<SessionMessage[]> | SessionMessage[];

/** Default debounce window (ms) coalescing a burst of live write signals into one re-read. */
export const DEFAULT_WATCHER_DEBOUNCE_MS = 50;

/** Construction options for {@link createJsonlWatcher}. */
export interface JsonlWatcherOptions {
  /** The session id; equals the transcript filename basename. Passed to `getSessionMessages`. */
  sessionId: string;
  /** Resolved transcript path (from Task 1 `locateTranscript`) — the file the tail watches. */
  transcriptPath: string;
  /** Runtime cwd (from Task 1 `readCwdFromInside`) → passed as `{ dir }` to `getSessionMessages`. */
  dir?: string;
  /** Sink: invoked once per NEW (not-yet-seen-by-uuid) message, in `getSessionMessages` order. */
  onEvent: (message: SessionMessage) => void;
  /** Injected for tests; defaults to the SDK `getSessionMessages`. */
  getMessages?: GetMessages;
  /** Injected for tests; defaults to {@link tailTranscript} from ./jsonl.js. */
  tail?: (path: string, opts: TailOptions) => TranscriptTail;
  /** Debounce window (ms) for the live write signal; defaults to {@link DEFAULT_WATCHER_DEBOUNCE_MS}. */
  debounceMs?: number;
  /**
   * Injected for deterministic debounce in tests; returns a CANCEL fn. Defaults to a
   * setTimeout/clearTimeout pair. Tests pass a controllable scheduler (capture fn + manual flush)
   * so the debounce never depends on real timer timing.
   */
  schedule?: (fn: () => void, ms: number) => () => void;
}

/**
 * The concrete per-session watcher: it satisfies the story-014 {@link SessionWatcher} seam (so a
 * {@link SessionEngine} can tear it down on cleanup) AND exposes the story-024 end-of-turn hook.
 */
export interface JsonlWatcher extends SessionWatcher {
  /**
   * Tear down the tail, cancel any pending debounce, and set a stopped flag so an in-flight async
   * re-read does not emit after stop. Idempotent (the {@link SessionWatcher} contract).
   */
  stop(): void;
  /**
   * Story-024 end-of-turn signal: cancel any pending debounce and force ONE final re-read
   * IMMEDIATELY so the just-completed turn is fully ingested. This watcher only CONSUMES the
   * signal — it does NOT detect end-of-turn (that is story 024).
   */
  notifyEndOfTurn(): void;
}

/** Default debounce scheduler: fire `fn` after `ms` via setTimeout; the returned fn clears it. */
function defaultSchedule(fn: () => void, ms: number): () => void {
  const handle = setTimeout(fn, ms);
  return () => clearTimeout(handle);
}

/**
 * Create the read-only JSONL tail watcher for one session (story 015, R4 + R5).
 *
 * Wiring: `tailTranscript(transcriptPath, { onRecord: () => scheduleReread() })`. Each complete
 * line the tail forwards is treated PURELY as a debounced write signal — never as the event source.
 * After `debounceMs` of quiet, exactly one re-read runs: it calls `getMessages(sessionId, { dir })`,
 * then SYNCHRONOUSLY (no `await` between messages) walks the returned array and, for each message
 * whose `uuid` is not yet in `seen`, adds it to `seen` and forwards it to `onEvent` — in the SDK's
 * chronological order, unchanged (R5.3). `notifyEndOfTurn()` bypasses the debounce and forces one
 * immediate final re-read.
 *
 * Re-reads are SERIALIZED (never concurrent): a `reading` flag plus a coalesced `pendingReread`
 * flag guarantee that a signal arriving mid-read schedules exactly one more re-read after the
 * current one settles. Because the check-add-emit runs synchronously after the await, exactly-once
 * holds even if re-reads overlap logically (R4.1, R4.2, R5.2).
 *
 * @param opts session id, transcript path, dir, the onEvent sink, and injectable seams.
 * @returns a {@link JsonlWatcher} (a {@link SessionWatcher} plus `notifyEndOfTurn`).
 */
export function createJsonlWatcher(opts: JsonlWatcherOptions): JsonlWatcher {
  const {
    sessionId,
    transcriptPath,
    dir,
    onEvent,
    getMessages,
    tail = tailTranscript,
    debounceMs = DEFAULT_WATCHER_DEBOUNCE_MS,
    schedule = defaultSchedule,
  } = opts;

  // The SINGLE source of events: the SDK reader (or an injected stub). No second parser exists.
  const readMessages: GetMessages = getMessages ?? defaultGetMessages;

  // The emit-once guard. Dedupe key is `message.uuid`; survives across every live re-read so the
  // growing superset re-emits nothing already forwarded (R4.1).
  const seen = new Set<string>();

  // Lifecycle / serialization flags.
  let stopped = false; // set by stop(): suppress any further (incl. in-flight) emits + re-reads.
  let reading = false; // a re-read's async body is in flight — do not start a second concurrently.
  let pendingReread = false; // a signal arrived mid-read — run exactly ONE more re-read after.
  let cancelDebounce: (() => void) | undefined; // cancels the armed debounce timer, if any.

  /**
   * Run ONE re-read: await the SDK reader, then SYNCHRONOUSLY (no await between messages) emit each
   * not-yet-seen message in array order. The post-await synchrony is what makes exactly-once hold
   * even if two re-reads were logically requested — only the FIRST `seen.add(uuid)` lets `onEvent`
   * fire for that uuid. Serialized by the `reading` flag; a mid-read signal sets `pendingReread`
   * and we loop once more after settling.
   */
  const runReread = async (): Promise<void> => {
    if (stopped) return;
    if (reading) {
      // A re-read is already in flight; coalesce this request into a single follow-up pass.
      pendingReread = true;
      return;
    }
    reading = true;
    try {
      do {
        pendingReread = false;
        // The ONLY parse of the transcript — the SDK's pure reader. May be sync or async; await
        // handles both. After this await we must NOT await again before the emit loop, so the
        // check-add-emit stays atomic w.r.t. the microtask queue (no dedupe race across re-reads).
        let messages: SessionMessage[];
        try {
          messages = await readMessages(sessionId, { dir });
        } catch {
          // Transient SDK read failure — SWALLOW it (as the scheduleReread comment promises): emit
          // nothing this cycle, so a failing read never rejects an unhandled promise nor tears the
          // watcher down. A later write/end-of-turn signal triggers a fresh re-read; if a signal
          // arrived mid-read (`pendingReread`), the loop condition retries once, else we settle.
          continue;
        }
        // stop() may have fired during the await — do not emit after teardown (R: stop is final).
        if (stopped) return;
        for (const message of messages) {
          const { uuid } = message;
          if (typeof uuid === "string") {
            // Already forwarded on an earlier (sub)superset re-read → skip (R4.1, R4.2).
            if (seen.has(uuid)) continue;
            seen.add(uuid);
          }
          // No `uuid` (should not happen in-corpus): we cannot dedupe it, so we emit it rather than
          // silently drop a real event. Documented fallback — prefer emit-once-if-keyed over loss.
          onEvent(message);
        }
        // If a write/end-of-turn signal arrived mid-read, `pendingReread` is set: loop ONE more
        // time (coalesced) so we never miss the latest superset, but never run two reads at once.
      } while (pendingReread && !stopped);
    } finally {
      reading = false;
    }
  };

  /**
   * Debounced live path: (re)arm the debounce timer; after `debounceMs` of quiet it fires exactly
   * one re-read. Coalesces a burst of write signals into a single read. A no-op once stopped.
   */
  const scheduleReread = (): void => {
    if (stopped) return;
    cancelDebounce?.();
    cancelDebounce = schedule(() => {
      cancelDebounce = undefined;
      // Fire-and-forget: runReread serializes internally; errors are swallowed so a transient SDK
      // read failure never rejects an unhandled promise nor tears the watcher down.
      void runReread();
    }, debounceMs);
  };

  // Wire the tail. Each complete-line record is ONLY a write signal (its payload is unused as the
  // event source) — the event source is `getMessages`. The tail's residue buffer guarantees a torn
  // append fires no signal until its `\n` lands (so no re-read sees a half-written line).
  const transcriptTail = tail(transcriptPath, {
    onRecord: () => scheduleReread(),
  });

  return {
    notifyEndOfTurn(): void {
      if (stopped) return;
      // Forced FINAL re-read: bypass the debounce (cancel any pending live timer) and read NOW so
      // the just-completed turn is fully ingested. runReread serializes with any in-flight read.
      cancelDebounce?.();
      cancelDebounce = undefined;
      void runReread();
    },
    stop(): void {
      if (stopped) return; // idempotent (SessionWatcher contract).
      stopped = true; // suppress emits from any in-flight async re-read past this point.
      cancelDebounce?.();
      cancelDebounce = undefined;
      pendingReread = false;
      try {
        transcriptTail.stop();
      } catch {
        /* tail already stopped / transient — ignore */
      }
    },
  };
}

/**
 * Default {@link GetMessages}: the SDK's pure, billing-free `getSessionMessages`. Imported lazily
 * (dynamic import) so this module — and the deterministic unit tests, which always inject a stub —
 * never force-loads the SDK at module-eval time. Returns `[]` if the SDK import fails (defer rather
 * than throw); in production the seam is the real SDK function.
 */
async function defaultGetMessages(
  sessionId: string,
  opts?: { dir?: string },
): Promise<SessionMessage[]> {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  return sdk.getSessionMessages(sessionId, opts) as Promise<SessionMessage[]>;
}
