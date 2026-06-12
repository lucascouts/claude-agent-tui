import {
  Agent,
  AgentSideConnection,
  AuthenticateRequest,
  AuthMethod,
  CancelNotification,
  ClientCapabilities,
  ForkSessionRequest,
  ForkSessionResponse,
  InitializeRequest,
  InitializeResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  ndJsonStream,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  RequestError,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SessionConfigOption,
  SessionModelState,
  SessionModeState,
  SessionNotification,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  SetSessionModelRequest,
  SetSessionModelResponse,
  SetSessionModeRequest,
  SetSessionModeResponse,
  ToolCallContent,
  CloseSessionRequest,
  CloseSessionResponse,
  DeleteSessionRequest,
  DeleteSessionResponse,
  TerminalHandle,
  TerminalOutputResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from "@agentclientprotocol/sdk";
import {
  deleteSession,
  listSessions,
  ModelInfo,
  Options,
  PermissionMode,
  PermissionUpdate,
  SDKMessageOrigin,
  SDKPartialAssistantMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { ContentBlockParam } from "@anthropic-ai/sdk/resources";
import { BetaContentBlock, BetaRawContentBlockDelta } from "@anthropic-ai/sdk/resources/beta.mjs";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import packageJson from "../package.json" with { type: "json" };
import { SettingsManager } from "./settings.js";
import {
  applyTaskCreate,
  applyTaskUpdate,
  ClaudePlanEntry,
  parseTaskCreateOutput,
  planEntries,
  registerHookCallback,
  TaskState,
  taskStateToPlanEntries,
  toolInfoFromToolUse,
  toolUpdateFromDiffToolResponse,
  toolUpdateFromToolResult,
} from "./tools.js";
import { nodeToWebReadable, nodeToWebWritable, unreachable } from "./utils.js";
// === SEAM(011): engine boundary — inject a temporary no-op engine so the agent
// boots without the cut SDK query() path; the real PTY engine arrives in 013–015/023.
// See fork/SEAM-MAP.md (createSession/prompt CUT→023) and src/engine.ts. ===
import { type Engine, createStubEngine } from "./engine.js";
// === SEAM(023) Group 1: the real PTY + JSONL-tail engine wiring for createSession.
// createSession spawns the subscription `claude` TUI under a PTY (story 013) managed by a
// per-session engine (story 014), tails its JSONL transcript (story 015) as the single source
// of truth, and locates that transcript by sessionId glob + reads the runtime cwd from inside
// it (story 015 jsonl.ts). NO SDK `query()` is on this path. See IMPLEMENTACAO-FORK-ACP §2/§5/§6.
import type { IPty } from "node-pty";
import { createSessionEngine, spawnResumePty, SessionEngine } from "./engine-lifecycle.js";
import type { SessionWatcher } from "./engine-lifecycle.js";
import { createJsonlWatcher } from "./engine-watcher.js";
import type { JsonlWatcher, GetMessages, SessionMessage } from "./engine-watcher.js";
import { resolveWatchTarget } from "./jsonl.js";
import type { LocateOptions } from "./jsonl.js";
import { linearizeTurns, readOrderedMessages, defaultGetMessages } from "./linearize.js";
import { createDiffEnrichedReader } from "./diff-enriched-reader.js";
import type { DiffEnrichedReaderOptions } from "./diff-enriched-reader.js";
import {
  sourceSubagentRows,
  defaultListSubagents,
  defaultGetSubagentMessages,
  hasSubagentSpawn,
  spawnIdsOpen,
} from "./subagent-source.js";
import type { ListSubagents, GetSubagentMessages } from "./subagent-source.js";
import { createSubagentWatcher } from "./subagent-watcher.js";
import type { SubagentWatcher } from "./subagent-watcher.js";
import { classifyDiffSource, diffToolCallUpdate } from "./diff-source.js";
import { guardEvent } from "./billing/entrypoint-guard.js";
import type { WatchedMessage } from "./billing/entrypoint-guard.js";
import { usageUpdatesFor, type UsageCarrier } from "./usage.js";
import { createTurnResolver } from "./end-of-turn.js";
import type { DetectorSchedule, EndOfTurnDetector } from "./end-of-turn.js";
import { sendPrompt } from "./engine-pty.js";
import { setupSessionGate } from "./permissions/gate-wiring.js";
import type { GatePty, SessionGate, SessionGateOptions } from "./permissions/gate-wiring.js";

export const CLAUDE_CONFIG_DIR =
  process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");

const MAX_TITLE_LENGTH = 256;

function sanitizeTitle(text: string): string {
  // Replace newlines and collapse whitespace
  const sanitized = text
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (sanitized.length <= MAX_TITLE_LENGTH) {
    return sanitized;
  }
  return sanitized.slice(0, MAX_TITLE_LENGTH - 1) + "…";
}

/**
 * Logger interface for customizing logging output
 */
export interface Logger {
  log: (...args: any[]) => void;
  error: (...args: any[]) => void;
}

type AccumulatedUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  cachedWriteTokens: number;
};


const DEFAULT_CONTEXT_WINDOW = 200000;

type Session = {
  // === SEAM(023) Group 1: PTY-backed session record (migrated OFF the SDK Query, story C9). ===
  /** The live PTY handle (story 013/014) running the subscription `claude` TUI for this session. */
  pty: IPty;
  /**
   * The per-session JSONL tail watcher (story 015); the single source of truth for state (§2).
   * OPTIONAL (story 028, sub-task 2.1): a FRESH session returns BEFORE its transcript exists, so the
   * watcher is armed later — out of band — once the transcript appears on the user's first
   * interaction. It is `undefined` between create and that first appearance.
   */
  watcher?: JsonlWatcher | SessionWatcher;
  /** Emit-once guard: uuids already surfaced to the client (Group 2 wires the pump that fills it). */
  emitted: Set<string>;
  /**
   * Story 041 (R2.3) — emit-once guard for NESTED sub-agent (sidechain) rows, kept PARALLEL to and
   * DECOUPLED from `emitted`. The nested pass dedups per sub-agent row uuid here so a late-arriving
   * sidechain row still emits after its spawning turn's uuid is already in `emitted` (the parent turn
   * was surfaced in an earlier pump). Per-session — sub-agent row uuids are session-scoped.
   */
  emittedNested: Set<string>;
  /** The managed engine that owns the PTY + watcher; used for idempotent teardown (story 014). */
  engine?: SessionEngine;
  cancelled: boolean;
  cwd: string;
  /** Serialized snapshot of session-defining params (cwd, mcpServers) used to
   *  detect when loadSession/resumeSession is called with changed values. */
  sessionFingerprint: string;
  settingsManager: SettingsManager;
  accumulatedUsage: AccumulatedUsage;
  modes: SessionModeState;
  models: SessionModelState;
  modelInfos: ModelInfo[];
  configOptions: SessionConfigOption[];
  /** Context window size of the last top-level assistant model, carried across
   *  prompts so mid-stream usage_update notifications report a correct `size`
   *  before the turn's first result message arrives. Defaults to
   *  DEFAULT_CONTEXT_WINDOW, refreshed from each result's modelUsage, and
   *  invalidated when the user switches the session's model. */
  contextWindowSize: number;
  /** Accumulated task list for the session, keyed by task ID. Task IDs are
   *  per-session, so this state must not be shared across sessions. */
  taskState: TaskState;
  /** Per-session tool_use cache so the pump's tool_call→tool_call_update lifecycle stays correct
   *  across LIVE re-reads (story 023 Groups 2-3). Per-session — tool_use ids are session-scoped. */
  toolUseCache: ToolUseCache;
  /** Set once the §10 billing guard-rail (story 022) has inspected the first batch (Group 4.1). */
  guardChecked: boolean;
  /** Story 025 (R3.3, R8) — latched true once the client rejects a usage_update; suppresses all
   *  further usage_update emission for the session (the surrounding stream keeps flowing). */
  usageDisabled: boolean;
  /**
   * Story 030 (R5.1) — the in-flight turn's end-of-turn detector for the current `session/prompt`.
   * `prompt()` sets it (via {@link createTurnResolver}) for the duration of one turn so the live pump
   * can feed raw JSONL messages to it and the cancel path can reach it; cleared in `prompt()`'s
   * `finally`. The detector — never the writer — resolves the pending prompt (R5.1).
   */
  turnDetector?: EndOfTurnDetector;
  /**
   * Story 031 (R2.1, R2.2) — the in-flight turn's cancel handle from {@link createTurnResolver}.
   * `prompt()` sets it for the turn's duration so the cancel path resolves the pending prompt as
   * `cancelled` through the story-024 latch; cleared in `prompt()`'s catch + finally. Undefined when
   * no turn is in flight (cancel is then a no-op).
   */
  turnCancel?: () => void;
  /**
   * Story 030 (R5.1) — per-session high-water cursor into the monotonic ordered superset
   * {@link readOrderedMessages} returns, so each raw message is fed to {@link turnDetector} exactly
   * once and a prior turn's terminal boundary is never re-observed.
   */
  detectorCursor?: number;
  /**
   * Story 034 (§9 / R3.3) — the per-session HYBRID permission-gate runtime: loopback `PreToolUse`
   * hook server + scratch `--settings` backup + `tool_use.id` correlator. Present only when the
   * gate is enabled AND the session spawned fresh (resume/replay paths carry no gate). The live
   * pump REGISTERS every JSONL `tool_use` id into `gate.correlator`; `teardownSession` and the PTY
   * `onExit` hook both call `gate.teardown()` (idempotent).
   */
  gate?: SessionGate;
  /**
   * Story 044 (R2.2/R2.3) — the per-session Option-B sub-agent watcher: polls the story-041 SDK
   * sidechain readers while a `Task`/`Agent` spawn is OPEN on the main chain, feeding turn liveness
   * + the incremental nested render. Armed by the pump ONLY while such a spawn is open AND the
   * `liveSubagentWatch` flag is ON; stopped when every spawn id closes (R2.2), when the turn ends
   * (prompt finally), and on session teardown (R2.3). Undefined whenever no watcher is armed.
   */
  subagentWatcher?: SubagentWatcher;
  /**
   * Story 044 (R3.1) — the latest main chain the pump read. The watcher's `onActivity` re-emits
   * from it, so an incremental nested render needs NO main-chain re-read: the sidechain rows are
   * sourced fresh inside `emitLinearizedWithNested`; the main chain is whatever the last pump saw.
   */
  lastMessages?: SessionMessage[];
};

// === SEAM(023) Group 1: the createSession injection seam ======================================
//
// Tests must drive createSession WITHOUT spawning the real `claude` binary or touching ~/.claude.
// `StartEngine` is the single seam: it spawns the PTY engine (story 013/014), starts the JSONL tail
// watcher (story 015), locates the transcript by sessionId glob, and reads the runtime cwd from
// inside it (story 015 jsonl.ts). It defaults to {@link defaultStartEngine} (the production wiring);
// tests inject a fake that returns sentinel handles. The watcher's `onEvent` pump does NOT exist in
// Group 1 — Group 2 wires it; here onEvent is a no-op placeholder.

/** What {@link StartEngine} returns: the authoritative session id (engine-spawn-generated for a
 *  fresh session, the resumed id otherwise), the live PTY, the started watcher, the owning engine,
 *  and the runtime cwd discovered from inside the JSONL (may be undefined until the first line). */
export interface StartedEngine {
  sessionId: string;
  pty: IPty;
  /**
   * The started watcher. OPTIONAL (story 028, sub-task 2.1): the FRESH path now returns BEFORE the
   * transcript exists, so it returns `watcher: undefined` and arms the watcher in the background
   * once the transcript appears (it sets `engine.watcher` then). The RESUME path still returns the
   * armed watcher synchronously.
   */
  watcher?: JsonlWatcher | SessionWatcher;
  engine?: SessionEngine;
  cwd?: string;
}

/** Arguments passed to {@link StartEngine}. `sessionId` is the requested id for resume/fork; for a
 *  fresh session it is undefined and the engine's spawn generates the authoritative id. */
export interface StartEngineArgs {
  /** Requested session id (resume/fork). Undefined for a fresh session (engine generates it). */
  sessionId?: string;
  /** Host working directory the TUI spawns in. */
  cwd: string;
  /** True when reattaching to a prior session (story 014 robust resume argv). */
  resume?: boolean;
  /** Base environment to sanitize (defaults to process.env in the production wiring). */
  baseEnv?: Record<string, string | undefined>;
  /** The live session registry the engine registers into / deletes from on cleanup. */
  sessions?: Map<string, SessionEngine>;
  /**
   * Group 2 pump trigger: invoked with the RESOLVED session id on every watcher signal so the
   * tail-driven update pump re-reads the JSONL and emits. Absent in pure-spawn unit tests.
   */
  onEvent?: (sessionId: string) => void;
  /**
   * Story 027 (live-acceptance regression): Degrau-1 read-only loadSession path. When true, the
   * engine LOCATES the existing transcript for replay but does NOT spawn a live `claude --resume`
   * (no PTY, no tail watcher, no live engine). A live resume would (a) re-emit the whole history
   * through the tail pump (double render in the Agent Panel) and (b) run with the fork process cwd
   * (≠ the session cwd), writing a duplicate-basename transcript that makes the sessionId glob
   * ambiguous → resourceNotFound on the next load. Default false: fresh/resume spawn is unchanged.
   */
  replayOnly?: boolean;
  /**
   * Story 028 (sub-task 2.1): injectable node-pty spawn. Forwarded to {@link createSessionEngine}
   * (fresh) and {@link spawnResumePty} (resume) so a test can drive the REAL {@link
   * defaultStartEngine} without launching a real `claude` TUI. Production passes nothing → the real
   * `pty.spawn`.
   */
  spawn?: typeof import("node-pty").spawn;
  /**
   * Story 028 (sub-task 2.1): injectable transcript-discovery seams (glob/clock/etc.) forwarded to
   * the internal {@link resolveWatchTarget} calls so a test injects ONLY the `glob` (and, in a Red
   * probe, a finite `watchdogMs`) without re-masking the bug by stubbing discovery wholesale. On the
   * FRESH path the internal `watchdogMs: Infinity` and `signal` are applied AROUND this (signal last,
   * so the cancellation handle always wins). Production passes nothing → real glob + real clock.
   */
  locateOptions?: LocateOptions;
  /**
   * Story 034 (§9 hybrid gate): the per-session SCRATCH settings file (story-032 `injectHook`)
   * carrying the fork's `PreToolUse` hook, appended to the FRESH spawn as `--settings "<file>"`.
   * Already written BEFORE startEngine is called (blocker c ordering). Absent → ungated spawn.
   * Fresh-path only — mirroring the story-029 `planMode` precedent, the resume argv
   * (`buildResumeArgv`) is NOT extended here; the replay-only load path spawns nothing.
   */
  settingsFile?: string;
}

/** The createSession injection seam: spawn the PTY engine + JSONL watcher + locate the transcript. */
export type StartEngine = (args: StartEngineArgs) => Promise<StartedEngine> | StartedEngine;

/**
 * No-op {@link IPty} stub for the Degrau-1 replay-only load path: there is no live `claude` process,
 * but the session record's `pty` field is typed `IPty`. Every method is inert — teardown's `kill()`
 * is a no-op and a read-only load never writes/resizes it.
 */
const REPLAY_ONLY_NOOP_PTY = {
  onExit: () => ({ dispose() {} }),
  onData: () => ({ dispose() {} }),
  resize() {},
  write() {},
  kill() {},
} as unknown as IPty;

/** Optional bundle of injectable dependencies for {@link ClaudeAcpAgent} (Degrau-1 PTY engine). */
export interface AgentDeps {
  /** Override the PTY-engine + JSONL-watcher start (production default: {@link defaultStartEngine}). */
  startEngine?: StartEngine;
  /** Override the live JSONL reader the pump re-reads on each signal (default: SDK getSessionMessages). */
  getMessages?: GetMessages;
  /**
   * Story 041 — override the sidechain readers the pump sources nested sub-agent rows from
   * (defaults: SDK `listSubagents` / `getSubagentMessages` via {@link defaultListSubagents} /
   * {@link defaultGetSubagentMessages}). Injected by the deterministic unit tests as stubs/spies.
   */
  listSubagents?: ListSubagents;
  getSubagentMessages?: GetSubagentMessages;
  /**
   * Story 025 / Task 3.1 (R3.1) — opt IN to the UNSTABLE `usage_update` notification. Defaults
   * OFF: the pump constructs and emits no usage_update at all, so the session/update stream is
   * byte-for-byte unaffected. Kept OFF in production until the live-Zed acceptance probe
   * (Task 3.3, R8) confirms the user's Zed tolerates it.
   */
  usageUpdate?: boolean;
  /**
   * Story 043 (R2.1/R2.2/R5.1) — opt IN to the live Edit/Write diff. When ON, `this.getMessages` is
   * wrapped in the diff-enriched reader (getSessionMessages + uuid→`toolUseResult` hydration), which
   * restores the story-021 structuredPatch diff on BOTH the live pump and the session/load replay
   * (both read `this.getMessages` once). Defaults OFF at THIS constructor seam (the story-038
   * `usageUpdate` two-layer pattern) so directly-constructed test agents get the byte-for-byte pre-043
   * reduced reader for determinism; the entrypoint (index.ts) is what defaults it ON (LIVE_DIFF, ON
   * unless `LIVE_DIFF=0`/`false`). OFF → byte-for-byte the pre-043 reduced reader (R5.1).
   */
  liveDiff?: boolean;
  /**
   * Story 043 — test seam: the injectable {@link DiffEnrichedReaderOptions} forwarded to the
   * diff-enriched reader when `liveDiff` is ON, so a unit test drives the reader's
   * `findTranscript`/`readRawLines` deterministically WITHOUT touching the real `~/.claude` transcript
   * tree (without it the pump-integration test would hit the real filesystem). Production passes
   * nothing → the reader uses its billing-free `~/.claude` glob + `fs` read defaults.
   */
  diffEnrichOptions?: DiffEnrichedReaderOptions;
  /**
   * Story 044 (R4.1/R4.2) — opt IN to the live sub-agent watcher: the Option-B 2nd watcher that
   * POLLs the SDK sidechain readers while a turn is in flight, feeding the story-024 detector's
   * `noteActivity()` seam + the incremental nested render so a long-running sub-agent (rows in
   * subagents/*.jsonl, MAIN transcript silent) no longer false-stalls the turn watchdog. Defaults
   * OFF at THIS constructor seam (the story-038 `usageUpdate` two-layer pattern) so
   * directly-constructed test agents arm no 2nd watcher for determinism; the entrypoint (index.ts)
   * is what defaults it ON (FORK_LIVE_SUBAGENT_WATCH, ON unless "0"/"false"). OFF → byte-for-byte
   * today's pull-only path: NO 2nd watcher armed (R4.2).
   */
  liveSubagentWatch?: boolean;
  /**
   * Story 030 (R1.2, R5.1) — the single timer seam shared by `sendPrompt` (the §8 write→\r delay)
   * and `createTurnResolver` (the detector's Δt + watchdog). Injecting ONE schedule lets a unit test
   * drive both with one fake clock. Defaults to a `setTimeout`/`clearTimeout` wrapper.
   */
  schedule?: DetectorSchedule;
  /**
   * Story 031 (R1.2) — the short LOCAL escalation window (ms) between cancel-ladder rungs:
   * Ctrl+C → wait → Esc → wait → kill. DISTINCT from the 5583 ms turn watchdog (story 024), which
   * is NOT re-derived here. Injected so a unit test drives the ladder with a fake clock; defaults to
   * a conservative production value. Live in-Zed cancel tuning is out of scope (story 031).
   */
  cancelEscalationMs?: number;
  /**
   * Story 034 (§9 / R3.3) — enable the per-session HYBRID permission gate wiring: free loopback
   * port + `PreToolUse` hook server + scratch `--settings` inject on every FRESH spawn, with the
   * decider raising ACP `session/request_permission` correlated by `tool_use.id`. Resolved by the
   * production bootstrap (index.ts) from `FORK_GATE` — ON unless `FORK_GATE=off` (the v1 policy is
   * the hybrid gate, PERMISSIONS.md §1; the env var is the diagnostic escape hatch). Defaults OFF
   * at THIS constructor seam (the story-038 `usageUpdate` two-layer pattern) so directly-constructed
   * test agents spin no servers and write no files unless they opt in.
   */
  gate?: boolean;
  /**
   * Story 034 — gate timing/placement knobs forwarded to {@link setupSessionGate} (correlation
   * wait, #52822 sweep windows, scratch dir, port allocator). `client`/`onWarn` are agent-owned and
   * cannot be overridden. Tests inject short windows here; production passes nothing.
   */
  gateOptions?: Omit<SessionGateOptions, "client" | "onWarn">;
}

/**
 * Production default for the {@link StartEngine} seam. Spawns the subscription `claude` TUI under a
 * managed PTY engine (story 013/014), starts the read-only JSONL tail watcher (story 015) bound to
 * that PTY, then locates the transcript by sessionId glob and reads the runtime cwd from INSIDE it
 * (story 015 jsonl.ts; the cwd→dir encoding is irreversible, so we never decode the dir name).
 *
 * Fresh session: {@link createSessionEngine} spawns the PTY and generates the authoritative session
 * id internally (story 013) — that id becomes the session key. Resume/fork: {@link spawnResumePty}
 * reattaches to the requested id with the §5 robust-resume argv, wrapped in a {@link SessionEngine}.
 *
 * The watcher's `onEvent` is a no-op placeholder in Group 1 — the ACP pump that forwards new JSONL
 * messages to the client is Group 2. NO SDK `query()` is reachable here.
 */
export async function defaultStartEngine(args: StartEngineArgs): Promise<StartedEngine> {
  // Each watcher signal triggers the caller's pump (story 023 Group 2) with the RESOLVED session id;
  // the per-message payload is unused — the JSONL tail is the source, the signal just says "re-read".
  // `args.onEvent` is absent in pure-spawn unit tests, so the watcher is a no-op there.

  if (args.replayOnly && args.sessionId) {
    // === SEAM(027): Degrau-1 read-only loadSession is REPLAY-ONLY. LOCATE the existing transcript
    // for replay, but do NOT spawn `claude --resume`. A live resume would (a) re-emit the whole
    // history through the tail pump (double render in the Agent Panel) and (b) run with the fork
    // process cwd (≠ the session cwd), writing a duplicate-basename transcript that makes the
    // sessionId glob ambiguous → resourceNotFound on the next load. A missing/ambiguous transcript
    // throws here → createSession's resume catch maps it to resourceNotFound (unchanged client
    // contract). No PTY, no tail watcher, no live engine — the only emission is replaySessionHistory.
    const { cwd } = await resolveWatchTarget(args.sessionId, { ...args.locateOptions });
    return { sessionId: args.sessionId, pty: REPLAY_ONLY_NOOP_PTY, watcher: undefined, engine: undefined, cwd };
  }

  if (args.resume && args.sessionId) {
    // Resume/fork: reattach to the requested id with the §5 robust-resume argv, then discover the
    // (already-existing) transcript by glob and tail it. The engine owns the PTY + watcher teardown.
    const handle = spawnResumePty({
      sessionId: args.sessionId,
      cwd: args.cwd,
      baseEnv: args.baseEnv,
      spawn: args.spawn,
    });
    const { transcriptPath, cwd } = await resolveWatchTarget(args.sessionId, { ...args.locateOptions });
    const watcher = createJsonlWatcher({
      sessionId: args.sessionId,
      transcriptPath,
      dir: cwd,
      onEvent: () => args.onEvent?.(args.sessionId!),
    });
    const engine = new SessionEngine({ handle, watcher, sessions: args.sessions });
    return { sessionId: args.sessionId, pty: handle.pty, watcher, engine, cwd };
  }

  // Fresh session: the engine spawns the PTY and generates the authoritative session id (story 013).
  //
  // === SEAM(028) sub-task 2.1: BACKGROUND-DEFER the fresh-path transcript discovery ===============
  // The Claude Code TUI writes `<sessionId>.jsonl` only on the user's FIRST interaction, so for a
  // fresh session the transcript is ABSENT at create time. The old blocking
  // `await resolveWatchTarget(engine.sessionId)` therefore threw not-found after the 2000ms FATAL
  // file-discovery watchdog → every new Zed session aborted (R1.1). The fix: return as soon as the
  // PTY is live, discover the transcript in the BACKGROUND under `watchdogMs: Infinity` (cancellable
  // via a signal), and arm the watcher + fire the first onEvent only when the transcript APPEARS.
  const engine = createSessionEngine({
    cwd: args.cwd,
    baseEnv: args.baseEnv,
    sessions: args.sessions,
    spawn: args.spawn,
    // Story 034 (§9): the per-session gate scratch settings, already on disk — claude reads them at
    // startup, so the hook gates the FIRST tool call (blocker c). Absent → ungated (pre-034) spawn.
    settingsFile: args.settingsFile,
  });

  // Hand the engine the cancellation handle for the background poll. STORE-ONLY here — the
  // cleanup→`.abort()` wiring (so tearing a never-interacted session down cancels this dangling poll)
  // is sub-task 3.1. The `signal` is threaded into resolveWatchTarget below so 3.1's abort unblocks it.
  const ac = new AbortController();
  engine.setPendingDiscovery(ac);

  // Kick the discovery off in the BACKGROUND — do NOT await it on the create path. An unbounded
  // (`watchdogMs: Infinity`) poll resolves only once the transcript materializes (R1.3). `watchdogMs:
  // Infinity` is set FIRST, then `args.locateOptions` is spread (a test injects `glob`/clock here),
  // then `signal: ac.signal` LAST so the internal cancellation signal always wins (a test must not
  // override it). Its own try/catch keeps the unawaited promise from ever rejecting unhandled.
  void (async () => {
    try {
      const { transcriptPath, cwd } = await resolveWatchTarget(engine.sessionId, {
        watchdogMs: Infinity,
        ...args.locateOptions,
        signal: ac.signal,
      });
      // The transcript appeared (first interaction): arm the read-only tail watcher against the REAL
      // resolved path, bind it to the engine so cleanup() stops it (story 014), and fire onEvent ONCE
      // so the pump ingests the content already present (R1.3 — not merely "a file exists").
      const watcher = createJsonlWatcher({
        sessionId: engine.sessionId,
        transcriptPath,
        dir: cwd ?? args.cwd,
        onEvent: () => args.onEvent?.(engine.sessionId),
      });
      engine.watcher = watcher;
      args.onEvent?.(engine.sessionId);
    } catch (err) {
      // Swallow ONLY the abort sentinel: the session was torn down before any interaction, so the
      // never-resolving poll was cancelled — that is expected, not a fault. SURFACE everything else
      // (the multi-match ambiguity fault, an IO error): defaultStartEngine has no logger, so a
      // prefixed console.error is acceptable — NEVER silently drop it, or the ambiguity diagnostic is
      // lost on the fresh path.
      if ((err as { name?: string } | undefined)?.name === "AbortError") return;
      console.error(
        `[acp-agent] fresh-session transcript discovery failed for ${engine.sessionId}:`,
        err,
      );
    }
  })();

  // Return IMMEDIATELY — the PTY is live; the watcher arms later, out of band. `watcher: undefined`
  // until the transcript appears; the cwd falls back to the known host `args.cwd` (the inside-cwd is
  // not known until the first JSONL line lands).
  return { sessionId: engine.sessionId, pty: engine.pty, watcher: undefined, engine, cwd: args.cwd };
}

/** A single default Degrau-1 model entry. The TUI owns real model selection in Degrau-1; this is an
 *  honest non-interactive default so configOptions/modes have a coherent current model to anchor on. */
const DEGRAU1_DEFAULT_MODEL_INFO: ModelInfo = {
  value: "default",
  displayName: "Default",
  description: "Default model (selection is owned by the interactive TUI in Degrau-1)",
};

/** Build the static Degrau-1 model state (no SDK initializationResult). Single default model. */
function buildDegrau1Models(): SessionModelState {
  return {
    availableModels: [
      {
        modelId: DEGRAU1_DEFAULT_MODEL_INFO.value,
        name: DEGRAU1_DEFAULT_MODEL_INFO.displayName,
        description: DEGRAU1_DEFAULT_MODEL_INFO.description,
      },
    ],
    currentModelId: DEGRAU1_DEFAULT_MODEL_INFO.value,
  };
}

/** Compute a stable fingerprint of the session-defining params so we can
 *  detect when a loadSession/resumeSession call requires tearing down and
 *  recreating the underlying Query process.  MCP servers are sorted by name
 *  so that ordering differences don't trigger unnecessary recreations. */
function computeSessionFingerprint(params: {
  cwd: string;
  mcpServers?: NewSessionRequest["mcpServers"];
}): string {
  const servers = [...(params.mcpServers ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  return JSON.stringify({ cwd: params.cwd, mcpServers: servers });
}

type BackgroundTerminal =
  | {
      handle: TerminalHandle;
      status: "started";
      lastOutput: TerminalOutputResponse | null;
    }
  | {
      status: "aborted" | "exited" | "killed" | "timedOut";
      pendingOutput: TerminalOutputResponse;
    };

export type SDKMessageFilter = {
  type: string;
  subtype?: string;
  origin?: SDKMessageOrigin["kind"];
};

/**
 * Extra metadata that can be given when creating a new session.
 */
export type NewSessionMeta = {
  claudeCode?: {
    /**
     * Options forwarded to Claude Code when starting a new session.
     * Those parameters will be ignored and managed by ACP:
     *   - cwd
     *   - includePartialMessages
     *   - allowDangerouslySkipPermissions
     *   - permissionMode
     *   - canUseTool
     *   - executable
     * Those parameters will be used and updated to work with ACP:
     *   - hooks (merged with ACP's hooks)
     *   - mcpServers (merged with ACP's mcpServers)
     *   - disallowedTools (merged with ACP's disallowedTools)
     *   - tools (passed through; defaults to claude_code preset if not provided)
     */
    options?: Options;
    /**
     * When set, raw SDK messages are emitted as extNotification("_claude/sdkMessage", message)
     * in addition to normal processing.
     * - true: emit all messages
     * - false/undefined: emit nothing (default)
     * - SDKMessageFilter[]: emit only messages matching at least one filter
     */
    emitRawSDKMessages?: boolean | SDKMessageFilter[];
  };
  additionalRoots?: string[];
};

/**
 * Extra metadata for 'gateway' authentication requests.
 */
type GatewayAuthMeta = {
  /**
   * These parameters are mapped to environment variables to:
   * - Redirect API calls via baseUrl
   * - Inject custom headers
   * - Bypass the default Claude login requirement
   */
  gateway: {
    baseUrl: string;
    headers: Record<string, string>;
  };
};

type GatewayAuthRequest = AuthenticateRequest & { _meta?: GatewayAuthMeta };

/**
 * Extra metadata that the agent provides for each tool_call / tool_update update.
 */
export type ToolUpdateMeta = {
  claudeCode?: {
    /* The name of the tool that was used in Claude Code. */
    toolName: string;
    /* The structured output provided by Claude Code. */
    toolResponse?: unknown;
  };
  /* Terminal metadata for Bash tool execution, matching codex-acp's _meta protocol. */
  terminal_info?: {
    terminal_id: string;
  };
  terminal_output?: {
    terminal_id: string;
    data: string;
  };
  terminal_exit?: {
    terminal_id: string;
    exit_code: number;
    signal: string | null;
  };
};

export type ToolUseCache = {
  [key: string]: {
    type: "tool_use" | "server_tool_use" | "mcp_tool_use";
    id: string;
    name: string;
    input: unknown;
  };
};

// === SEAM(012/023): the engine binary is resolved from the user's PATH. After the 023 rewrite,
// createSession no longer passes the SDK `pathToClaudeCodeExecutable`; the PTY engine (story 013)
// spawns the subscription `claude` through the login shell (`bash -lc 'claude …'`), so it resolves
// from PATH — the same E1 keystone (experiments/DEGRAU0-RESULTS.md), via the shell rather than an
// explicit resolveClaudePath() call here. resolveClaudePath() (story 012) is retained for the
// `--cli` auth spawn in index.ts. See fork/src/claude-path.ts, fork/SEAM-MAP.md, IMPLEMENTACAO §3/§5. ===

function shouldHideClaudeAuth(): boolean {
  return process.argv.includes("--hide-claude-auth");
}

// Bypass Permissions doesn't work if we are a root/sudo user
const IS_ROOT = (process.geteuid?.() ?? process.getuid?.()) === 0;
const ALLOW_BYPASS = !IS_ROOT || !!process.env.IS_SANDBOX;

// Slash commands that the SDK handles locally without replaying the user
// message and without invoking the model.

// The Claude SDK persists local slash command invocations (e.g. `/model`) and
// their output as user messages in the session transcript, wrapping the
// payload in these XML-like markers that the CLI uses for its own display.
// The live prompt loop drops them; replay must strip them too or they leak
// into the UI on session/load.
const LOCAL_COMMAND_TAG_PATTERN =
  /<(command-name|command-message|command-args|local-command-stdout|local-command-stderr)>[\s\S]*?<\/\1>/g;

function stripMarkerTags(text: string): string {
  return text.replace(LOCAL_COMMAND_TAG_PATTERN, "");
}

/**
 * Return user-message content with local-command marker tags removed, or
 * `null` if nothing meaningful remains (caller should skip the message).
 * Preserves real prose that's mixed in alongside the markers — e.g. a
 * message like `<command-name>…</command-name>hi` becomes `hi`.
 */
export function stripLocalCommandMetadata(content: unknown): unknown | null {
  if (typeof content === "string") {
    const stripped = stripMarkerTags(content);
    return stripped.trim() === "" ? null : stripped;
  }
  if (!Array.isArray(content)) return content;

  const kept: unknown[] = [];
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      "type" in block &&
      (block as { type: unknown }).type === "text" &&
      "text" in block &&
      typeof (block as { text: unknown }).text === "string"
    ) {
      const stripped = stripMarkerTags((block as { text: string }).text);
      if (stripped.trim() === "") continue;
      kept.push({ ...(block as object), text: stripped });
    } else {
      kept.push(block);
    }
  }
  if (kept.length === 0) return null;
  return kept;
}

export function isLocalCommandMetadata(content: unknown): boolean {
  return stripLocalCommandMetadata(content) === null;
}

const PERMISSION_MODE_ALIASES: Record<string, PermissionMode> = {
  auto: "auto",
  default: "default",
  acceptedits: "acceptEdits",
  dontask: "dontAsk",
  plan: "plan",
  bypasspermissions: "bypassPermissions",
  bypass: "bypassPermissions",
};

export function resolvePermissionMode(
  defaultMode?: unknown,
  logger: Logger = console,
): PermissionMode {
  if (defaultMode === undefined) {
    return "default";
  }

  if (typeof defaultMode !== "string") {
    logger.error("Ignoring permissions.defaultMode from settings: expected a string.");
    return "default";
  }

  const normalized = defaultMode.trim().toLowerCase();
  if (normalized === "") {
    logger.error("Ignoring permissions.defaultMode from settings: expected a non-empty string.");
    return "default";
  }

  const mapped = PERMISSION_MODE_ALIASES[normalized];
  if (!mapped) {
    logger.error(`Ignoring permissions.defaultMode from settings: unknown value '${defaultMode}'.`);
    return "default";
  }

  if (mapped === "bypassPermissions" && !ALLOW_BYPASS) {
    logger.error(
      "Ignoring permissions.defaultMode from settings: bypassPermissions is not available when running as root.",
    );
    return "default";
  }

  return mapped;
}

/**
 * Builds the label for the "Always Allow" permission option so the user can see
 * the exact scope they are committing to. Uses the SDK-provided suggestions
 * when available (e.g. `Bash(npm test:*)`) and falls back to naming the whole
 * tool so "Always Allow" is never a blank check without disclosure.
 */
export function describeAlwaysAllow(
  suggestions: PermissionUpdate[] | undefined,
  toolName: string,
): string {
  if (!suggestions || suggestions.length === 0) {
    return `Always Allow all ${toolName}`;
  }

  const ruleLabels: string[] = [];
  const directories: string[] = [];

  for (const update of suggestions) {
    if (update.type === "addRules" && update.behavior === "allow") {
      for (const rule of update.rules) {
        ruleLabels.push(
          rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : `all ${rule.toolName}`,
        );
      }
    } else if (update.type === "addDirectories") {
      directories.push(...update.directories);
    }
  }

  const parts: string[] = [];
  if (ruleLabels.length > 0) {
    parts.push(ruleLabels.join(", "));
  }
  if (directories.length > 0) {
    parts.push(`access to ${directories.join(", ")}`);
  }

  if (parts.length === 0) {
    return `Always Allow all ${toolName}`;
  }

  return `Always Allow ${parts.join(" and ")}`;
}

// Implement the ACP Agent interface
/**
 * Story 034 (§9): register every assistant `tool_use` block id from one RAW JSONL message into the
 * session gate's correlation map ({@link SessionGate.correlator}). Defensive walk over the reduced
 * getSessionMessages shape — non-assistant rows, absent content, and id-less blocks are skipped.
 * Double-registration of the SAME id (the message re-appearing in a later raw row) marks it
 * duplicate, which the story-033 correlator then fails closed on — exactly the §9 id-reuse posture.
 */
function registerGateToolUses(raw: unknown, gate: SessionGate): void {
  const msg = raw as { type?: unknown; message?: { content?: unknown } };
  if (msg === null || typeof msg !== "object" || msg.type !== "assistant") return;
  const content = msg.message?.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (
      block !== null &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "tool_use" &&
      typeof (block as { id?: unknown }).id === "string" &&
      (block as { id: string }).id.length > 0
    ) {
      gate.correlator.register((block as { id: string }).id);
    }
  }
}

