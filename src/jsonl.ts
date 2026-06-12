// === §6 JSONL data layer for the read-only tail watcher (story 015, Task Group 1) ===
//
// Dependency-free on purpose: ONLY node: builtins (the fork pins node-pty + the SDK as the
// only runtime deps). The proven glob logic is PORTED from experiments/lib/jsonl.ts — we do
// NOT import the probe harness, because the fork is a publishable package and must not depend
// on experiments/.
//
// Two locating facts pinned by IMPLEMENTACAO-FORK-ACP §6 / story 015 R1:
//   1. The transcript is found by GLOB on the sessionId basename:
//      the `<sessionId>.jsonl` basename anywhere under `~/.claude/projects` (R1.1). We NEVER compute or decode the
//      encoded project-dir name — the cwd→dir transform is irreversible and ambiguous
//      (`a_b` / `a.b` / `"a b"` / `a/b` all collapse to the same `a-b` dir). So the encoded
//      dir is never a reliable source of either the path OR the cwd.
//   2. The runtime cwd is read from the `.cwd` field of an event INSIDE the matched file
//      (R1.2), never from the directory name.
//
// The file-discovery watchdog here (FILE_DISCOVERY_WATCHDOG_MS = 2000) is DISTINCT from the
// 5583 ms turn watchdog and MUST NOT be conflated with it. This module only ever uses the
// file-discovery watchdog.
import { closeSync, globSync, openSync, readFileSync, readSync, statSync, watch } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

/**
 * Build the absolute glob pattern used to locate a session's transcript:
 * the `<sessionId>.jsonl` basename anywhere under `~/.claude/projects`, with `~` expanded via os.homedir
 * (globSync does NOT perform tilde expansion). Exposed so callers can report the
 * EXACT pattern they globbed in a not-found/ambiguity diagnostic without
 * re-deriving (and risking drift from) the string used by findTranscript (R1.3).
 *
 * @param sessionId the session id; equals the transcript filename basename.
 * @returns the absolute glob pattern findTranscript passes to globSync.
 */
export function transcriptGlob(sessionId: string): string {
  return join(homedir(), ".claude", "projects", "**", `${sessionId}.jsonl`);
}

/**
 * Find Claude transcript file(s) for a given session id.
 *
 * Globs the `<sessionId>.jsonl` basename anywhere under `~/.claude/projects` (`~` expanded via os.homedir)
 * so the file is found independent of the cwd→dir encoding (R1.1). Returns ALL
 * matches (normally one) as absolute paths; an empty array means "not found".
 *
 * @param sessionId the session id; equals the transcript filename basename.
 * @returns absolute paths to matching `<sessionId>.jsonl` files (possibly empty).
 */
export function findTranscript(sessionId: string): string[] {
  // globSync returns paths relative to cwd unless the pattern is absolute, which it is here
  // (homedir() is absolute, via transcriptGlob), so matches are absolute too. transcriptGlob
  // is the single source of the pattern string.
  return globSync(transcriptGlob(sessionId));
}

/**
 * The file-discovery watchdog window (ms): how long {@link locateTranscript} keeps polling the
 * glob for the transcript to appear before failing with a not-found diagnostic (R1.3).
 *
 * DISTINCT from the 5583 ms turn watchdog — never conflate them. This story uses ONLY the
 * file-discovery watchdog.
 */
export const FILE_DISCOVERY_WATCHDOG_MS = 2000;

/** Default polling interval (ms) between glob attempts while waiting for the transcript. */
export const DEFAULT_POLL_INTERVAL_MS = 50;