export class ClaudeAcpAgent implements Agent {
  sessions: {
    [key: string]: Session;
  };
  client: AgentSideConnection;
  toolUseCache: ToolUseCache;
  backgroundTerminals: { [key: string]: BackgroundTerminal } = {};
  clientCapabilities?: ClientCapabilities;
  logger: Logger;
  gatewayAuthRequest?: GatewayAuthRequest;
  // === SEAM(011): the injected engine — a no-op stub by default (READ-ONLY Degrau 1);
  // the PTY + JSONL-tail engine replaces the default in 013–015/023. `initialize`
  // does NOT touch this field (story 011 Task 1.2). See fork/SEAM-MAP.md. ===
  engine: Engine;
  // === SEAM(023) Group 1: the createSession PTY-engine start seam. Defaults to the production
  // wiring (defaultStartEngine: PTY spawn + JSONL watcher + transcript discovery); tests inject a
  // fake so createSession never spawns the real `claude` binary or touches ~/.claude. ===
  private readonly startEngine: StartEngine;
  /** Override for the live JSONL reader the pump re-reads (default: SDK getSessionMessages). */
  private readonly getMessages?: GetMessages;
  /** Story 041 — the sidechain readers the pump sources nested sub-agent rows from; default to the
   *  SDK's pure `listSubagents` / `getSubagentMessages` (tests inject stubs). */
  private readonly listSubagents: ListSubagents;
  private readonly getSubagentMessages: GetSubagentMessages;
  /** Story 025 (R3.1) — UNSTABLE usage_update feature flag; defaults OFF. */
  private readonly usageUpdate: boolean;
  /** Story 044 (R4.1/R4.2) — live sub-agent watcher flag; see {@link AgentDeps.liveSubagentWatch}. */
  private readonly liveSubagentWatch: boolean;
  /**
   * Story 030 (R1.2, R5.1) — the single timer seam shared by `sendPrompt` (the §8 write→\r delay)
   * and `createTurnResolver` (Δt + watchdog), so one injected fake clock drives both in unit tests.
   */
  private readonly schedule: DetectorSchedule;
  /** Story 031 (R1.2) — cancel-ladder escalation window (ms); see {@link AgentDeps.cancelEscalationMs}. */
  private readonly cancelEscalationMs: number;
  /** Story 034 (§9) — hybrid permission-gate wiring flag; see {@link AgentDeps.gate}. */
  private readonly gateEnabled: boolean;
  /** Story 034 — gate tuning knobs forwarded to setupSessionGate; see {@link AgentDeps.gateOptions}. */
  private readonly gateOptions?: Omit<SessionGateOptions, "client" | "onWarn">;
  /** Live PTY-engine registry shared with the per-session engines (story 014 cleanup map). */
  private readonly engines: Map<string, SessionEngine> = new Map();

  constructor(
    client: AgentSideConnection,
    logger?: Logger,
    engine: Engine = createStubEngine(),
    deps: AgentDeps = {},
  ) {
    this.sessions = {};
    this.client = client;
    this.toolUseCache = {};
    this.logger = logger ?? console;
    this.engine = engine;
    this.startEngine = deps.startEngine ?? defaultStartEngine;
    // Story 043 (R2.1): when liveDiff is ON, the live JSONL reader is the diff-enriched reader
    // (getSessionMessages + uuid→toolUseResult hydration), which restores the story-021 Edit/Write
    // diff on BOTH the live pump and the session/load replay (both read this.getMessages once). The
    // constructor default stays reduced (deps.liveDiff ?? false) for test determinism — the entrypoint
    // (index.ts) is what defaults it ON. OFF → byte-for-byte the pre-043 reduced reader (R5.1).
    this.getMessages = (deps.liveDiff ?? false)
      ? createDiffEnrichedReader(deps.getMessages ?? defaultGetMessages, deps.diffEnrichOptions)
      : deps.getMessages;
    this.listSubagents = deps.listSubagents ?? defaultListSubagents;
    this.getSubagentMessages = deps.getSubagentMessages ?? defaultGetSubagentMessages;
    this.usageUpdate = deps.usageUpdate ?? false;
    // Story 044 (R4.1): live sub-agent watcher — bootstrap-resolved (index.ts: ON unless
    // FORK_LIVE_SUBAGENT_WATCH=0/false); OFF at this seam so directly-constructed test agents arm
    // no 2nd watcher unless they opt in (R4.2: OFF → byte-for-byte today's pull-only path).
    this.liveSubagentWatch = deps.liveSubagentWatch ?? false;
    this.schedule =
      deps.schedule ??
      ((fn, ms) => {
        const id = setTimeout(fn, ms);
        return () => clearTimeout(id);
      });
    // Story 031 (R1.2): conservative default escalation window; tests inject their own via deps.
    this.cancelEscalationMs = deps.cancelEscalationMs ?? 1000;
    // Story 034 (§9): hybrid gate wiring — bootstrap-resolved (index.ts: ON unless FORK_GATE=off);
    // OFF at this seam so directly-constructed test agents spin no gate unless they opt in.
    this.gateEnabled = deps.gate ?? false;
    this.gateOptions = deps.gateOptions;
  }

  async initialize(request: InitializeRequest): Promise<InitializeResponse> {
    this.clientCapabilities = request.clientCapabilities;

    // Bypasses standard auth by routing requests through a custom Anthropic-protocol gateway.
    // Only offered when the client advertises `auth._meta.gateway` capability.
    const supportsGatewayAuth = request.clientCapabilities?.auth?._meta?.gateway === true;

    const gatewayAuthMethod: AuthMethod = {
      id: "gateway",
      name: "Custom model gateway",
      description: "Use a custom gateway to authenticate and access models",
      _meta: {
        gateway: {
          protocol: "anthropic",
        },
      },
    };

    const gatewayBedrockAuthMethod: AuthMethod = {
      id: "gateway-bedrock",
      name: "Custom model gateway",
      description: "Use a custom gateway to authenticate and access models",
      _meta: {
        gateway: {
          protocol: "bedrock",
        },
      },
    };

    const supportsTerminalAuth = request.clientCapabilities?.auth?.terminal === true;
    const supportsMetaTerminalAuth = request.clientCapabilities?._meta?.["terminal-auth"] === true;

    // Detect remote environments where the OAuth browser redirect to localhost
    // won't work. This matches the SDK's internal isRemote check. In these cases,
    // the `auth login` subcommand would fall back to a device-code-like manual
    // flow, which doesn't work well over ACP, so we offer the TUI login instead.
    const isRemote = !!(
      process.env.NO_BROWSER ||
      process.env.SSH_CONNECTION ||
      process.env.SSH_CLIENT ||
      process.env.SSH_TTY ||
      process.env.CLAUDE_CODE_REMOTE
    );
    const terminalAuthMethods: AuthMethod[] = [];

    if (isRemote) {
      const remoteLoginMethod: AuthMethod = {
        description: "Run `claude /login` in the terminal",
        name: "Log in with Claude",
        id: "claude-login",
        type: "terminal",
        args: ["--cli"],
      };

      if (supportsMetaTerminalAuth) {
        remoteLoginMethod._meta = {
          "terminal-auth": {
            command: process.execPath,
            args: [...process.argv.slice(1), "--cli"],
            label: "Claude Login",
          },
        };
      }

      if (!shouldHideClaudeAuth() && (supportsTerminalAuth || supportsMetaTerminalAuth)) {
        terminalAuthMethods.push(remoteLoginMethod);
      }
    } else {
      const claudeLoginMethod: AuthMethod = {
        description: "Use Claude subscription ",
        name: "Claude Subscription",
        id: "claude-ai-login",
        type: "terminal",
        args: ["--cli", "auth", "login", "--claudeai"],
      };

      const consoleLoginMethod: AuthMethod = {
        description: "Use Anthropic Console (API usage billing)",
        name: "Anthropic Console",
        id: "console-login",
        type: "terminal",
        args: ["--cli", "auth", "login", "--console"],
      };

      if (supportsMetaTerminalAuth) {
        const baseArgs = process.argv.slice(1);
        claudeLoginMethod._meta = {
          "terminal-auth": {
            command: process.execPath,
            args: [...baseArgs, "--cli", "auth", "login", "--claudeai"],
            label: "Claude Login",
          },
        };
        consoleLoginMethod._meta = {
          "terminal-auth": {
            command: process.execPath,
            args: [...baseArgs, "--cli", "auth", "login", "--console"],
            label: "Anthropic Console Login",
          },
        };
      }

      if (!shouldHideClaudeAuth() && (supportsTerminalAuth || supportsMetaTerminalAuth)) {
        terminalAuthMethods.push(claudeLoginMethod);
      }
      if (supportsTerminalAuth || supportsMetaTerminalAuth) {
        terminalAuthMethods.push(consoleLoginMethod);
      }
    }

    return {
      protocolVersion: 1,
      agentCapabilities: {
        _meta: {
          claudeCode: {
            promptQueueing: true,
          },
        },
        promptCapabilities: {
          image: true,
          embeddedContext: true,
        },
        mcpCapabilities: {
          http: true,
          sse: true,
        },
        loadSession: true,
        sessionCapabilities: {
          additionalDirectories: {},
          close: {},
          delete: {},
          fork: {},
          list: {},
          resume: {},
        },
      },
      agentInfo: {
        name: packageJson.name,
        title: "Claude Agent TUI",
        version: packageJson.version,
      },
      authMethods: [
        ...terminalAuthMethods,
        ...(supportsGatewayAuth ? [gatewayAuthMethod, gatewayBedrockAuthMethod] : []),
      ],
    };
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const response = await this.createSession(params, {
      // Revisit these meta values once we support resume
      resume: (params._meta as NewSessionMeta | undefined)?.claudeCode?.options?.resume,
    });
    // Needs to happen after we return the session
    setTimeout(() => {
      this.sendAvailableCommandsUpdate(response.sessionId);
    }, 0);
    return response;
  }