/** Options for {@link locateTranscript} / {@link resolveWatchTarget}. */
export interface LocateOptions {
  /** File-discovery watchdog window (ms); defaults to {@link FILE_DISCOVERY_WATCHDOG_MS}. */
  watchdogMs?: number;
  /** Poll interval (ms) between glob attempts; defaults to {@link DEFAULT_POLL_INTERVAL_MS}. */
  pollIntervalMs?: number;
  /** Injected for tests: returns matches for a sessionId. Default: {@link findTranscript}. */
  glob?: (sessionId: string) => string[];
  /** Injected for tests: monotonic clock in ms. Default: a `performance.now`-based clock. */
  now?: () => number;
  /** Injected for tests: `sleep(ms)`. Default: a `setTimeout`-based sleep. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Optional abort handle for a (possibly unbounded — see `watchdogMs: Infinity`) poll. Checked each
   * iteration; when it aborts mid-poll the poll rejects with an AbortError sentinel (`.name ===
   * "AbortError"`) — NOT the not-found fault — so a caller can swallow exactly the
   * cancelled-before-the-transcript-appears case and surface everything else (R1.2).
   */
  signal?: AbortSignal;
}

/** Default monotonic clock — `performance.now()` so the elapsed window is unaffected by wall-clock jumps. */
function defaultNow(): number {
  return performance.now();
}

/** Default sleep — resolve after `ms` via `setTimeout`. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll the glob until EXACTLY ONE match appears or the file-discovery watchdog elapses (R1.1,
 * R1.3, R1.4). Deterministic/test-friendly via injected `glob`/`now`/`sleep` so tests never wait
 * a real 2000 ms.
 *
 * - 0 matches at watchdog expiry → throw a not-found error whose message carries the EXACT glob
 *   pattern AND the elapsed ms (R1.3).
 * - >1 matches → throw a multi-match error listing EVERY matched path, so the ambiguity is loud
 *   rather than silently resolved (R1.4).
 * - exactly 1 → resolve `{ transcriptPath }`.
 *
 * @param sessionId the session id; equals the transcript filename basename.
 * @param opts injectable watchdog/poll/glob/clock/sleep seams.
 */
export async function locateTranscript(
  sessionId: string,
  opts: LocateOptions = {},
): Promise<{ transcriptPath: string }> {
  const watchdogMs = opts.watchdogMs ?? FILE_DISCOVERY_WATCHDOG_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const glob = opts.glob ?? findTranscript;
  const now = opts.now ?? defaultNow;
  const sleep = opts.sleep ?? defaultSleep;

  const start = now();
  // Poll until exactly one match appears OR the watchdog window is exhausted. We attempt the
  // glob first, THEN check the watchdog, so a match landing on the very last poll still wins;
  // the not-found fault only fires once the elapsed window has actually passed.
  for (;;) {
    const matches = glob(sessionId);

    // R1.2: a caller can cancel a (possibly unbounded) poll. If the signal aborted, short-circuit
    // BEFORE the not-found watchdog branch with a recognizable AbortError sentinel so the caller can
    // swallow exactly this case (cancelled before the transcript appeared) and surface every other
    // fault. Prefer the signal's own reason — for `new AbortController().abort()` (no reason) that is
    // a DOMException already named "AbortError" — and fall back to a named Error otherwise.
    if (opts.signal?.aborted) {
      throw (
        opts.signal.reason ??
        Object.assign(new Error("transcript discovery aborted"), { name: "AbortError" })
      );
    }

    if (matches.length > 1) {
      // R1.4: more than one transcript matched the sessionId basename. Fail loudly listing every
      // matched path rather than silently picking one — the ambiguity must be visible.
      throw new Error(
        `Multiple transcripts matched sessionId "${sessionId}" — refusing to pick one. ` +
          `Matched ${matches.length} paths:\n${matches.map((p) => `  - ${p}`).join("\n")}`,
      );
    }

    if (matches.length === 1) {
      return { transcriptPath: matches[0] };
    }

    // Zero matches so far. If the watchdog window has elapsed, fail with the not-found diagnostic;
    // otherwise sleep one poll interval and retry.
    const elapsed = now() - start;
    if (elapsed >= watchdogMs) {
      // R1.3: name the EXACT glob pattern (via transcriptGlob — single source of the string) and
      // the elapsed time so the diagnostic is actionable.
      throw new Error(
        `Transcript not found for sessionId "${sessionId}" after ${Math.round(elapsed)}ms ` +
          `(file-discovery watchdog ${watchdogMs}ms). Globbed: ${transcriptGlob(sessionId)}`,
      );
    }

    await sleep(pollIntervalMs);
  }
}