  async unstable_forkSession(params: ForkSessionRequest): Promise<ForkSessionResponse> {
    const response = await this.createSession(
      {
        cwd: params.cwd,
        mcpServers: params.mcpServers ?? [],
        additionalDirectories: params.additionalDirectories,
        _meta: params._meta,
      },
      {
        resume: params.sessionId,
        forkSession: true,
      },
    );
    // Needs to happen after we return the session
    setTimeout(() => {
      this.sendAvailableCommandsUpdate(response.sessionId);
    }, 0);
    return response;
  }

  async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    const result = await this.getOrCreateSession(params);

    // Needs to happen after we return the session
    setTimeout(() => {
      this.sendAvailableCommandsUpdate(params.sessionId);
    }, 0);
    return result;
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    // Degrau-1 read-only: replay-only — locate the transcript and replay it, but do NOT spawn a live
    // `claude --resume` (story 027 live regression: a live resume re-emits the history through the
    // tail pump → double render, and writes a wrong-cwd duplicate transcript → ambiguous glob).
    const result = await this.getOrCreateSession(params, { replayOnly: true });

    await this.replaySessionHistory(params.sessionId);

    // Send available commands after replay so it doesn't interleave with history
    setTimeout(() => {
      this.sendAvailableCommandsUpdate(params.sessionId);
    }, 0);

    return result;
  }

  async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    const sdk_sessions = await listSessions({ dir: params.cwd ?? undefined });
    const sessions = [];

    for (const session of sdk_sessions) {
      if (!session.cwd) continue;
      sessions.push({
        sessionId: session.sessionId,
        cwd: session.cwd,
        title: sanitizeTitle(session.summary),
        updatedAt: new Date(session.lastModified).toISOString(),
      });
    }
    return {
      sessions,
    };
  }

  async authenticate(_params: AuthenticateRequest): Promise<void> {
    if (_params.methodId === "gateway" || _params.methodId === "gateway-bedrock") {
      this.gatewayAuthRequest = _params as GatewayAuthRequest;
      return;
    }
    throw new Error("Method not implemented.");
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const sessionRecord = this.sessions[params.sessionId];
    if (!sessionRecord) {
      throw new Error("Session not found");
    }
    // Story 034 (R2.3 fix): a prompt into a dead engine must fail FAST and legibly. sendPrompt is
    // post-exit-safe (story 014), so without this guard the write would silently no-op and the turn
    // would hang until the stall watchdog — exactly the orphaned-prompt failure the G2 live run hit.
    if (sessionRecord.engine?.isDisposed) {
      throw new Error(
        `session engine disposed — the claude PTY for session ${params.sessionId} has exited; ` +
          "reload or recreate the session to continue",
      );
    }

    // === SEAM(030) — Degrau-2 ACP-side input (R1, R1.2, R5, R5.1, R5.2). The Degrau-1 read-only
    // no-op is replaced by the real prompt loop: assemble the §8 PTY payload, submit it, and resolve
    // the pending `session/prompt` SOLELY through the story-024 end-of-turn detector — never by this
    // writer guessing completion (R5.1). The §10 entrypoint=='cli' billing guard-rail in pumpUpdates
    // stays untouched: enabling input does not weaken it.
    //
    // Everything from `promptToClaude` through `sendPrompt` and `turnDetector = detector` runs
    // SYNCHRONOUSLY before the `await promise`, so the PTY write is committed (and the detector is
    // reachable by the live pump and the cancel path) the instant the turn begins.

    // (1) Assemble the PTY text payload from the ContentBlock[] (Task 1 rewrote this to return text).
    const payload = promptToClaude(params, this.logger);

    // (2) Register the turn with the story-024 resolver: the detector that the live pump feeds, and
    // the awaitable that settles ONCE with { stopReason: mapStopReason(...) } on the terminal
    // boundary (or rejects on the watchdog). One shared `schedule` drives sendPrompt + the resolver.
    const { detector, promise, cancel } = createTurnResolver({
      schedule: this.schedule,
      sessionId: params.sessionId,
      logger: this.logger,
    });
    sessionRecord.turnDetector = detector;
    sessionRecord.turnCancel = cancel;
    detector.beginTurn();

    // (3) Submit with the §8 convention (single-line: write→delayed \r; multi-line: bracketed-paste).
    // On a PTY-write failure, reject the pending prompt via the throw — markCancelled clears the
    // detector's Δt + watchdog timers so nothing is left hung — rather than swallowing the error.
    try {
      sendPrompt(sessionRecord.pty, payload, this.schedule);
    } catch (e) {
      detector.markCancelled();
      sessionRecord.turnDetector = undefined;
      sessionRecord.turnCancel = undefined;
      throw e;
    }

    // (4) Resolve ONLY via the detector's terminal boundary. The pump feeds raw JSONL messages to
    // `sessionRecord.turnDetector`; this method emits NO `client.sessionUpdate` (the pump owns that).
    try {
      return await promise;
    } finally {
      sessionRecord.turnDetector = undefined;
      sessionRecord.turnCancel = undefined;
      // Story 044 (R2.3): the turn is over — resolved OR cancelled, both settle this same promise —
      // so the in-turn sub-agent watcher dies with it (covers turn-resolve AND markCancelled paths).
      sessionRecord.subagentWatcher?.stop();
      sessionRecord.subagentWatcher = undefined;
    }
  }

  async cancel(params: CancelNotification): Promise<void> {
    const sessionRecord = this.sessions[params.sessionId];
    if (!sessionRecord) {
      return;
    }
    // === SEAM(023→031): the SDK `query.interrupt()` body is REMOVED. Cancel is re-implemented
    // against the PTY (§3 CORTAR), in two halves: (Task 1) RESOLUTION via the story-024 latch, then
    // (Task 2) the PTY interrupt ESCALATION via the story-014 primitives. ===

    // Task 1 (R2.1, R2.2, R3.1): resolve the in-flight prompt as 'cancelled' via the story-024 latch
    // (the resolver claims the latch + calls markCancelled). No-op when no turn is in flight.
    const hadInFlightTurn = sessionRecord.turnCancel !== undefined;
    sessionRecord.cancelled = true;
    sessionRecord.turnCancel?.();

    // Task 2 (R1.1, R1.2, R1.3) — revised by the story-034 live acceptance (R2.3): best-effort STOP
    // the underlying claude TUI via the story-014 PTY primitives. Only when a turn was actually in
    // flight (R1.3: no-op with no turn) AND the engine is still alive (R1.3: inert after PTY exit).
    // Ctrl+C first; Esc only if the PTY has not exited within a short LOCAL window. The ladder ENDS
    // at Esc: the G2 live run (sessions 22e2672c/6262610a) proved the TUI aborts the turn on Ctrl+C
    // WITHOUT exiting, so `isDisposed` can never read as "yielded" on a live session — the former
    // p.kill() rung therefore killed EVERY live cancelled session and orphaned the next prompt
    // (an R2.3 violation; §8 asked only for \x03). kill() stays a teardown concern, never a cancel
    // rung; a genuinely zombie TUI is surfaced by the next turn's stall watchdog and removed by
    // teardown. Each primitive is itself post-exit-safe (story 014), so the isDisposed guards are
    // belt-and-suspenders against writing to a dead handle.
    if (!hadInFlightTurn) {
      return;
    }
    const engine = sessionRecord.engine;
    if (!engine || engine.isDisposed) {
      return;
    }
    engine.interrupt(); // \x03 (Ctrl+C), synchronously, before any escalation
    this.schedule(() => {
      if (engine.isDisposed) return; // PTY exited meanwhile → nothing left to escalate to
      engine.escape(); // \x1b (Esc) — a no-op on an idle TUI; the ladder ends here
    }, this.cancelEscalationMs);
  }

  /** Cleanly tear down a session: cancel in-flight work, dispose resources,
   *  and remove it from the session map. */
  private async teardownSession(sessionId: string): Promise<void> {
    const session = this.sessions[sessionId];
    if (!session) {
      return;
    }
    await this.cancel({ sessionId });
    // Story 044 (R2.3): stop the sub-agent watcher on teardown — idempotent with the prompt-finally stop.
    session.subagentWatcher?.stop();
    session.subagentWatcher = undefined;
    session.settingsManager.dispose();
    // === SEAM(023) Group 1: tear down via the engine handle (cleanup/kill), never the SDK Query
    // (story 014) idempotently kills the PTY and stops the JSONL watcher; if no engine handle is
    // present (e.g. an injected fake), fall back to stopping the watcher directly. ===
    if (session.engine) {
      session.engine.cleanup();
      session.engine.kill();
    } else {
      // `watcher` is now OPTIONAL (story 028, sub-task 2.1): a fresh session may be torn down before
      // its transcript appeared, so no watcher was ever armed — null-guard the no-engine fallback.
      // (The 3.1 task text attributes this guard to 3.1; the type-widening in 2.1 forces it here so
      // the build stays green. 3.1 adds the cleanup→discovery-abort logic and its own tests.)
      session.watcher?.stop();
    }
    // Story 034 (§9): dispose the per-session permission gate AFTER the PTY is gone (no live claude
    // can fire a hook into the closing server): close the hook server (bounded — never hangs on an
    // in-flight decider) and restore/delete the scratch settings. Idempotent with the PTY onExit
    // teardown hook, so a crashed-TUI session that already tore the gate down is a no-op here.
    if (session.gate) {
      await session.gate.teardown();
    }
    this.engines.delete(sessionId);
    delete this.sessions[sessionId];
  }

  /** Tear down all active sessions. Called when the ACP connection closes. */
  async dispose(): Promise<void> {
    await Promise.all(Object.keys(this.sessions).map((id) => this.teardownSession(id)));
  }

  async closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
    if (!this.sessions[params.sessionId]) {
      throw new Error("Session not found");
    }
    await this.teardownSession(params.sessionId);
    return {};
  }

  async unstable_deleteSession(params: DeleteSessionRequest): Promise<DeleteSessionResponse> {
    // Tear down any active in-memory state first so the on-disk file isn't
    // recreated by an outstanding query writing to it.
    if (this.sessions[params.sessionId]) {
      await this.teardownSession(params.sessionId);
    }
    await deleteSession(params.sessionId);
    return {};
  }

  async unstable_setSessionModel(
    params: SetSessionModelRequest,
  ): Promise<SetSessionModelResponse | void> {
    const session = this.sessions[params.sessionId];
    if (!session) {
      throw new Error("Session not found");
    }
    // Resolve aliases (e.g. "opus", "opus[1m]") to canonical model IDs so
    // downstream lookups in modelInfos succeed and the effort option isn't
    // silently dropped.
    const resolved = resolveModelPreference(session.modelInfos, params.modelId);
    const modelId = resolved?.value ?? params.modelId;
    // === SEAM(023) Group 1: read-only Degrau-1 shim — update local model state + emit the ACP
    // config_option_update notification only. No SDK `query.setModel`. The interactive TUI owns
    // real model selection in Degrau-1.
    // Degrau 2 (030/032): PTY-backed control — drive the TUI to switch models. ===
    await this.updateConfigOption(params.sessionId, "model", modelId);
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    if (!this.sessions[params.sessionId]) {
      throw new Error("Session not found");
    }

    await this.applySessionMode(params.sessionId, params.modeId);
    await this.updateConfigOption(params.sessionId, "mode", params.modeId);
    return {};
  }

  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    const session = this.sessions[params.sessionId];
    if (!session) {
      throw new Error("Session not found");
    }
    if (typeof params.value !== "string") {
      throw new Error(`Invalid value for config option ${params.configId}: ${params.value}`);
    }

    const option = session.configOptions.find((o) => o.id === params.configId);
    if (!option) {
      throw new Error(`Unknown config option: ${params.configId}`);
    }

    const allValues =
      "options" in option && Array.isArray(option.options)
        ? option.options.flatMap((o) => ("options" in o ? o.options : [o]))
        : [];
    let validValue = allValues.find((o) => o.value === params.value);

    // For model options, fall back to resolveModelPreference when the exact
    // value doesn't match.  This lets callers use human-friendly aliases like
    // "opus" or "sonnet" instead of full model IDs like "claude-opus-4-6".
    if (!validValue && params.configId === "model") {
      const modelInfos: ModelInfo[] = allValues.map((o) => ({
        value: o.value,
        displayName: o.name,
        description: o.description ?? "",
      }));
      const resolved = resolveModelPreference(modelInfos, params.value);
      if (resolved) {
        validValue = allValues.find((o) => o.value === resolved.value);
      }
    }

    if (!validValue) {
      throw new Error(`Invalid value for config option ${params.configId}: ${params.value}`);
    }

    // Use the canonical option value so downstream code always receives the
    // model ID rather than the caller-supplied alias.
    const resolvedValue = validValue.value;

    if (params.configId === "mode") {
      await this.applySessionMode(params.sessionId, resolvedValue);
      await this.client.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "current_mode_update",
          currentModeId: resolvedValue,
        },
      });
    }
    // === SEAM(023) Group 1: the `model` branch's SDK `query.setModel` is dropped — local config
    // state is updated by applyConfigOptionValue below (read-only Degrau-1 shim).
    // Degrau 2 (030/032): PTY-backed control. ===

    await this.applyConfigOptionValue(params.sessionId, session, params.configId, resolvedValue);

    return { configOptions: session.configOptions };
  }

  private async applySessionMode(sessionId: string, modeId: string): Promise<void> {
    switch (modeId) {
      case "auto":
      case "default":
      case "acceptEdits":
      case "bypassPermissions":
      case "dontAsk":
      case "plan":
        break;
      default:
        throw new Error("Invalid Mode");
    }

    const session = this.sessions[sessionId];
    if (!session) {
      throw new Error("Session not found");
    }
    if (!session.modes.availableModes.some((mode) => mode.id === modeId)) {
      throw new Error(`Mode ${modeId} is not available in this session`);
    }

    // === SEAM(023) Group 1: read-only Degrau-1 shim — validate the mode against local availableModes
    // above; the local currentModeId is updated by applyConfigOptionValue and the notification is
    // emitted by the caller. No SDK `query.setPermissionMode`.
    // Degrau 2 (030/032): PTY-backed control — drive the TUI to apply the permission mode. ===
  }

  private async replaySessionHistory(sessionId: string): Promise<void> {
    const session = this.sessions[sessionId];
    if (!session) return; // load was torn down before replay (defensive; loadSession just created it)
    // Read via the SAME seam + ordering the live tail pump uses (readOrderedMessages → getSessionMessages,
    // then linearizeTurns), so a LOADED thread orders identically to a LIVE one (story 026 R4.1/R4.2) and
    // an R1.3 SDK-drift error is surfaced loudly rather than swallowed.
    const messages = await readOrderedMessages(sessionId, session.cwd, {
      getMessages: this.getMessages,
    });

    // Emit through the SHARED source+merge+linearize+emit loop the live pump runs — top-level turns
    // (toAcpNotifications + structuredPatch diff + optional usage_update) AND the nested sub-agent rows
    // (story 041) on their spawning Task id. Factoring this single loop is what GUARANTEES loaded == live
    // with no replay-only divergence (R3.2): the replay path cannot drift from the pump because it IS the
    // pump's loop (the same lesson as the story-026 diff and story-038 usage moves into the shared emit).
    //
    // The story-027 anti-double-emit seeding is INHERENT to that loop: it adds each emitted top-level
    // turn's uuid to `session.emitted` and each emitted nested row's uuid to `session.emittedNested`, so a
    // tail pump armed by a resumed/loaded session re-reads the SAME transcript and emits NOTHING new (the
    // gates already hold every replayed uuid). We therefore do NOT pre-seed `emitted` before the loop —
    // doing so would make the loop's own `emitted` gate SUPPRESS replay's main-turn rendering.
    await this.emitLinearizedWithNested(sessionId, session, messages);
  }

  /**
   * Shared per-turn ACP emission used by BOTH the `session/load` replay ({@link replaySessionHistory})
   * and the live tail pump ({@link pumpUpdates}). Emits the message's `toAcpNotifications` updates with
   * `registerHooks:false`; when the turn carries a `toolUseResult`, the story-021 structuredPatch diff
   * (`{type:'diff'}`) attached to the open tool call; and finally the optional, default-OFF UNSTABLE
   * `usage_update` (story 025) with its R8 per-session reject latch. Factoring all three here is what
   * guarantees a LOADED thread renders byte-for-byte like a LIVE one (story 026 R3.3/R4.2): the
   * validate-026 gap was the diff-emission block living only in pumpUpdates, so a replay-only load (no
   * live pump) rendered Edit/Write WITHOUT a diff; story 038 moved usage_update HERE for the SAME
   * reason (loaded==live for usage). Only dedup and the billing guard-rail stay with the callers.
   */
  private async emitTurnUpdates(
    sessionId: string,
    turn: { message: unknown },
    toolUseCache: ToolUseCache,
  ): Promise<void> {
    const session = this.sessions[sessionId];
    const source = turn.message as { message?: { role?: string; content?: unknown } };
    const role = source.message?.role;
    let content: unknown = source.message?.content;
    if (role === "user") {
      content = stripLocalCommandMetadata(content);
      // Pure command-metadata payloads strip to null — nothing to render.
      if (content === null) return;
    }

    for (const notification of toAcpNotifications(
      // @ts-expect-error - message.content/role are untyped in the reduced SDK shape
      content,
      role,
      sessionId,
      toolUseCache,
      this.client,
      this.logger,
      {
        registerHooks: false,
        clientCapabilities: this.clientCapabilities,
        cwd: session?.cwd,
        taskState: session?.taskState,
      },
    )) {
      await this.client.sessionUpdate(notification);
    }

    // Edit/Write diffs (story 021/026): the SDK PostToolUse hook that produced diffs is GONE in the PTY
    // path, so source the diff DIRECTLY from the JSONL `toolUseResult` (structuredPatch + originalFile /
    // content) and emit a `tool_call_update` attached to the already-open tool call (story 019 seam).
    // No-op when the message carries no `toolUseResult` (e.g. the getSessionMessages reduced shape — see
    // the getsessionmessages-reduced-shape follow-up) or the tool is not a renderable Edit/Write. The
    // tool NAME is recovered from the per-pass/per-session toolUseCache.
    const toolUseResult = (turn.message as { toolUseResult?: unknown }).toolUseResult;
    if (toolUseResult !== undefined && Array.isArray(content)) {
      for (const block of content) {
        if (
          block !== null &&
          typeof block === "object" &&
          (block as { type?: unknown }).type === "tool_result" &&
          typeof (block as { tool_use_id?: unknown }).tool_use_id === "string"
        ) {
          const toolCallId = (block as { tool_use_id: string }).tool_use_id;
          const name = toolUseCache[toolCallId]?.name;
          const diffUpdate = diffToolCallUpdate(classifyDiffSource(name, toolUseResult), toolCallId);
          if (diffUpdate) {
            await this.client.sessionUpdate({
              sessionId,
              update: diffUpdate as unknown as SessionNotification["update"],
            });
          }
        }
      }
    }

    // Story 025 (R3.1/R3.2): optional UNSTABLE usage_update, gated OFF by default. A no-op unless
    // the usageUpdate flag is ON and the message carries usage tokens; `size` comes from the
    // session's context window. The flag stays OFF until the live-Zed acceptance probe (Task 3.3).
    // Story 025 (R3.3, R8): once the client rejects a usage_update, latch it off for the session
    // and never re-throw — the surrounding text/thinking/tool-call stream must keep flowing.
    // Story 038: emitted HERE (after toAcpNotifications + diff) — i.e. trailing the turn's content
    // exactly as the live pump did — so a LOADED thread carries usage_update byte-for-byte like a
    // LIVE one (symmetric to the story-026 diff move; the validate-038 gap was that usage lived only
    // in pumpUpdates, so the replay-only load never emitted it).
    if (session && !session.usageDisabled) {
      const carrier = (turn.message as { message?: unknown }).message ?? {};
      for (const usageUpdate of usageUpdatesFor(carrier as unknown as UsageCarrier, {
        usageUpdate: this.usageUpdate,
        contextWindowSize: session.contextWindowSize,
      })) {
        try {
          await this.client.sessionUpdate({
            sessionId,
            update: usageUpdate as unknown as SessionNotification["update"],
          });
        } catch (err) {
          // R8 detection: an ACP client error on the UNSTABLE notification. Latch off, log once
          // for drift telemetry, and stop — never propagate the rejection into the turn loop.
          session.usageDisabled = true;
          this.logger.error(
            `usage_update rejected by client (R8) — suppressing further usage_update for session ${sessionId}: ${String(err)}`,
          );
          break;
        }
      }
    }
  }

  /**
   * Story 041 (R2.1, R2.2) — build the ACP `tool_call_update`(s) that render ONE nested sub-agent
   * row UNDER its spawning Task tool_call. The nested row's `parent_tool_use_id` is the SPAWNING
   * Task's `tool_use.id`; Zed merges `tool_call_update`s by `tool_call_id` and APPENDS their content
   * (ZED-CLIENT-STUDY §Q2 ev.6: tool calls correlate by id with field-by-field merge, `ContentBlock::append`
   * is pure concatenation), so emitting on the parent id nests the sub-agent's output under the Task.
   *
   * The block→content mapping is NOT re-implemented here: it REUSES the story-018/019/020 translator
   * `toAcpNotifications` (text → agent_message_chunk, thinking → agent_thought_chunk, the sub-agent's
   * own tool_use → tool_call, its tool_result → tool_call_update). We then RE-TARGET that translated
   * output as `ToolCallContent` items on the PARENT id. Consequently the sub-agent's own tool_use /
   * tool_result render as summarized markdown content WITHIN the parent Task tool_call (the tool's
   * title/translated content), NOT as separate top-level `tool_call`s.
   *
   * Returns `[]` (no emission) when `parent_tool_use_id` is missing/null — there is no parent to nest
   * under (a non-sidechain or malformed row). The caller does the dedup / arrival ordering (story 017's
   * uuid-sorted `Turn.nested`); this is a pure builder.
   */
  private nestedUpdatesFor(
    sessionId: string,
    message: SessionMessage,
    toolUseCache: ToolUseCache,
  ): SessionNotification[] {
    const parentId = (message as { parent_tool_use_id?: unknown }).parent_tool_use_id;
    // No spawning Task → nothing to nest under. R2: only sidechain rows (those claimed by a Task
    // tool_use) render nested; a row without a parent id is not one.
    if (typeof parentId !== "string" || parentId.length === 0) return [];

    const session = this.sessions[sessionId];
    const source = (message as { message?: { role?: string; content?: unknown } }).message;
    const role = source?.role === "user" ? "user" : "assistant";
    const content = source?.content;
    // No content blocks to translate (reduced shape may omit them) → nothing to emit.
    if (content === undefined || content === null) return [];

    // REUSE the 018/019/020 translators. `registerHooks:false` — replay/nested emission must not arm
    // live PostToolUse hooks (same contract as emitTurnUpdates). The sub-agent's own tool_use/tool_result
    // pass through their OWN cache so the translator's tool_call→tool_call_update lifecycle is internally
    // consistent; we discard the cache afterwards (it is never the parent's cache — the sub-agent's ids
    // are not surfaced top-level).
    const translated = toAcpNotifications(
      // @ts-expect-error - message.content/role are untyped in the reduced SDK shape
      content,
      role,
      sessionId,
      toolUseCache,
      this.client,
      this.logger,
      {
        registerHooks: false,
        clientCapabilities: this.clientCapabilities,
        cwd: session?.cwd,
        taskState: session?.taskState,
      },
    );

    // Re-target every translated update as `ToolCallContent` on the PARENT id. A `tool_call_update`
    // replaces the content collection (ToolCallUpdate.content semantics), and Zed APPENDS across
    // successive updates by id — so emit one nesting `tool_call_update` per translated update to
    // preserve arrival order without clobbering earlier nested content.
    const out: SessionNotification[] = [];
    for (const notification of translated) {
      const nestedContent = this.toNestedContent(notification.update);
      if (nestedContent.length === 0) continue;
      out.push({
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: parentId,
          content: nestedContent,
          _meta: { claudeCode: { parentToolUseId: parentId } },
        } as unknown as SessionNotification["update"],
      });
    }
    return out;
  }

  /**
   * Story 041 (R2.2) — fold one translated nested update into `ToolCallContent[]` for nesting under
   * the parent Task. Message/thought chunks contribute their ContentBlock directly. The sub-agent's
   * OWN tool_use/tool_result (a `tool_call`/`tool_call_update` from the translator) are SUMMARIZED as
   * markdown content within the parent — never re-emitted as a separate top-level tool_call: we take
   * the tool's human-readable `title` (a bold markdown line) plus any `content` the story-019 translator
   * already produced. `plan` and other non-content updates carry nothing renderable as nested content
   * and are dropped.
   */
  private toNestedContent(update: SessionNotification["update"]): ToolCallContent[] {
    const u = update as {
      sessionUpdate?: string;
      content?: unknown;
      title?: unknown;
    };
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
      case "user_message_chunk":
      case "agent_thought_chunk":
        // `content` here is a single ContentBlock ({type:"text",text} etc.) — wrap it as ToolCallContent.
        return u.content ? [{ type: "content", content: u.content } as ToolCallContent] : [];
      case "tool_call":
      case "tool_call_update": {
        // The sub-agent's own tool — summarize as markdown WITHIN the parent. Bold the tool title
        // (e.g. the Bash command surfaced by toolInfoFromToolUse) and append any translated content
        // (e.g. a tool_use's `prompt`, or a tool_result's rendered output).
        const acc: ToolCallContent[] = [];
        if (typeof u.title === "string" && u.title.length > 0) {
          acc.push({ type: "content", content: { type: "text", text: `**${u.title}**` } } as ToolCallContent);
        }
        if (Array.isArray(u.content)) {
          for (const item of u.content) acc.push(item as ToolCallContent);
        }
        return acc;
      }
      default:
        // plan / current_mode_update / usage_update / … — not renderable as nested content.
        return [];
    }
  }

  /**
   * Tail-driven update pump (story 023 Groups 2-3). Fired on each watcher signal: re-reads the
   * transcript LIVE via getSessionMessages (E5 REUSE-live, billing-free), linearizes via story 017,
   * and emits each not-yet-emitted turn through the reused `toAcpNotifications` (Edit/Write diffs are
   * sourced from `structuredPatch` by tools.ts — story 021). Ordering is the linear order story 017
   * returns (no re-ordering); idempotency across overlapping/prefix re-reads comes from the
   * per-session `emitted` uuid set (R3.3/R3.4). The JSONL tail is the single source of truth — there
   * is NO SDK message stream. The end-of-turn predicate is story 024; this only consumes the signal.
   */
  private async pumpUpdates(sessionId: string): Promise<void> {
    const session = this.sessions[sessionId];
    if (!session) return; // watcher fired before the handle was registered, or after teardown

    const messages = await readOrderedMessages(sessionId, session.cwd, {
      getMessages: this.getMessages,
    });

    // §10 billing guard-rail (story 022, Group 4.1), GOOD-FAITH: on the first batch, assert the
    // observed `entrypoint` is the subscription `cli` class and ABORT the session on a credit/`sdk-*`
    // entrypoint. We only act when the JSONL actually CARRIES an entrypoint — getSessionMessages'
    // reduced shape frequently omits it, and the PRIMARY protection is the spawn-time env-sanitize
    // (story 013). The entrypoint is NEVER rewritten/forced (forging it to 'cli' would be evasion).
    if (!session.guardChecked) {
      session.guardChecked = true;
      const firstBilling = messages.find((m) => {
        const w = m as WatchedMessage;
        return (
          (w.type === "assistant" || w.type === "user") &&
          typeof w.entrypoint === "string" &&
          w.entrypoint.length > 0
        );
      });
      if (firstBilling) {
        let aborted = false;
        guardEvent(firstBilling as WatchedMessage, {
          alert: (m) => this.logger.error(m),
          stopSession: () => {
            aborted = true;
          },
        });
        if (aborted) {
          await this.teardownSession(sessionId);
          return; // billed entrypoint — abort the session, emit nothing
        }
      }
    }

    // === SEAM(030) — feed the in-flight turn detector (R5.1). `readOrderedMessages` returns the FULL
    // monotonic ordered superset on every re-read (engine-watcher.ts), so we slice past a per-session
    // high-water cursor to feed each raw message to the detector exactly once, in order — a prior
    // turn's terminal boundary is never re-observed. The detector reads `message.stop_reason` off raw
    // assistant messages and resolves the pending `session/prompt`. Purely additive: this does NOT
    // change the emit loop below or the §10 guard-rail above.
    const fed = messages.slice(session.detectorCursor ?? 0);
    session.detectorCursor = messages.length;
    if (session.turnDetector) {
      for (const m of fed) session.turnDetector.observe(m as never);
    }

    // === SEAM(034) §9 — feed the gate's tool_use.id correlation map from the SAME exactly-once
    // slice the detector consumes: every newly-observed assistant `tool_use` block registers its id
    // so a PreToolUse hook call can be matched to a REAL transcript tool_use before it is approved
    // (request-permission fails closed on a missing/duplicate id). Registration is additive — it
    // emits nothing and never blocks the pump.
    if (session.gate) {
      for (const m of fed) registerGateToolUses(m, session.gate);
    }

    // === SEAM(041) §sidechain — source + merge + linearize + emit (BOTH main turns and nested
    // sub-agent rows). Factored into the shared {@link emitLinearizedWithNested} so the `session/load`
    // replay path (`replaySessionHistory`) runs the IDENTICAL loop — loaded == live with no replay-only
    // divergence (R3.2; mirrors why the story-026 diff and story-038 usage moved into `emitTurnUpdates`).
    // The merge MUST NOT reach the detector / §10 guard / §9 gate above — those already consumed the
    // un-merged `messages` slice exactly-once (R4.1 structural: sub-agent rows never advance
    // `detectorCursor` nor register as gate tool_uses).
    await this.emitLinearizedWithNested(sessionId, session, messages);

    // === SEAM(044) — Option-B sub-agent watcher: arm/refresh/teardown rides the MAIN-CHAIN spawn
    // signal (`hasSubagentSpawn` + `spawnIdsOpen` over the FULL pumped messages — design key
    // decision 4: NOT the detector's `openTaskIds`, the very inference that failed live in the
    // 041 R4.2 acceptance; scanning the full chain each pump is robust to cursor/slice effects).
    // While armed, the watcher polls the story-041 SDK sidechain readers; its `onActivity` (fired
    // only on a NEW-uuid sub-agent row) feeds BOTH liveness — the in-flight detector's
    // `noteActivity()` (R1.1) — and the incremental render: a re-run of the UNCHANGED idempotent
    // {@link emitLinearizedWithNested}, whose per-row `emittedNested` dedup guarantees at-most-once
    // nested emit (R3.1/R3.2). `this.schedule` is the story-030 single timer seam, so ONE fake
    // clock drives prompt + detector + watcher in tests. Flag OFF → nothing arms: byte-for-byte
    // today's pull-only path (R4.2).
    session.lastMessages = messages;
    if (this.liveSubagentWatch) {
      if (!session.subagentWatcher && hasSubagentSpawn(messages) && spawnIdsOpen(messages)) {
        session.subagentWatcher = createSubagentWatcher({
          sessionId,
          dir: session.cwd,
          mainChain: messages,
          listSubagents: this.listSubagents,
          getSubagentMessages: this.getSubagentMessages,
          schedule: this.schedule,
          onActivity: async () => {
            session.turnDetector?.noteActivity();
            await this.emitLinearizedWithNested(sessionId, session, session.lastMessages ?? messages);
          },
        });
      } else if (session.subagentWatcher) {
        session.subagentWatcher.update(messages);
        if (!spawnIdsOpen(messages)) {
          // R2.2: every spawn id on the chain is CLOSED — the sidechain is finished; stop polling.
          session.subagentWatcher.stop();
          session.subagentWatcher = undefined;
        }
      }
    }
  }

  /**
   * Story 041 (R3.1, R3.2) — the SHARED source+merge+linearize+emit loop run by BOTH the live tail pump
   * ({@link pumpUpdates}) and the `session/load` replay ({@link replaySessionHistory}), so a LOADED
   * thread emits the nested sub-agent rows BYTE-IDENTICALLY to a LIVE one (no replay-only divergence —
   * the validate-026 lesson: any emit path living only in the pump silently diverges on a replay-only
   * load). Steps:
   *
   *   1. `sourceSubagentRows` — GUARDED (R5.2): returns `[]` WITHOUT touching disk when the main chain
   *      carries no `Task`/`Agent` `tool_use`, so the common no-subagent turn pays nothing and
   *      `forLinearize === messages` (identical-to-pre-change behavior).
   *   2. Merge the sidechain rows onto the main chain ONLY for linearization — story 017 groups each
   *      sub-agent row onto its spawning turn's uuid-sorted `Turn.nested`.
   *   3. Per turn: emit the main content behind the UNCHANGED `emitted` gate (a not-yet-emitted
   *      top-level turn renders through `emitTurnUpdates` — toAcpNotifications + structuredPatch diff +
   *      the optional usage_update); then the DECOUPLED nested pass (per-row `emittedNested` dedup, R2.3)
   *      emits each sub-agent row's `tool_call_update`s on the spawning Task's id (R3.1) — this runs EVEN
   *      when the parent uuid is already in `emitted`, so a late-arriving sub-agent row still surfaces.
   *
   * The detector / §10 guard / §9 gate feed is NOT part of this helper — it is pump-only and stays on the
   * un-merged main chain in the caller (sub-agent rows must never advance the detector cursor or register
   * as gate tool_uses). The replay caller has no detector/gate feed, so it simply does not run one.
   */
  private async emitLinearizedWithNested(
    sessionId: string,
    session: Session,
    messages: SessionMessage[],
  ): Promise<void> {
    const subagentRows = await sourceSubagentRows(sessionId, messages, {
      dir: session.cwd,
      listSubagents: this.listSubagents,
      getSubagentMessages: this.getSubagentMessages,
    });
    const forLinearize = subagentRows.length ? messages.concat(subagentRows) : messages;

    for (const turn of linearizeTurns(forLinearize)) {
      // Main content — UNCHANGED `emitted` gate: a not-yet-emitted top-level turn renders through the
      // shared per-turn emission (toAcpNotifications + structuredPatch diff + the optional usage_update),
      // so live and loaded render byte-for-byte the same (story 026 R3.3; story 038 moved usage_update
      // into the shared emit).
      if (!(turn.uuid && session.emitted.has(turn.uuid))) {
        await this.emitTurnUpdates(sessionId, turn, session.toolUseCache);
        if (turn.uuid) session.emitted.add(turn.uuid);
      }

      // Nested sub-agent rows — DECOUPLED dedup (R2.3). This pass runs EVEN when `turn.uuid` is already
      // in `session.emitted`, so a sub-agent row that arrived AFTER its spawning turn was emitted (in an
      // earlier pump) still surfaces. Dedup is per-row via `emittedNested`, independent of the parent
      // gate. Each nested row's `tool_call_update`s (built by the pure `nestedUpdatesFor`, story 041 task
      // 2.1) target the spawning Task's id so the sub-agent renders UNDER the Task (R3.1).
      for (const nested of turn.nested ?? []) {
        const nuid = (nested as { uuid?: string }).uuid;
        if (nuid && session.emittedNested.has(nuid)) continue;
        for (const note of this.nestedUpdatesFor(sessionId, nested, session.toolUseCache))
          await this.client.sessionUpdate(note);
        if (nuid) session.emittedNested.add(nuid);
      }
    }
  }

  async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    const response = await this.client.readTextFile(params);
    return response;
  }

  async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    const response = await this.client.writeTextFile(params);
    return response;
  }

  private async sendAvailableCommandsUpdate(sessionId: string): Promise<void> {
    const session = this.sessions[sessionId];
    if (!session) return;
    // === SEAM(023) Group 1: read-only Degrau-1 shim — emit a static (empty) command set. The SDK
    // `query.supportedCommands()` is dropped; slash commands are owned by the interactive TUI in
    // Degrau-1 and are not enumerable over the read-only JSONL path.
    // Degrau 2 (030/032): PTY-backed control — surface the TUI's real command set. ===
    await this.client.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: [],
      },
    });
  }

  private async updateConfigOption(
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<void> {
    const session = this.sessions[sessionId];
    if (!session) return;

    await this.applyConfigOptionValue(sessionId, session, configId, value);

    await this.client.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "config_option_update",
        configOptions: session.configOptions,
      },
    });
  }

  private async applyConfigOptionValue(
    sessionId: string,
    session: Session,
    configId: string,
    value: string,
  ): Promise<void> {
    if (configId === "mode") {
      session.modes = { ...session.modes, currentModeId: value };
      session.configOptions = session.configOptions.map((o) =>
        o.id === configId && typeof o.currentValue === "string" ? { ...o, currentValue: value } : o,
      );
    } else if (configId === "model") {
      if (session.models.currentModelId !== value) {
        // The cached context window was learned for the previous model; reset
        // to the new model's heuristic so mid-stream updates between now and
        // the next `result` reflect the user's selection instead of the old
        // model's window.
        session.contextWindowSize = inferContextWindowFromModel(value) ?? DEFAULT_CONTEXT_WINDOW;
      }
      session.models = { ...session.models, currentModelId: value };

      // Recompute availableModes for the new model and clamp the current
      // mode if the SDK no longer offers it (today: "auto" on Haiku).
      // `ModelInfo.supportsAutoMode` is the canonical SDK signal.
      const newModelInfo = session.modelInfos.find((m) => m.value === value);
      const newAvailableModes = buildAvailableModes(newModelInfo);
      // Capture BEFORE mutating session.modes so the log message reflects
      // the invalidated mode rather than "default".
      const previousModeId = session.modes.currentModeId;
      let modeDowngraded = false;
      if (!newAvailableModes.some((m) => m.id === previousModeId)) {
        session.modes = {
          availableModes: newAvailableModes,
          currentModeId: "default",
        };
        // === SEAM(023) Group 1: read-only Degrau-1 shim — local-state downgrade only; the SDK
        // `query.setPermissionMode("default")` sync is dropped.
        // Degrau 2 (030/032): PTY-backed control. ===
        modeDowngraded = true;
      } else {
        session.modes = { ...session.modes, availableModes: newAvailableModes };
      }

      // Rebuild config options since effort levels depend on the selected model
      const effortOpt = session.configOptions.find((o) => o.id === "effort");
      const currentEffort =
        typeof effortOpt?.currentValue === "string" ? effortOpt.currentValue : undefined;
      session.configOptions = buildConfigOptions(
        session.modes,
        session.models,
        session.modelInfos,
        currentEffort,
      );

      // === SEAM(023) Group 1: the SDK effort sync (query.applyFlagSettings) after a model switch is
      // dropped — configOptions already reflects the new effort locally.
      // Degrau 2 (030/032): PTY-backed control. ===

      // Emit current_mode_update only after session.modes AND
      // session.configOptions have been fully reconciled. This way, a failure
      // in the configOptions/effort rebuild above can't leave the client with
      // a clamped currentModeId but stale configOptions, and the notification
      // still precedes the caller's config_option_update so order-sensitive
      // clients update currentModeId before re-rendering the option list.
      if (modeDowngraded) {
        await this.client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "current_mode_update",
            currentModeId: "default",
          },
        });
      }
    } else {
      session.configOptions = session.configOptions.map((o) =>
        o.id === configId && typeof o.currentValue === "string" ? { ...o, currentValue: value } : o,
      );
      // === SEAM(023) Group 1: read-only Degrau-1 shim — local config update only; the SDK
      // `query.applyFlagSettings` effort sync is dropped.
      // Degrau 2 (030/032): PTY-backed control. ===
    }
  }

  private async getOrCreateSession(
    params: {
      sessionId: string;
      cwd: string;
      mcpServers?: NewSessionRequest["mcpServers"];
      additionalDirectories?: NewSessionRequest["additionalDirectories"];
      _meta?: NewSessionRequest["_meta"];
    },
    opts: { replayOnly?: boolean } = {},
  ): Promise<NewSessionResponse> {
    const existingSession = this.sessions[params.sessionId];
    if (existingSession) {
      const fingerprint = computeSessionFingerprint(params);
      if (fingerprint === existingSession.sessionFingerprint) {
        return {
          sessionId: params.sessionId,
          modes: existingSession.modes,
          models: existingSession.models,
          configOptions: existingSession.configOptions,
        };
      }

      // Session-defining params changed (e.g. cwd pointed at a git worktree,
      // or MCP servers reconfigured). Tear down the existing session and
      // recreate it so the underlying Query process picks up the new values.
      await this.teardownSession(params.sessionId);
    }

    const response = await this.createSession(
      {
        cwd: params.cwd,
        mcpServers: params.mcpServers ?? [],
        additionalDirectories: params.additionalDirectories,
        _meta: params._meta,
      },
      {
        resume: params.sessionId,
        replayOnly: opts.replayOnly,
      },
    );

    return {
      sessionId: response.sessionId,
      modes: response.modes,
      models: response.models,
      configOptions: response.configOptions,
    };
  }

  // === SEAM(023) Group 1 (REWRITE): createSession — PTY engine + JSONL tail, NOT the SDK query().
  //
  // Spawns the subscription `claude` TUI under a managed PTY (story 013/014), starts the read-only
  // JSONL tail watcher (story 015), locates the transcript by sessionId glob (file-discovery
  // watchdog 2000ms) and reads the runtime cwd from INSIDE the JSONL (never decoding the dir name).
  // Builds models/modes/configOptions from STATIC Degrau-1 defaults (no SDK initializationResult).
  // Registers a per-session handle (pty + watcher + emitted Set + engine) and returns the ACP
  // NewSessionResponse shape. NO SDK `query()`/`getAvailableModels`/`q.*`/SDK-embedded binary path here.
  // The ACP pump that forwards new JSONL messages to the client is Group 2. ====================
  private async createSession(
    params: NewSessionRequest,
    creationOpts: { resume?: string; forkSession?: boolean; replayOnly?: boolean } = {},
  ): Promise<NewSessionResponse> {
    // Allocate the REQUESTED session id (resume/fork branching preserved). For a fresh session this
    // is a freshly-generated v4 id, but the engine's PTY spawn (story 013) generates the
    // AUTHORITATIVE id that correlates to the JSONL transcript basename — that engine-spawn id wins
    // and becomes the session key (see `startedSessionId` below). A resume reattaches to the prior id.
    let requestedSessionId: string;
    const isResume = !!creationOpts.resume && !creationOpts.forkSession;
    if (creationOpts.forkSession) {
      requestedSessionId = randomUUID();
    } else if (creationOpts.resume) {
      requestedSessionId = creationOpts.resume;
    } else {
      requestedSessionId = randomUUID();
    }

    // SettingsManager is retained (kept methods read it; teardown disposes it). The PTY TUI reads
    // the user's settings from disk itself — we no longer translate them into SDK `Options`.
    const settingsManager = new SettingsManager(params.cwd, {
      logger: this.logger,
    });
    await settingsManager.initialize();

    // Per-session task state — still surfaced via plan notifications by the Group 2 pump / hooks.
    const taskState: TaskState = new Map();

    // === SEAM(034) §9 hybrid gate: set up the per-session permission gate BEFORE the spawn =======
    // FRESH spawns only (the resume argv is not extended — the story-029 planMode precedent — and a
    // replay-only load spawns nothing). Ordering is load-bearing (GATE_FINDINGS blocker c): the
    // loopback hook server must be LIVE and the scratch settings ON DISK before claude starts,
    // because claude reads settings only at startup — a late write misses the first tool call.
    // Setup is fast (one port bind + one tmp-file write) so the story-028 fast-boot contract holds.
    // On a setup failure createSession FAILS LOUDLY rather than spawning an ungated claude that
    // looks gated (the blocker-b hazard); `FORK_GATE=off` is the documented escape hatch.
    const isFreshSpawn = !isResume && !creationOpts.forkSession && !creationOpts.replayOnly;
    let gate: SessionGate | undefined;
    if (this.gateEnabled && isFreshSpawn) {
      gate = await setupSessionGate({
        ...this.gateOptions,
        client: this.client,
        onWarn: (m) => this.logger.error(m),
      });
    }

    // Spawn the PTY engine + start the JSONL watcher + locate the transcript via the injectable
    // seam. For a fresh session `sessionId` is undefined so the engine's spawn generates it; for
    // resume/fork we hand it the requested id. A failed resume (transcript never found by the
    // file-discovery watchdog) surfaces as resourceNotFound so the client can recover.
    let started: StartedEngine;
    try {
      started = await this.startEngine({
        sessionId: isResume || creationOpts.forkSession ? requestedSessionId : undefined,
        cwd: params.cwd,
        resume: isResume || !!creationOpts.forkSession,
        replayOnly: creationOpts.replayOnly,
        sessions: this.engines,
        onEvent: (sid) => void this.pumpUpdates(sid),
        // Story 034: the gate's scratch settings file, consumed as `--settings "<file>"` (fresh path).
        settingsFile: gate?.settingsPath,
      });
    } catch (error) {
      // A failed spawn must not leak the gate's server/scratch (story 034). teardown() is
      // idempotent and self-catching; the original spawn error stays the surfaced one.
      // The settingsManager leaks here too (pre-existing: its fs.watch subscriptions held the
      // process open — exposed by the story-034 gate-wiring spawn-failure test): the session never
      // reaches the map, so teardownSession can never dispose it. Dispose it on this path.
      settingsManager.dispose();
      await gate?.teardown();
      if (creationOpts.resume && error instanceof Error) {
        throw RequestError.resourceNotFound(requestedSessionId);
      }
      throw error;
    }

    const startedSessionId = started.sessionId;
    if (started.engine) {
      this.engines.set(startedSessionId, started.engine);
    }

    // === SEAM(034): bind the gate to the AUTHORITATIVE session id (engine-spawn-generated) and the
    // live PTY. The nudge forces a pump re-read on every hook arrival, shrinking the JSONL
    // tool_use-correlation race; the PTY binding powers the #52822 allow keystroke + prompt probe.
    // Binding happens BEFORE this method returns the sessionId to Zed, so no `session/prompt` (and
    // therefore no PreToolUse) can ever observe an unbound gate. PTY exit also tears the gate down
    // (idempotent with teardownSession) so a crashed TUI leaks no port/server/scratch.
    if (gate) {
      const boundGate = gate;
      boundGate.bindSession(startedSessionId, () => void this.pumpUpdates(startedSessionId));
      boundGate.bindPty(started.pty as unknown as GatePty);
      started.pty.onExit(() => void boundGate.teardown());
    }

    // Static Degrau-1 model/mode/config defaults (the TUI owns real selection in Degrau-1).
    const models = buildDegrau1Models();
    const availableModes = buildAvailableModes(DEGRAU1_DEFAULT_MODEL_INFO);
    const modes: SessionModeState = {
      currentModeId: "default",
      availableModes,
    };
    const configOptions = buildConfigOptions(
      modes,
      models,
      [DEGRAU1_DEFAULT_MODEL_INFO],
      settingsManager.getSettings().effortLevel,
    );

    // Runtime cwd is read from inside the JSONL (story 015); fall back to the requested host cwd
    // until the first transcript line carries `.cwd` (the seam may return cwd === undefined early).
    const runtimeCwd = started.cwd ?? params.cwd;

    this.sessions[startedSessionId] = {
      pty: started.pty,
      watcher: started.watcher,
      emitted: new Set<string>(),
      emittedNested: new Set<string>(),
      toolUseCache: {},
      guardChecked: false,
      usageDisabled: false,
      engine: started.engine,
      cancelled: false,
      cwd: runtimeCwd,
      sessionFingerprint: computeSessionFingerprint(params),
      settingsManager,
      accumulatedUsage: {
        inputTokens: 0,
        outputTokens: 0,
        cachedReadTokens: 0,
        cachedWriteTokens: 0,
      },
      modes,
      models,
      modelInfos: [DEGRAU1_DEFAULT_MODEL_INFO],
      configOptions,
      contextWindowSize:
        inferContextWindowFromModel(models.currentModelId) ?? DEFAULT_CONTEXT_WINDOW,
      taskState,
      gate,
    };

    return {
      sessionId: startedSessionId,
      models,
      modes,
      configOptions,
    };
  }
}