/** A single transcript record — an arbitrary object; we only ever read its optional `.cwd`. */
interface TranscriptRecord {
  cwd?: unknown;
  [key: string]: unknown;
}

/**
 * Read the runtime cwd from the `.cwd` field of the FIRST event inside the file that carries it
 * (R1.2). NEVER decode the directory name — the cwd→dir transform is irreversible, so the encoded
 * dir is not a reliable cwd source.
 *
 * Scans complete lines top-to-bottom and returns the first record whose `.cwd` is a non-empty
 * string. Returns `undefined` when the file has no complete line yet, or no event carries `.cwd`
 * yet — the caller should DEFER (re-read after more lines land) rather than guess from the dir
 * name. Corrupted/partial lines are skipped without throwing.
 *
 * @param transcriptPath absolute path to a `.jsonl` transcript (the path {@link locateTranscript}
 *   resolved).
 * @returns the inside `.cwd` value, or `undefined` if none is present yet.
 */
export function readCwdFromInside(transcriptPath: string): string | undefined {
  let contents: string;
  try {
    contents = readFileSync(transcriptPath, "utf8");
  } catch {
    // File not readable yet (e.g. created but not flushed) — defer rather than throw.
    return undefined;
  }

  // Only COMPLETE lines (terminated by "\n") are guaranteed whole; the trailing residue after the
  // final "\n" may be a partial write, so we never parse it here — we defer to a later re-read.
  const newlineIdx = contents.lastIndexOf("\n");
  if (newlineIdx < 0) return undefined;
  const completeRegion = contents.slice(0, newlineIdx);

  for (const line of completeRegion.split("\n")) {
    if (line.length === 0) continue;
    let record: TranscriptRecord;
    try {
      record = JSON.parse(line) as TranscriptRecord;
    } catch {
      // Corrupted/partial line — skip without aborting (forward-compat parser tolerance, §6).
      continue;
    }
    if (typeof record.cwd === "string" && record.cwd.length > 0) {
      return record.cwd;
    }
  }
  return undefined;
}

/**
 * Convenience: {@link locateTranscript} + {@link readCwdFromInside} → the resolved watch target
 * for the read-only tail watcher (R1.1, R1.2).
 *
 * Adopts the single globbed path as the watch target and sources the runtime cwd from an event
 * INSIDE that file. `cwd` may be `undefined` when no event has carried `.cwd` yet — the caller
 * DEFERS reading it until the first complete line provides it, rather than decoding the dir name.
 *
 * @param sessionId the session id; equals the transcript filename basename.
 * @param opts injectable watchdog/poll/glob/clock/sleep seams (forwarded to locateTranscript).
 */
export async function resolveWatchTarget(
  sessionId: string,
  opts: LocateOptions = {},
): Promise<{ transcriptPath: string; cwd: string | undefined }> {
  const { transcriptPath } = await locateTranscript(sessionId, opts);
  const cwd = readCwdFromInside(transcriptPath);
  return { transcriptPath, cwd };
}

// === §6 Newline-atomic line reader (story 015, Task Group 2) =================================
//
// SCOPE (architecture constraint): the line reader + residue buffer guard ONLY the TRIGGER path —
// deciding *when* a new complete, top-level-parseable record has landed — and are NEVER a second
// parser of `message.content`. The real event parse is `getSessionMessages` (Task 3). So the
// reader's whole job is: surface a complete `\n`-terminated, JSON.parse-able record as a
// write/append SIGNAL. The records it forwards are arbitrary objects (no fixed `.type`).
//
// Two invariants, ported (not imported) from the proven experiments/lib/jsonl.ts harness:
//   R2.2/R2.3 — only `\n`-terminated COMPLETE lines are forwarded; the trailing partial after the
//     final `\n` is held back in a residue buffer across pushes, so a large non-atomic append
//     (~630 KB base64 `image` line) split across two writes is withheld until its closing `\n`
//     arrives and therefore can NOT corrupt parsing.
//   R3.1/R3.2 — each complete line's JSON.parse is wrapped in try/catch; a corrupt line is SKIPPED
//     (continue), never throws. Because a transiently-truncated line stays in the residue until its
//     `\n` lands, it is re-presented and ingested on the next complete flush.