/**
 * Build the list of permission modes the agent will advertise for the given
 * model. `auto` is gated by `ModelInfo.supportsAutoMode === true`, which is
 * the SDK's model-level availability signal. `undefined`/`false` both exclude
 * `auto`. `bypassPermissions` is still gated by `ALLOW_BYPASS`.
 */
function buildAvailableModes(modelInfo: ModelInfo | undefined): SessionModeState["availableModes"] {
  const modes: SessionModeState["availableModes"] = [];

  // Only advertise "auto" when the SDK reports the model supports it.
  if (modelInfo?.supportsAutoMode === true) {
    modes.push({
      id: "auto",
      name: "Auto",
      description: "Use a model classifier to approve/deny permission prompts",
    });
  }

  modes.push(
    {
      id: "default",
      name: "Default",
      description: "Standard behavior, prompts for dangerous operations",
    },
    {
      id: "acceptEdits",
      name: "Accept Edits",
      description: "Auto-accept file edit operations",
    },
    {
      id: "plan",
      name: "Plan Mode",
      description: "Planning mode, no actual tool execution",
    },
    {
      id: "dontAsk",
      name: "Don't Ask",
      description: "Don't prompt for permissions, deny if not pre-approved",
    },
  );

  if (ALLOW_BYPASS) {
    modes.push({
      id: "bypassPermissions",
      name: "Bypass Permissions",
      description: "Bypass all permission checks",
    });
  }

  return modes;
}

// Translate a UI effort value into the flag-layer payload. The SDK
// shallow-merges `applyFlagSettings`, drops `undefined` during JSON transport,
// and only clears a key when an explicit `null` is sent — see
// `applyFlagSettings` in @anthropic-ai/claude-agent-sdk. Mapping both the
// `"default"` sentinel and `undefined` (effort option absent for the model) to
// `null` ensures any previously-applied flag is actually cleared.

function buildConfigOptions(
  modes: SessionModeState,
  models: SessionModelState,
  modelInfos: ModelInfo[],
  currentEffortLevel?: string,
): SessionConfigOption[] {
  const options: SessionConfigOption[] = [
    {
      id: "mode",
      name: "Mode",
      description: "Session permission mode",
      category: "mode",
      type: "select",
      currentValue: modes.currentModeId,
      options: modes.availableModes.map((m) => ({
        value: m.id,
        name: m.name,
        description: m.description,
      })),
    },
    {
      id: "model",
      name: "Model",
      description: "AI model to use",
      category: "model",
      type: "select",
      currentValue: models.currentModelId,
      options: models.availableModels.map((m) => ({
        value: m.modelId,
        name: m.name,
        description: m.description ?? undefined,
      })),
    },
  ];

  // Add effort level option based on the currently selected model
  const currentModelInfo = modelInfos.find((m) => m.value === models.currentModelId);
  const supportedLevels = currentModelInfo?.supportsEffort
    ? (currentModelInfo.supportedEffortLevels ?? [])
    : [];

  if (supportedLevels.length > 0) {
    const effortOptions = [
      { value: "default", name: "Default" },
      ...supportedLevels.map((level) => ({
        value: level,
        name: level
          .split(/[_-]/)
          .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1) : part))
          .join(" "),
      })),
    ];

    const includes = (l: string) => l === "default" || (supportedLevels as string[]).includes(l);
    const validEffort =
      currentEffortLevel && includes(currentEffortLevel) ? currentEffortLevel : "default";

    options.push({
      id: "effort",
      name: "Effort",
      description: "Available effort levels for this model",
      category: "thought_level",
      type: "select",
      currentValue: validEffort,
      options: effortOptions,
    });
  }

  return options;
}

// Claude Code CLI persists display strings like "opus[1m]" in settings,
// but the SDK model list uses IDs like "claude-opus-4-6-1m".
const MODEL_CONTEXT_HINT_PATTERN = /\[(\d+m)\]$/i;

// Captures a model family version such as `4-6` or `4.7` so we can keep
// `claude-opus-4-6` from being copied onto the SDK's `opus` alias when that
// alias currently resolves to a different family version (e.g. Opus 4.7).
const MODEL_FAMILY_VERSION_PATTERN = /\b(\d+)[-.](\d+)\b/;

function extractModelFamilyVersion(s: string): string | null {
  const match = s.match(MODEL_FAMILY_VERSION_PATTERN);
  return match ? `${match[1]}.${match[2]}` : null;
}

function modelVersionsCompatible(preference: string, candidate: ModelInfo): boolean {
  const preferred = extractModelFamilyVersion(preference);
  if (!preferred) return true;
  const candidateVersion =
    extractModelFamilyVersion(candidate.value) ??
    extractModelFamilyVersion(candidate.displayName) ??
    extractModelFamilyVersion(candidate.description);
  if (!candidateVersion) return true;
  return preferred === candidateVersion;
}

function tokenizeModelPreference(model: string): { tokens: string[]; contextHint?: string } {
  const lower = model.trim().toLowerCase();
  const contextHint = lower.match(MODEL_CONTEXT_HINT_PATTERN)?.[1]?.toLowerCase();

  const normalized = lower.replace(MODEL_CONTEXT_HINT_PATTERN, " $1 ");
  const rawTokens = normalized.split(/[^a-z0-9]+/).filter(Boolean);
  const tokens = rawTokens
    .map((token) => {
      if (token === "opusplan") return "opus";
      if (token === "best" || token === "default") return "";
      return token;
    })
    .filter((token) => token && token !== "claude")
    .filter((token) => /[a-z]/.test(token) || token.endsWith("m"));

  return { tokens, contextHint };
}

function scoreModelMatch(model: ModelInfo, tokens: string[], contextHint?: string): number {
  const haystack = `${model.value} ${model.displayName}`.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) {
      score += token === contextHint ? 3 : 1;
    }
  }
  return score;
}

function resolveModelPreference(models: ModelInfo[], preference: string): ModelInfo | null {
  const trimmed = preference.trim();
  if (!trimmed) return null;

  const lower = trimmed.toLowerCase();

  // Exact match on value or display name
  const directMatch = models.find(
    (model) =>
      model.value === trimmed ||
      model.value.toLowerCase() === lower ||
      model.displayName.toLowerCase() === lower,
  );
  if (directMatch) return directMatch;

  // Substring match
  const includesMatch = models.find((model) => {
    if (!modelVersionsCompatible(trimmed, model)) return false;
    const value = model.value.toLowerCase();
    const display = model.displayName.toLowerCase();
    return value.includes(lower) || display.includes(lower) || lower.includes(value);
  });
  if (includesMatch) return includesMatch;

  // Tokenized matching for aliases like "opus[1m]"
  const { tokens, contextHint } = tokenizeModelPreference(trimmed);
  if (tokens.length === 0) return null;

  let bestMatch: ModelInfo | null = null;
  let bestScore = 0;
  for (const model of models) {
    if (!modelVersionsCompatible(trimmed, model)) continue;
    const score = scoreModelMatch(model, tokens, contextHint);
    if (0 < score && (!bestMatch || bestScore < score)) {
      bestMatch = model;
      bestScore = score;
    }
  }

  return bestMatch;
}

/**
 * Inline-vs-reference threshold for an embedded `resource` block, in characters
 * of `resource.text`.
 *
 * Content at or above this size is referenced by `@<path>` so the TUI re-reads
 * the file from disk instead of receiving its bytes over the PTY (avoids
 * flooding the terminal with a large paste). Content below it is inlined so a
 * tiny snippet of context is not lost when there is no point round-tripping
 * through the filesystem.
 *
 * This is the SINGLE source of truth: both the `@<path>` and the inline outcomes
 * key off this one constant — no duplicated magic numbers.
 */
export const EMBEDDED_RESOURCE_INLINE_THRESHOLD = 2048;

/**
 * Derive a filesystem path from a `file://` URI, or `null` when the URI is not a
 * resolvable file path. Shared by the `resource_link` and embedded `resource`
 * branches of {@link promptToClaude} so the `file://` → path derivation lives in
 * exactly one place. Never throws.
 */
function filePathFromUri(uri: string): string | null {
  return uri.startsWith("file://") ? uri.slice("file://".length) : null;
}

/**
 * Convert an ACP ContentBlock[] (session/prompt) into a PTY text payload string.
 *
 * Reverse-flow (IMPLEMENTACAO-FORK-ACP.md §8): instead of constructing an
 * SDKUserMessage for the core SDK, we assemble the text the TUI should receive
 * over the PTY. Each block yields a fragment; empty fragments are dropped and the
 * survivors are joined with a single space.
 *
 *   - text          → injected verbatim (with the legacy /mcp: slash-command
 *                     normalization preserved, since the TUI understands it).
 *   - resource_link → `@<path>` for file:// URIs (the TUI re-reads the file), or a
 *                     `[name](uri)` markdown link for any non-path URI.
 *   - resource (text) → large content (≥ EMBEDDED_RESOURCE_INLINE_THRESHOLD) with
 *                     a file:// path becomes `@<path>` so the TUI re-reads it;
 *                     anything below the threshold — or large but path-less — is
 *                     inlined directly so the context is not lost.
 *
 * `resource` (blob) / `image` / `audio` blocks are SILENT no-ops here (R4.1): they
 * emit no PTY bytes and are NOT logged — they are expected-but-unsupported media in
 * v1, not errors. An UNKNOWN block `type` (the `default` branch) and any block whose
 * mapping THROWS are treated as malformed: skipped, recorded via the `logger`, and the
 * remaining valid blocks still map — one bad block never aborts the whole prompt (R1.3).
 */