/** Callback invoked once per newly-completed, top-level-parseable record (the append/write signal). */
export type RecordHandler = (record: unknown) => void;

/**
 * Stateful line reader. Feed it raw chunks via {@link LineReader.push}; it forwards (via the
 * `onRecord` passed to {@link createLineReader}) only the `\n`-terminated COMPLETE lines, carrying
 * the trailing partial residue across pushes. Each complete line is `JSON.parse`'d in try/catch —
 * a corrupt line is SKIPPED (continue), never throws (R2.2, R2.3, R3.1, R3.2).
 */
export interface LineReader {
  /** Append a raw chunk; flush every now-complete `\n`-terminated line through onRecord. */
  push(chunk: string): void;
  /** The current buffered trailing partial (text after the last `\n`). Exposed for test introspection. */
  readonly residue: string;
}

/**
 * Parse ONE complete line and, on success, forward the record. A line that fails `JSON.parse` is
 * SKIPPED without aborting — one corrupt line never derails subsequent lines (R3.1). Blank lines
 * (e.g. from a `\n\n` gap or a trailing newline) are ignored, not treated as errors.
 *
 * @param line a single COMPLETE line (no embedded `\n`); the caller guarantees completeness.
 * @param onRecord invoked once iff the line parses to a JSON value.
 */
function parseCompleteLine(line: string, onRecord: RecordHandler): void {
  if (line.length === 0) return;
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    // Corrupt/partial top-level line — skip without aborting (forward-compat parser tolerance, §6).
    // NOT fatal: a transiently-truncated line is re-presented once its `\n` lands (R3.2).
    return;
  }
  onRecord(record);
}

/**
 * Create a stateful {@link LineReader}. Maintains a single residue buffer across {@link
 * LineReader.push} calls: each push appends to the buffer, splits on `\n`, holds the final segment
 * back as the new residue (it may be a partial write), and forwards every COMPLETE line through
 * `onRecord` (skipping any that fail `JSON.parse`).
 *
 * This is the deterministic, filesystem-free core the 2.1/2.2 scenarios drive directly.
 *
 * @param onRecord invoked once per newly-completed, top-level-parseable record.
 */
export function createLineReader(onRecord: RecordHandler): LineReader {
  // The trailing partial after the last `\n`. Held back until a later push supplies the `\n` that
  // completes it — this is what makes a non-atomic split append safe (R2.2, R2.3).
  let residue = "";
  return {
    push(chunk: string): void {
      residue += chunk;
      const segments = residue.split("\n");
      // The last segment is everything after the final `\n` (or the whole buffer if there was no
      // `\n`); it may be a partial line, so carry it forward as the new residue rather than parsing.
      residue = segments.pop() ?? "";
      for (const segment of segments) {
        parseCompleteLine(segment, onRecord);
      }
    },
    get residue(): string {
      return residue;
    },
  };
}

/**
 * Feed an explicit sequence of chunks through a fresh {@link LineReader} (residue buffered ACROSS
 * chunks), then flush the final residue as a last line. Exposed so the cross-chunk buffering +
 * corrupt-skip logic is directly unit-testable WITHOUT touching the filesystem — mirrors how the
 * experiments harness exposes `feedChunks`.
 *
 * Note the trailing flush: unlike a live tail (where a partial residue MUST stay withheld until its
 * `\n` arrives), a finite chunk sequence is "closed", so a final non-`\n`-terminated record is
 * treated as complete here. Tests that assert residue-withholding therefore drive {@link
 * createLineReader} directly (and inspect `.residue`) rather than going through `feedChunks`.
 *
 * @param chunks ordered text fragments (a record may straddle two fragments).
 * @param onRecord invoked once per successfully parsed record.
 */