export function promptToClaude(prompt: PromptRequest, logger: Logger = console): string {
  const fragments: string[] = [];

  for (const chunk of prompt.prompt) {
    // R1.3: isolate every block. A malformed block — even one whose `type` getter
    // throws — is SKIPPED and RECORDED, never allowed to abort the remaining blocks.
    // Reading `chunk.type` happens INSIDE the try so a throwing accessor is caught too.
    try {
      switch (chunk.type) {
        case "text": {
          let text = chunk.text;
          // change /mcp:server:command args -> /server:command (MCP) args
          const mcpMatch = text.match(/^\/mcp:([^:\s]+):(\S+)(?:\s(.*))?$/);
          if (mcpMatch) {
            const [, server, command, args] = mcpMatch;
            text = `/${server}:${command} (MCP)${args ? ` ${args}` : ""}`;
          }
          fragments.push(text);
          break;
        }
        case "resource_link": {
          const path = filePathFromUri(chunk.uri);
          if (path !== null) {
            // @<path> so the TUI re-reads the file (do not inline its bytes).
            fragments.push(`@${path}`);
          } else {
            // Non-path uri (http(s)://, zed://, …): markdown link, never a bare @.
            const label = chunk.name ?? chunk.uri;
            fragments.push(`[${label}](${chunk.uri})`);
          }
          break;
        }
        case "resource": {
          // Only text resources are handled here; a blob resource (no `text`) is a
          // SILENT no-op — it is ignored media (R4.1), not malformed, so NO log.
          // Never throw on a missing field.
          if (chunk.resource && "text" in chunk.resource) {
            const content = chunk.resource.text;
            const path = filePathFromUri(chunk.resource.uri);
            if (content.length >= EMBEDDED_RESOURCE_INLINE_THRESHOLD && path !== null) {
              // Large + resolvable path → reference by @<path>, TUI re-reads (R3.1).
              fragments.push(`@${path}`);
            } else {
              // Below threshold (R3.2), or large but path-less (R3.3) → inline the
              // raw content rather than emit a broken @ mention.
              fragments.push(content);
            }
          }
          break;
        }
        // image / audio → SILENT no-ops (R4.1): expected-but-unsupported media in v1.
        // They emit no PTY bytes and are NOT logged (they are not errors).
        case "image":
        case "audio":
          break;
        default:
          // An unrecognized block type is malformed: skip it AND record the skip,
          // consistent with the throwing-block path (R1.3). Still no throw.
          logger.error(
            "promptToClaude: skipped an unknown content block",
            (chunk as { type?: unknown }).type,
          );
          break;
      }
    } catch (err) {
      // R1.3: a block whose mapping threw is isolated — record the skip and continue
      // to the next block. The function still returns the payload from the valid blocks.
      logger.error("promptToClaude: skipped a malformed content block", err);
      continue;
    }
  }

  return fragments.filter((fragment) => fragment.length > 0).join(" ");
}

/**
 * Convert an SDKAssistantMessage (Claude) to a SessionNotification (ACP).
 * Only handles text, image, and thinking chunks for now.
 */
export function toAcpNotifications(
  content: string | ContentBlockParam[] | BetaContentBlock[] | BetaRawContentBlockDelta[],
  role: "assistant" | "user",
  sessionId: string,
  toolUseCache: ToolUseCache,
  client: AgentSideConnection,
  logger: Logger,
  options?: {
    registerHooks?: boolean;
    clientCapabilities?: ClientCapabilities;
    parentToolUseId?: string | null;
    cwd?: string;
    taskState?: TaskState;
  },
): SessionNotification[] {
  const taskState = options?.taskState ?? new Map();
  const registerHooks = options?.registerHooks !== false;
  const supportsTerminalOutput = options?.clientCapabilities?._meta?.["terminal_output"] === true;
  if (typeof content === "string") {
    const update: SessionNotification["update"] = {
      sessionUpdate: role === "assistant" ? "agent_message_chunk" : "user_message_chunk",
      content: {
        type: "text",
        text: content,
      },
    };

    if (options?.parentToolUseId) {
      update._meta = {
        ...update._meta,
        claudeCode: {
          ...(update._meta?.claudeCode || {}),
          parentToolUseId: options.parentToolUseId,
        },
      };
    }

    return [{ sessionId, update }];
  }

  const output = [];
  // Only handle the first chunk for streaming; extend as needed for batching
  for (const chunk of content) {
    let update: SessionNotification["update"] | null = null;
    switch (chunk.type) {
      case "text":
      case "text_delta":
        update = {
          sessionUpdate: role === "assistant" ? "agent_message_chunk" : "user_message_chunk",
          content: {
            type: "text",
            text: chunk.text,
          },
        };
        break;
      case "image":
        update = {
          sessionUpdate: role === "assistant" ? "agent_message_chunk" : "user_message_chunk",
          content: {
            type: "image",
            data: chunk.source.type === "base64" ? chunk.source.data : "",
            mimeType: chunk.source.type === "base64" ? chunk.source.media_type : "",
            uri: chunk.source.type === "url" ? chunk.source.url : undefined,
          },
        };
        break;
      case "thinking":
      case "thinking_delta":
        update = {
          sessionUpdate: "agent_thought_chunk",
          content: {
            type: "text",
            text: chunk.thinking,
          },
        };
        break;
      case "tool_use":
      case "server_tool_use":
      case "mcp_tool_use": {
        const alreadyCached = chunk.id in toolUseCache;
        toolUseCache[chunk.id] = chunk;
        if (chunk.name === "TodoWrite") {
          // @ts-expect-error - sometimes input is empty object or undefined
          if (Array.isArray(chunk.input?.todos)) {
            update = {
              sessionUpdate: "plan",
              entries: planEntries(chunk.input as { todos: ClaudePlanEntry[] }),
            };
          }
        } else if (
          chunk.name === "TaskCreate" ||
          chunk.name === "TaskUpdate" ||
          chunk.name === "TaskList" ||
          chunk.name === "TaskGet"
        ) {
          // Task* tool_use is suppressed; the plan update is emitted at
          // tool_result time once we have the task ID (for TaskCreate) and
          // confirmation that the change took effect.
        } else {
          // Only register hooks on first encounter to avoid double-firing
          if (registerHooks && !alreadyCached) {
            registerHookCallback(chunk.id, {
              onPostToolUseHook: async (toolUseId, toolInput, toolResponse) => {
                const toolUse = toolUseCache[toolUseId];
                if (toolUse) {
                  // Both `Edit` and `Write` produce a structuredPatch in their
                  // PostToolUse tool_response. For Edit the diff replaces the
                  // optimistic content built at tool_use time. For Write the
                  // optimistic content (built from `input.content` alone with
                  // `oldText: null`) shows "creation" semantics regardless of
                  // whether the file existed; the structuredPatch from the
                  // hook lets us emit the real diff for `type: "update"`. The
                  // helper returns `{}` if the response shape isn't usable.
                  const editDiff =
                    toolUse.name === "Edit" || toolUse.name === "Write"
                      ? toolUpdateFromDiffToolResponse(toolResponse)
                      : {};
                  const update: SessionNotification["update"] = {
                    _meta: {
                      claudeCode: {
                        toolResponse,
                        toolName: toolUse.name,
                      },
                    } satisfies ToolUpdateMeta,
                    toolCallId: toolUseId,
                    sessionUpdate: "tool_call_update",
                    ...editDiff,
                  };
                  await client.sessionUpdate({
                    sessionId,
                    update,
                  });
                } else {
                  logger.error(
                    `[claude-agent-acp] Got a tool response for tool use that wasn't tracked: ${toolUseId}`,
                  );
                }
              },
            });
          }

          let rawInput;
          try {
            rawInput = JSON.parse(JSON.stringify(chunk.input));
          } catch {
            // ignore if we can't turn it to JSON
          }

          if (alreadyCached) {
            // Second encounter (full assistant message after streaming) —
            // send as tool_call_update to refine the existing tool_call
            // rather than emitting a duplicate tool_call.
            update = {
              _meta: {
                claudeCode: {
                  toolName: chunk.name,
                },
              } satisfies ToolUpdateMeta,
              toolCallId: chunk.id,
              sessionUpdate: "tool_call_update",
              rawInput,
              ...toolInfoFromToolUse(chunk, supportsTerminalOutput, options?.cwd),
            };
          } else {
            // First encounter (streaming content_block_start or replay) —
            // send as tool_call with terminal_info for Bash tools.
            update = {
              _meta: {
                claudeCode: {
                  toolName: chunk.name,
                },
                ...(chunk.name === "Bash" && supportsTerminalOutput
                  ? { terminal_info: { terminal_id: chunk.id } }
                  : {}),
              } satisfies ToolUpdateMeta,
              toolCallId: chunk.id,
              sessionUpdate: "tool_call",
              rawInput,
              status: "pending",
              ...toolInfoFromToolUse(chunk, supportsTerminalOutput, options?.cwd),
            };
          }
        }
        break;
      }

      case "tool_result":
      case "tool_search_tool_result":
      case "web_fetch_tool_result":
      case "web_search_tool_result":
      case "code_execution_tool_result":
      case "bash_code_execution_tool_result":
      case "text_editor_code_execution_tool_result":
      case "mcp_tool_result": {
        const toolUse = toolUseCache[chunk.tool_use_id];
        if (!toolUse) {
          logger.error(
            `[claude-agent-acp] Got a tool result for tool use that wasn't tracked: ${chunk.tool_use_id}`,
          );
          break;
        }

        if (
          toolUse.name === "TaskCreate" ||
          toolUse.name === "TaskUpdate" ||
          toolUse.name === "TaskList" ||
          toolUse.name === "TaskGet"
        ) {
          // Headless/SDK sessions emit Task* tools instead of TodoWrite.
          // TaskCreate / TaskUpdate mutate the accumulated task list; TaskList
          // and TaskGet are read-only so we just suppress their tool_call /
          // tool_result events. The plan update is emitted as a snapshot of
          // the accumulated state, mirroring the legacy TodoWrite behavior.
          const isError = "is_error" in chunk && chunk.is_error;
          if (!isError) {
            if (toolUse.name === "TaskCreate") {
              applyTaskCreate(
                taskState,
                toolUse.input as Parameters<typeof applyTaskCreate>[1],
                parseTaskCreateOutput(chunk.content),
              );
            } else if (toolUse.name === "TaskUpdate") {
              applyTaskUpdate(taskState, toolUse.input as Parameters<typeof applyTaskUpdate>[1]);
            }
          }
          if (!isError && (toolUse.name === "TaskCreate" || toolUse.name === "TaskUpdate")) {
            update = {
              sessionUpdate: "plan",
              entries: taskStateToPlanEntries(taskState),
            };
          }
        } else if (toolUse.name !== "TodoWrite") {
          const { _meta: toolMeta, ...toolUpdate } = toolUpdateFromToolResult(
            chunk,
            toolUseCache[chunk.tool_use_id],
            supportsTerminalOutput,
          );

          // When terminal output is supported, send terminal_output as a
          // separate notification to match codex-acp's streaming lifecycle:
          //   1. tool_call       → _meta.terminal_info  (already sent above)
          //   2. tool_call_update → _meta.terminal_output (sent here)
          //   3. tool_call_update → _meta.terminal_exit  (sent below with status)
          if (toolMeta?.terminal_output) {
            output.push({
              sessionId,
              update: {
                _meta: {
                  terminal_output: toolMeta.terminal_output,
                  ...(options?.parentToolUseId
                    ? { claudeCode: { parentToolUseId: options.parentToolUseId } }
                    : {}),
                },
                toolCallId: chunk.tool_use_id,
                sessionUpdate: "tool_call_update" as const,
              },
            });
          }

          update = {
            _meta: {
              claudeCode: {
                toolName: toolUse.name,
              },
              ...(toolMeta?.terminal_exit ? { terminal_exit: toolMeta.terminal_exit } : {}),
            } satisfies ToolUpdateMeta,
            toolCallId: chunk.tool_use_id,
            sessionUpdate: "tool_call_update",
            status: "is_error" in chunk && chunk.is_error ? "failed" : "completed",
            rawOutput: chunk.content,
            ...toolUpdate,
          };
        }
        break;
      }

      case "document":
      case "search_result":
      case "redacted_thinking":
      case "input_json_delta":
      case "citations_delta":
      case "signature_delta":
      case "container_upload":
      case "compaction":
      case "compaction_delta":
      case "advisor_tool_result":
      case "mid_conv_system":
        break;

      default:
        unreachable(chunk, logger);
        break;
    }
    if (update) {
      if (options?.parentToolUseId) {
        update._meta = {
          ...update._meta,
          claudeCode: {
            ...(update._meta?.claudeCode || {}),
            parentToolUseId: options.parentToolUseId,
          },
        };
      }
      output.push({ sessionId, update });
    }
  }

  return output;
}

export function streamEventToAcpNotifications(
  message: SDKPartialAssistantMessage,
  sessionId: string,
  toolUseCache: ToolUseCache,
  client: AgentSideConnection,
  logger: Logger,
  options?: {
    clientCapabilities?: ClientCapabilities;
    cwd?: string;
    taskState?: TaskState;
  },
): SessionNotification[] {
  const event = message.event;
  switch (event.type) {
    case "content_block_start":
      return toAcpNotifications(
        [event.content_block],
        "assistant",
        sessionId,
        toolUseCache,
        client,
        logger,
        {
          clientCapabilities: options?.clientCapabilities,
          parentToolUseId: message.parent_tool_use_id,
          cwd: options?.cwd,
          taskState: options?.taskState,
        },
      );
    case "content_block_delta":
      return toAcpNotifications(
        [event.delta],
        "assistant",
        sessionId,
        toolUseCache,
        client,
        logger,
        {
          clientCapabilities: options?.clientCapabilities,
          parentToolUseId: message.parent_tool_use_id,
          cwd: options?.cwd,
          taskState: options?.taskState,
        },
      );
    // No content. `ping` is a Messages-API keep-alive event that the SDK's
    // `BetaRawMessageStreamEvent` union doesn't include even though the
    // wire format emits it; the `as never` cast lets us no-op it here
    // instead of letting it fall through to `unreachable`.
    case "ping" as never:
    case "message_start":
    case "message_delta":
    case "message_stop":
    case "content_block_stop":
      return [];

    default:
      unreachable(event, logger);
      return [];
  }
}

export function runAcp(deps?: AgentDeps) {
  const input = nodeToWebWritable(process.stdout);
  const output = nodeToWebReadable(process.stdin);

  const stream = ndJsonStream(input, output);
  let agent!: ClaudeAcpAgent;
  const connection = new AgentSideConnection((client) => {
    // Positions 2-3 (logger/engine) default; `deps` carries the bootstrap-resolved flags
    // (story 038: usageUpdate from process.env.USAGE_UPDATE, default OFF).
    agent = new ClaudeAcpAgent(client, undefined, undefined, deps);
    return agent;
  }, stream);
  return { connection, agent };
}


/** Best-effort first guess of a model's context window from its ID, used only
 *  until a `result` message arrives with the authoritative `modelUsage` value.
 *  Anthropic 1M-context variants encode "1m" as a distinct token in the SDK
 *  model ID (e.g., "claude-opus-4-6-1m"), which `\b1m\b` catches without also
 *  matching things like "10m" or embedded substrings. */
function inferContextWindowFromModel(model: string): number | null {
  if (/\b1m\b/i.test(model)) return 1_000_000;
  return null;
}