export function feedChunks(chunks: Iterable<string>, onRecord: RecordHandler): void {
  const reader = createLineReader(onRecord);
  for (const chunk of chunks) {
    reader.push(chunk);
  }
  // End of input: the final residue (no trailing `\n`) may still be a full record — flush it.
  parseCompleteLine(reader.residue, onRecord);
}

/** Handle returned by {@link tailTranscript}; `stop()` detaches the watcher and drops the buffer. */
export interface TranscriptTail {
  stop(): void;
}

/** Options for {@link tailTranscript}. */
export interface TailOptions {
  /** Invoked once per newly-completed, top-level-parseable record (the append/write signal). */
  onRecord: RecordHandler;
  /** Injected for deterministic tests; default {@link defaultWatch} (fs.watch). Returns a closable subscription. */
  watch?: (path: string, onChange: () => void) => { close(): void };
  /** Injected for tests; default {@link defaultReadSlice} reads bytes `[fromByte, EOF)` of `path` as utf8. */
  readSlice?: (path: string, fromByte: number) => string;
  /** Injected for tests; default {@link defaultFileSize} is `fs.statSync(path).size`. */
  fileSize?: (path: string) => number;
}

/** Default watch seam: subscribe to fs.watch change events on `path`. */
function defaultWatch(path: string, onChange: () => void): { close(): void } {
  // fs.watch fires on every change; the tail loop re-checks the size, so spurious events are cheap.
  const watcher = watch(path, () => onChange());
  return { close: () => watcher.close() };
}

/** Default file-size seam: the current byte length of `path` (0 if it is not statable yet). */
function defaultFileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    // Not statable yet (e.g. transiently missing) — treat as empty; the next change event re-checks.
    return 0;
  }
}

/**
 * Default byte-slice seam: read bytes `[fromByte, EOF)` of `path` and decode as utf8. Reads by BYTE
 * offset (not by line) so each appended byte is read exactly once — essential for a large append
 * that the watcher may signal mid-write. Returns "" when there is nothing new (or on a transient
 * read error), letting the caller no-op until the next change event.
 */
function defaultReadSlice(path: string, fromByte: number): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = statSync(path).size;
    if (size <= fromByte) return "";
    const length = size - fromByte;
    const buf = Buffer.allocUnsafe(length);
    let read = 0;
    // Loop until the whole slice is read (a single readSync may return fewer bytes than requested).
    while (read < length) {
      const n = readSync(fd, buf, read, length - read, fromByte + read);
      if (n <= 0) break;
      read += n;
    }
    // Decode ONLY whole UTF-8 characters: a trailing incomplete multi-byte sequence is held back in
    // the StringDecoder's internal buffer and NOT emitted as a U+FFFD replacement char. Because that
    // tail is excluded from the returned string, the caller advances its byte offset only over bytes
    // that decoded to COMPLETE characters and RE-READS the incomplete tail on the next change — so a
    // multi-byte char straddling an fs.watch read boundary can never corrupt the offset or the parse
    // (R2.3). (A plain `buf.toString` would turn the partial bytes into U+FFFD, whose 3-byte re-encode
    // then desynchronizes the offset and silently skips file bytes.)
    return new StringDecoder("utf8").write(buf.subarray(0, read));
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already closed / transient — ignore */
      }
    }
  }
}

/**
 * Attach an fs.watch/tail-F to `path`. On each growth, read the appended bytes from the last byte
 * offset, push them through a {@link LineReader}, and forward complete records via `opts.onRecord`.
 * Tracks the read offset so each byte is read exactly once. Returns a {@link TranscriptTail} whose
 * `stop()` detaches the watcher and drops the buffer.
 *
 * The residue buffer makes a large NON-ATOMIC append safe: a ~630 KB base64 `image` line split
 * across two writes is withheld until its terminating `\n` is read, so the split can not corrupt
 * parsing (R2.3). A complete line that fails `JSON.parse` is skipped, never thrown (R3.1).
 *
 * Seams (`watch`/`readSlice`/`fileSize`) are injectable so the wiring is testable without real
 * fs.watch event timing; in production they default to fs.watch + a byte-offset read.
 *
 * @param path absolute path to the resolved transcript (what {@link locateTranscript} resolved).
 * @param opts onRecord sink plus injectable watch/readSlice/fileSize seams.
 */
export function tailTranscript(path: string, opts: TailOptions): TranscriptTail {
  const watchFn = opts.watch ?? defaultWatch;
  const readSlice = opts.readSlice ?? defaultReadSlice;
  const fileSize = opts.fileSize ?? defaultFileSize;

  const reader = createLineReader(opts.onRecord);
  // Byte offset already consumed. Start from the CURRENT size so the tail forwards only bytes
  // appended AFTER attach (tail-F semantics) — historical lines are Task 3's initial read, not ours.
  let offset = fileSize(path);
  let stopped = false;

  const onChange = (): void => {
    if (stopped) return;
    const size = fileSize(path);
    // Truncation/rotation: if the file shrank below our offset, reset to read from its new start so
    // we never slice a negative range or miss the rewritten head.
    if (size < offset) offset = 0;
    if (size <= offset) return; // no new bytes (a spurious change event) — nothing to do.
    const slice = readSlice(path, offset);
    if (slice.length === 0) return;
    // Advance by the BYTE length of the decoded slice (utf8), not the JS string length. `readSlice`
    // returns only WHOLE UTF-8 characters (its default withholds a trailing incomplete multi-byte
    // sequence for the next read), so this byte count exactly matches the bytes consumed and stays
    // aligned to the file's byte boundaries — a multi-byte char split across a read boundary is
    // re-read intact on the next change, never corrupted (R2.3).
    offset += Buffer.byteLength(slice, "utf8");
    reader.push(slice);
  };

  const subscription = watchFn(path, onChange);

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      try {
        subscription.close();
      } catch {
        /* already closed — ignore */
      }
    },
  };
}

// === §6 Typed event projection + heavy-image lazy-skip (story 015, Task Group 4) ==============
//
// EMPIRICAL SDK REALITY (verified against 174 real messages, claude 2.1.159): the REUSE-live source
// `getSessionMessages` returns objects with EXACTLY these top-level keys —
//   { uuid, type, timestamp, session_id, message, parent_tool_use_id }
// and NOT the remaining universal fields (parentUuid, cwd, gitBranch, version, isSidechain,
// entrypoint) nor the per-type extras (requestId / promptId / toolUseResult / permissionMode) —
// those live ONLY in the raw JSONL record, which the REUSE-live architecture (Tasks 1–3) does NOT
// use as the event source.
//
// ORCHESTRATOR DECISION ("REUSE-live fiel", user-confirmed): project the typed event FROM the
// getSessionMessages return — map the fields it DOES provide, hardcode userType:'external' (the
// story asserts it is always 'external'), and declare the 11 absent universal/extra fields OPTIONAL
// (undefined in Degrau-1, forward-compat). The projection is DEFENSIVE: if a fixture or a raw-shaped
// event DOES carry any optional field, it is passed through; otherwise it is left undefined. This
// keeps the typed event coherent with the already-committed REUSE-live Tasks 1–3 and avoids a
// second source-of-truth (a raw-record merge). The full `switch(.type)` taxonomy + unknown-type
// passthrough is story 016 — here we only (a) carry `type` through, (b) tolerate string-or-array
// `message.content`, and (c) strip heavy image data.

/**
 * A typed Degrau-1 conversation event, projected from a `getSessionMessages` message.
 *
 * Fields the SDK return provides are populated directly; the rest are OPTIONAL (undefined in
 * Degrau-1 — forward-compat — because they live only in the raw JSONL record, not in the REUSE-live
 * source) and are populated only if the input happens to carry them (see {@link projectEvent}).
 */
export interface JsonlEvent {
  /** Message uuid (the dedupe key upstream). Kept as-is; empty string if the input lacks one. */
  uuid: string;
  /** Message type, carried through verbatim — the taxonomy `switch(.type)` is story 016. */
  type: string;
  /** ISO timestamp, when present on the input. */
  timestamp?: string;
  /** Session id — projected from the input's `session_id`. */
  sessionId?: string;
  /** The API message object; `message.content` may be an ARRAY of blocks OR a raw STRING. */
  message: unknown;
  /** Projected from the input's `parent_tool_use_id`. */
  parentToolUseId?: string | null;
  /** Hardcoded `'external'` — the story asserts the user type is always external. */
  userType?: "external";
  // --- Universal fields NOT present in getSessionMessages (optional; populated only if present) ---
  parentUuid?: string | null;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  isSidechain?: boolean;
  entrypoint?: string;
  // --- Per-type extras (absent in the SDK return; populated only if present on the input) ---
  /** assistant-only request id. */
  requestId?: string;
  /** user-only prompt id. */
  promptId?: string;
  /** user-only tool-use result payload. */
  toolUseResult?: unknown;
  /** user-only permission mode. */
  permissionMode?: string;
}

/** Options for {@link projectEvent}. */
export interface ProjectOptions {
  /**
   * Byte threshold above which an `image` block's base64 `source.data` is skipped (so a heavy
   * ~630 KB PNG does not back-pressure the streaming read). Defaults to {@link DEFAULT_IMAGE_SKIP_BYTES}.
   * Set `Infinity` to keep ALL image data inline.
   */
  imageSkipBytes?: number;
}

/**
 * Default byte threshold for {@link stripHeavyImages} / {@link projectEvent}: an `image` block's
 * base64 `source.data` larger than this (~64 KB) is skipped, while a small inline image is kept.
 * Chosen so a ~630 KB PNG is dropped but a typical small icon survives.
 */
export const DEFAULT_IMAGE_SKIP_BYTES = 64 * 1024;

/** The placeholder substituted for a skipped image's base64 `source.data` (kept structurally valid). */
const SKIPPED_IMAGE_DATA = "";

/**
 * Narrowing helper: a non-null plain object (so we can read string-keyed props safely). Arrays and
 * `null` are excluded; everything else with `typeof === 'object'` qualifies.
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Copy `key` from `source` onto `target` ONLY if `source[key]` is not `undefined`. Keeps the
 * projection defensive: an optional universal field absent on the input is left `undefined` on the
 * event rather than written as an explicit `undefined`.
 */
function carryIfPresent(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  key: string,
): void {
  if (source[key] !== undefined) target[key] = source[key];
}

/**
 * Standalone heavy-image stripper (used by {@link projectEvent}; exported for direct testing).
 *
 * When `message.content` is an ARRAY, returns a SHALLOW-CLONED message whose content array has any
 * heavy `image` block's base64 `source.data` replaced by a skipped marker — PRESERVING the block's
 * `type`, `source.type`, `source.media_type`, adding `source.skipped = true` and `source.bytes =
 * <original byte length>` so downstream stays structurally valid and keeps a size hint. Non-image
 * blocks (e.g. `text`) and images below the threshold pass through UNCHANGED. When `message.content`
 * is a raw STRING (or `message` is not an object / has no array content), the input is returned
 * untouched. The input message and its blocks are NEVER mutated in place (the watcher may hold
 * references) — only the heavy blocks are cloned (others are shared by reference, which is safe
 * because we never mutate them).
 *
 * "Heavy" = `source.data` is a string whose UTF-8 byte length exceeds `imageSkipBytes`
 * (default {@link DEFAULT_IMAGE_SKIP_BYTES}). A `data` getter could provide TRUE laziness, but a
 * skip marker is sufficient for Degrau-1 and keeps the event serializable.
 *
 * @param message the API message object (or any value — non-matching shapes pass through).
 * @param imageSkipBytes byte threshold; `source.data` larger than this is skipped.
 * @returns the message with heavy image data skipped, or the original value untouched.
 */
export function stripHeavyImages(
  message: unknown,
  imageSkipBytes: number = DEFAULT_IMAGE_SKIP_BYTES,
): unknown {
  if (!isObject(message)) return message;
  const content = message.content;
  // Only array content can carry image blocks; a raw string (or absent content) is left untouched.
  if (!Array.isArray(content)) return message;

  let anyStripped = false;
  const newContent = content.map((block) => {
    if (!isObject(block) || block.type !== "image") return block;
    const source = block.source;
    if (!isObject(source) || source.type !== "base64") return block;
    const data = source.data;
    if (typeof data !== "string") return block;
    const bytes = Buffer.byteLength(data, "utf8");
    if (bytes <= imageSkipBytes) return block; // small inline image — keep as-is.

    // Heavy image: shallow-clone block + source, drop the base64 payload, keep a size hint so the
    // event stays structurally valid (type / source.type / media_type preserved) and downstream
    // can tell an image WAS here and how big it was.
    anyStripped = true;
    return {
      ...block,
      source: {
        ...source,
        data: SKIPPED_IMAGE_DATA,
        skipped: true,
        bytes,
      },
    };
  });

  // If nothing was heavy, return the original message untouched (no needless clone).
  if (!anyStripped) return message;
  return { ...message, content: newContent };
}

/**
 * Project a `getSessionMessages` message (or a raw-shaped event) into a typed {@link JsonlEvent}.
 *
 * Maps the SDK-shape fields: `session_id → sessionId`, `parent_tool_use_id → parentToolUseId`,
 * carries `uuid` / `type` / `timestamp` / `message` through, and hardcodes `userType: 'external'`.
 * Every OPTIONAL universal field and per-type extra (parentUuid, cwd, gitBranch, version,
 * isSidechain, entrypoint, requestId, promptId, toolUseResult, permissionMode) is passed through
 * ONLY if it is present on the input (defensive forward-compat), else left `undefined`. Tolerates
 * `message.content` as an ARRAY or a raw STRING. By default also strips heavy `image` base64 data
 * via {@link stripHeavyImages} (see `opts.imageSkipBytes`; raw-string content is left untouched).
 *
 * Never throws on unusual input: a missing `uuid` becomes `''`; a non-object input yields an event
 * with empty `uuid`, `type === ''`, and `message === undefined`.
 *
 * @param message a `getSessionMessages` message (or raw-shaped event); any value is tolerated.
 * @param opts projection options (the heavy-image byte threshold).
 * @returns the typed {@link JsonlEvent}.
 */
export function projectEvent(message: unknown, opts: ProjectOptions = {}): JsonlEvent {
  const imageSkipBytes = opts.imageSkipBytes ?? DEFAULT_IMAGE_SKIP_BYTES;
  const src: Record<string, unknown> = isObject(message) ? message : {};

  // Strip heavy image data off the message before surfacing it (no-op on string/absent content).
  const projectedMessage = stripHeavyImages(src.message, imageSkipBytes);

  const event: JsonlEvent = {
    uuid: typeof src.uuid === "string" ? src.uuid : "",
    type: typeof src.type === "string" ? src.type : "",
    message: projectedMessage,
    // The story asserts the user type is always 'external' (hardcoded, not read from the input).
    userType: "external",
  };

  // SDK-shape fields → typed names (only when present, to avoid writing explicit undefined).
  if (typeof src.timestamp === "string") event.timestamp = src.timestamp;
  if (typeof src.session_id === "string") event.sessionId = src.session_id;
  if (src.parent_tool_use_id !== undefined) {
    event.parentToolUseId = src.parent_tool_use_id as string | null;
  }

  // Optional universal fields + per-type extras: passed through verbatim ONLY if present on the
  // input (absent in the SDK return; populated only by a raw-shaped fixture/event). The field name
  // is the same on input and output for all of these, so a name-preserving carry suffices.
  const eventRec = event as unknown as Record<string, unknown>;
  for (const key of [
    "parentUuid",
    "cwd",
    "gitBranch",
    "version",
    "isSidechain",
    "entrypoint",
    "requestId",
    "promptId",
    "toolUseResult",
    "permissionMode",
  ]) {
    carryIfPresent(eventRec, src, key);
  }

  return event;
}
