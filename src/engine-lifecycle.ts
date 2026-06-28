// === §2/§5 MOTOR box — managed lifecycle around the story 013 PTY engine (story 014) ===
//
// Story 013 spawns the interactive `claude` TUI in a real PTY with a sanitized, subscription
// -billing environment, and RETURNS the handle for someone else to manage. This module is
// that someone: it makes the PTY a *managed* process for the lifetime of an ACP session.
//
// Per the §2 process model a single Node process hosts BOTH the PTY and the JSONL watcher for
// each session — there is no out-of-process supervisor. Per the §2 ordering rule the JSONL
// tail (story 015's watcher) is the single source of truth for session state; `p.onData` is a
// cosmetic live-mirror only (story 034) and MUST NOT drive state transitions.
//
// Spec is PINNED by IMPLEMENTACAO-FORK-ACP.md §5 (Lifecycle/resume):
//   `p.onExit(({exitCode,signal}) => cleanup)` · `p.resize(cols,rows)` with debounce ·
//   Cancel `p.write('\x03')`/`p.write('\x1b')`/`p.kill()` · Resume `bash -c 'claude --resume
//   "<id>" || claude'`.
//
// Degrau-1 stays READ-ONLY: the cancel primitives are EXPOSED but not wired to any ACP
// `session/cancel` handler here (that is story 030). This module imports NO SDK.
//
// Scope grows task-by-task in this story: Task 1 owns onExit→cleanup (this commit); the
// debounced resize, the cancel primitives, the robust resume, and the single-process binding
// land in Tasks 2–5.

import pty from "node-pty";
import type { IDisposable } from "node-pty";
import {
  assertSpawnEnvUntainted,
  buildSanitizedEnv,
  resolveShell,
  spawnClaudePty,
} from "./engine-pty.js";
import type { PtyEngineHandle } from "./engine-pty.js";
import { isSafeAgentRef } from "./agent-catalog.js";
import { attachAnsiMirror } from "./ansi-mirror.js";
import type { AnsiMirrorOptions } from "./ansi-mirror.js";

/**
 * Minimal contract the lifecycle layer depends on from the JSONL tail watcher (story 015,
 * downstream). Lifecycle only needs to STOP it on cleanup — it never reads from it. Defined
 * here as the interface seam so 014 can tear the watcher down before 015 ships the concrete
 * `fs.watch`/tail implementation.
 */
export interface SessionWatcher {
  /** Tear down the watcher: stop the fs.watch/tail, flush buffers, drop listeners. */
  stop(): void;
}

/** Diagnostics passed to the {@link SessionEngineOptions.onCleanup} hook. */
export interface CleanupInfo {
  sessionId: string;
  /** PTY exit code, when cleanup was triggered by `onExit`. */
  exitCode?: number;
  /** PTY terminating signal, when cleanup was triggered by `onExit`. */
  signal?: number;
}

/**
 * Default PTY geometry applied when Zed supplies no terminal size (§5 Spawn defaults). Mirrors
 * the story 013 spawn dimensions so a no-size resize matches a freshly-spawned PTY.
 */
export const DEFAULT_COLS = 120;
export const DEFAULT_ROWS = 40;

/**
 * Resize debounce window (ms). Rapid resize requests (e.g. a window drag) are coalesced and
 * only the last size is applied after this window elapses, so the TUI is not thrashed (§5).
 */
export const RESIZE_DEBOUNCE_MS = 100;

/** Construction options for a {@link SessionEngine}. */
export interface SessionEngineOptions {
  /** The spawned PTY handle from story 013's `spawnClaudePty` (or the story 014 resume spawn). */
  handle: PtyEngineHandle;
  /** The per-session JSONL tail watcher (story 015). Optional until 015 lands. */
  watcher?: SessionWatcher;
  /**
   * The live session registry. The engine registers itself on construction and deletes its
   * entry on cleanup. Injectable so tests can observe the map churn directly.
   */
  sessions?: Map<string, SessionEngine>;
  /** Optional diagnostics hook invoked exactly once, when cleanup runs. */
  onCleanup?: (info: CleanupInfo) => void;
  /** Resize debounce window in ms; defaults to {@link RESIZE_DEBOUNCE_MS}. */
  resizeDebounceMs?: number;
  /** Injectable timer fns (default global setTimeout/clearTimeout); fake-timer tests override. */
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  /**
   * Story 035 — OPTIONAL cosmetic live ANSI mirror (§5). OFF by default: when absent/disabled the
   * `p.onData` tap is NEVER attached and the engine path is byte-for-byte the read-only Degrau-1
   * behaviour. When enabled (flag on + sink), the engine subscribes a stateless one-way mirror that
   * forwards raw TUI bytes to the sink for §9 gating visibility, and detaches it on {@link cleanup}.
   * The mirror is strictly subordinate to the JSONL tail: no state, no `SessionUpdate` (§2).
   */
  ansiMirror?: AnsiMirrorOptions;
}

/**
 * Per-session managed engine: ONE Node process owns the PTY (§2). Task 1 wires the PTY's
 * `onExit` to a single, idempotent `cleanup` that tears down the watcher and releases the
 * per-session connection state exactly once (R1.1–R1.3).
 *
 * `onExit` is only ONE of the possible teardown triggers — an explicit kill (Task 3) routes
 * through the same `cleanup`, so the per-session `disposed` guard makes the second trigger a
 * no-op rather than double-freeing the watcher/session-map handles.
 */
export class SessionEngine {
  /** The pre-generated v4 session id, == the JSONL transcript basename (story 013). */
  readonly sessionId: string;
  /** The live PTY handle whose lifecycle this engine owns. */
  readonly pty: PtyEngineHandle["pty"];
  /** The JSONL tail watcher (story 015); cleared on cleanup. */
  watcher?: SessionWatcher;

  private readonly sessions?: Map<string, SessionEngine>;
  private readonly onCleanup?: (info: CleanupInfo) => void;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;
  private readonly debounceMs: number;
  private resizeTimer?: ReturnType<typeof setTimeout>;
  private pendingSize?: { cols: number; rows: number };
  private disposed = false;
  /**
   * Story 028: the AbortController for the BACKGROUND fresh-path transcript discovery poll (the
   * unbounded `watchdogMs: Infinity` glob loop that arms the watcher once the transcript appears).
   * Stored here (sub-task 2.1) so the lifecycle owns the handle; `cleanup()` aborts it (sub-task 3.1)
   * so tearing a never-interacted session down cancels the dangling poll instead of leaking it.
   */
  private pendingDiscovery?: AbortController;
  /**
   * Story 035: the `IDisposable` for the OPTIONAL cosmetic live ANSI mirror's `p.onData` tap.
   * Present ONLY when the mirror flag was enabled; `undefined` on the default OFF path (where no
   * `onData` listener was ever attached). `cleanup()` detaches it so the cosmetic tap does not
   * outlive the session.
   */
  private ansiMirror?: IDisposable;

  constructor(opts: SessionEngineOptions) {
    this.sessionId = opts.handle.sessionId;
    this.pty = opts.handle.pty;
    this.watcher = opts.watcher;
    this.sessions = opts.sessions;
    this.onCleanup = opts.onCleanup;
    this.setTimeoutFn = opts.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = opts.clearTimeoutFn ?? clearTimeout;
    this.debounceMs = opts.resizeDebounceMs ?? RESIZE_DEBOUNCE_MS;

    this.sessions?.set(this.sessionId, this);

    // §5: process exit tears the session down. onExit is NOT assumed to be the only teardown
    // trigger (an explicit kill also calls cleanup) — idempotency is enforced in cleanup().
    this.pty.onExit(({ exitCode, signal }) => this.cleanup({ exitCode, signal }));

    // Story 035: OPTIONAL cosmetic live ANSI mirror (§5). attachAnsiMirror is a no-op that does NOT
    // touch `p.onData` when the flag is OFF (the default) — so the OFF path is byte-for-byte the
    // read-only Degrau-1 behaviour (no listener attached). When ON it returns the tap's IDisposable.
    // The mirror is cosmetic and one-way: it never drives session state (§2 — structure comes only
    // from the JSONL tail). UNWIRED §7: no `content_block_delta`→`SessionUpdate` path is layered here.
    this.ansiMirror = attachAnsiMirror(this.pty, opts.ansiMirror);
  }

  /**
   * Debounced terminal resize (R2.1–R2.3). Stores the latest (cols, rows) and (re)arms a short
   * debounce timer; when it fires, applies ONLY the last size via `p.resize`. Falls back to the
   * 120×40 default when no size is supplied. A resize requested after the PTY has exited is
   * dropped without throwing (the `disposed` guard) rather than writing to a dead handle.
   */
  requestResize(cols: number = DEFAULT_COLS, rows: number = DEFAULT_ROWS): void {
    if (this.disposed) return; // drop post-exit resize, no throw (R2.3)
    this.pendingSize = { cols, rows };
    if (this.resizeTimer !== undefined) this.clearTimeoutFn(this.resizeTimer);
    this.resizeTimer = this.setTimeoutFn(() => {
      this.resizeTimer = undefined;
      if (this.disposed || !this.pendingSize) return;
      const { cols: c, rows: r } = this.pendingSize;
      this.pendingSize = undefined;
      this.pty.resize(c, r);
    }, this.debounceMs);
  }

  /**
   * Ctrl+C — write the interrupt byte `\x03` to the PTY to cancel the current turn (R3.1).
   * No-op after the PTY has exited (R3.4) rather than writing to a dead handle.
   *
   * EXPOSED but deliberately NOT wired to any ACP `session/cancel` handler here — the Degrau-1
   * path is read-only; the `session/cancel`→Ctrl+C wiring is story 030.
   */
  interrupt(): void {
    if (this.disposed) return;
    this.pty.write("\x03");
  }

  /** Esc — write the escape byte `\x1b` to the PTY (R3.2). No-op after exit (R3.4). */
  escape(): void {
    if (this.disposed) return;
    this.pty.write("\x1b");
  }

  /**
   * Kill the PTY process (R3.3). No-op after exit (R3.4). In production the subsequent `onExit`
   * routes through the idempotent {@link cleanup}, so no explicit teardown call is needed here.
   */
  kill(): void {
    if (this.disposed) return;
    this.pty.kill();
  }

  /**
   * Idempotent teardown (R1.1–R1.3): runs the body exactly once per session. Clears any armed
   * resize timer, stops the watcher, releases the session-map entry, and fires the diagnostics
   * hook. A second call (e.g. explicit kill followed by `onExit`) is a no-op — it leaves no
   * residual timer, watcher subscription, or session-map entry to free again.
   */
  cleanup(info?: { exitCode?: number; signal?: number }): void {
    if (this.disposed) return;
    this.disposed = true;

    // Story 028 (sub-task 3.1): cancel the BACKGROUND fresh-path discovery poll (the unbounded
    // `watchdogMs: Infinity` glob loop whose AbortController 2.1 stored via setPendingDiscovery).
    // A session torn down before its first interaction never produced a transcript, so abort the
    // dangling poll here — BEFORE stopping the watcher — so it leaks no poll. No-op when no
    // discovery was pending (a resumed session, or one already past discovery: optional chaining).
    // Idempotent via the `disposed` guard above.
    this.pendingDiscovery?.abort();
    this.pendingDiscovery = undefined;

    // Story 035: detach the cosmetic live ANSI mirror's `p.onData` tap so it does not outlive the
    // session. No-op when the mirror was never enabled (the default OFF path leaves this undefined).
    this.ansiMirror?.dispose();
    this.ansiMirror = undefined;

    if (this.resizeTimer !== undefined) {
      this.clearTimeoutFn(this.resizeTimer);
      this.resizeTimer = undefined;
    }
    this.pendingSize = undefined;

    if (this.watcher) {
      this.watcher.stop();
      this.watcher = undefined;
    }
    this.sessions?.delete(this.sessionId);

    this.onCleanup?.({ sessionId: this.sessionId, exitCode: info?.exitCode, signal: info?.signal });
  }

  /**
   * Store the AbortController for the background fresh-path discovery poll (story 028, sub-task 2.1).
   * `cleanup()` aborts it (sub-task 3.1) so a session torn down before its first interaction cancels
   * the dangling `watchdogMs: Infinity` poll instead of leaking it. The engine owns the handle.
   */
  setPendingDiscovery(ac: AbortController): void {
    this.pendingDiscovery = ac;
  }

  /** Whether {@link cleanup} has already run for this session. */
  get isDisposed(): boolean {
    return this.disposed;
  }
}

/** PTY name pinned by §5 — mirrors the story 013 spawn allocation. */
const RESUME_PTY_NAME = "xterm-256color";

/**
 * Build the robust resume argv (§5, R4.1): `bash -c 'claude --resume "<id>" || claude'`. The
 * `|| claude` makes a FAILED `--resume` fall back to a fresh interactive session rather than
 * hanging. The id is double-quoted so it survives shell word-splitting. There is deliberately
 * NO `-p`/`--print`/`stream-json` — those select the SDK/credit non-interactive path.
 *
 * Story 046 (R3.4): an optional non-"default" `permissionMode` is carried into BOTH the `--resume`
 * launch AND the `|| claude` fresh fallback as `--permission-mode <mode>`, so an in-place re-spawn
 * (a dontAsk/bypass switch) reattaches the SAME sessionId/transcript under the new mode. Still no
 * `-p`/`--print`/`stream-json` — billing stays subscription `cli`.
 *
 * Story 056 (R3.3): an optional `agent` persona name is likewise carried via `flags` as the
 * DOUBLE-QUOTED `--agent "<name>"`. Because `flags` is interpolated into BOTH the `--resume "<id>"`
 * launch AND the `|| claude` fresh fallback, this single addition reaches both branches (R3.3). It is
 * the SECOND layer of the command-injection defense — re-asserted via {@link isSafeAgentRef} (which
 * accepts a namespaced `plugin:name`) so an unsafe name is DROPPED (no flag), never interpolated.
 * Still no `-p`/`--print`/`stream-json`.
 */
export function buildResumeArgv(
  sessionId: string,
  permissionMode?: string,
  effortLevel?: string,
  agent?: string,
): [string, string] {
  const pm =
    permissionMode && permissionMode !== "default" ? ` --permission-mode ${permissionMode}` : "";
  const ef = effortLevel && effortLevel !== "default" ? ` --effort ${effortLevel}` : "";
  // Story 056 (R3.3): double-quoted agent flag, emitted only for a real persona (the "default"
  // sentinel = no persona emits nothing, mirroring --effort) and only when it passes the R3.3
  // allowlist re-assert; folded into `flags` so it carries into both the --resume and || claude halves.
  const ag = agent && agent !== "default" && isSafeAgentRef(agent) ? ` --agent "${agent}"` : "";
  const flags = `${pm}${ef}${ag}`;
  return ["-c", `claude --resume "${sessionId}"${flags} || claude${flags}`];
}

/** Options for {@link spawnResumePty}. */
export interface SpawnResumeOptions {
  /** The prior session id to reattach to (== the JSONL transcript basename). */
  sessionId: string;
  /** Host working directory the resumed TUI runs in. */
  cwd: string;
  /** Base environment to sanitize; defaults to the parent process env. */
  baseEnv?: Record<string, string | undefined>;
  /** Injectable spawn function (defaults to node-pty's `spawn`); tests pass a fake. */
  spawn?: typeof pty.spawn;
  /**
   * Story 046 (R3.4): carry `--permission-mode <mode>` into the resume argv for an in-place re-spawn
   * (a dontAsk/bypass switch). Non-"default" only; preserves the same sessionId/transcript.
   */
  permissionMode?: string;
  /** Story 046 (R2.2): carry `--effort <level>` into the resume argv for an effort re-spawn. */
  effortLevel?: string;
  /**
   * Story 056 (R3.3): carry the DOUBLE-QUOTED `--agent "<name>"` into the resume argv (both the
   * `--resume` and the `|| claude` fallback branches). Injection-safe — re-asserted against the R3.3
   * allowlist so an unsafe name is dropped. Absent → no flag.
   */
  agent?: string;
}

/**
 * Spawn the resume PTY, reusing story 013's sanitized env (R4.2) so the resumed turn keeps the
 * `entrypoint='cli'` subscription posture. Same env-sanitize ({@link buildSanitizedEnv}),
 * refuse-to-spawn taint guard ({@link assertSpawnEnvUntainted}), shell resolution
 * ({@link resolveShell}), and §5 PTY geometry as the story 013 spawn path — ONLY the argv
 * differs (robust resume vs the fresh `--session-id` launch). Returns the same
 * {@link PtyEngineHandle} shape so a {@link SessionEngine} manages a resumed PTY identically.
 */
export function spawnResumePty(opts: SpawnResumeOptions): PtyEngineHandle {
  const { sessionId, cwd, baseEnv = process.env, spawn = pty.spawn } = opts;

  const shell = resolveShell(baseEnv);
  const argv = buildResumeArgv(sessionId, opts.permissionMode, opts.effortLevel, opts.agent);
  const env = buildSanitizedEnv(baseEnv);

  // §10 refuse-to-spawn guard (R4.2): abort if any forbidden billing var survived sanitization,
  // rather than resume a credit-billed run. Checks the SPAWN env, not process.env.
  assertSpawnEnvUntainted(env);

  const p = spawn(shell, argv, {
    name: RESUME_PTY_NAME,
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
    cwd,
    env: env as { [key: string]: string },
  });

  return { sessionId, pty: p };
}

/** Options for {@link createSessionEngine}. */
export interface CreateSessionEngineOptions {
  /** Host working directory the spawned TUI runs in (story 013 spawn). */
  cwd: string;
  /** Base environment to sanitize; defaults to the parent process env. */
  baseEnv?: Record<string, string | undefined>;
  /** Injectable spawn function (defaults to node-pty's `spawn`); tests pass a fake. */
  spawn?: typeof pty.spawn;
  /**
   * Story 046 (R3.2): forwarded to {@link spawnClaudePty} as `--permission-mode <mode>` for a fresh
   * spawn seeded to a non-"default" mode. Absent/"default" → no flag (byte-for-byte pre-046 spawn).
   */
  permissionMode?: string;
  /** Story 046 (R2.2): forwarded to {@link spawnClaudePty} as `--effort <level>` for a non-"default" seed. */
  effortLevel?: string;
  /**
   * Story 056 (R3.3): forwarded to {@link spawnClaudePty} as the DOUBLE-QUOTED `--agent "<name>"` for a
   * fresh spawn seeded to a main-thread agent persona. Injection-safe (R3.3 allowlist re-assert).
   * Absent → no flag.
   */
  agent?: string;
  /**
   * Story 034 (§9 hybrid gate): per-session SCRATCH settings file carrying the fork's
   * `PreToolUse` hook, forwarded to {@link spawnClaudePty} as `--settings "<file>"`. The
   * caller MUST have written it (story 032 `injectHook`) BEFORE calling — claude reads
   * settings only at startup (GATE_FINDINGS blocker c). Absent → ungated spawn (pre-034).
   */
  settingsFile?: string;
  /**
   * Factory that starts the per-session JSONL tail watcher (story 015) for the freshly spawned
   * PTY. Invoked exactly once with the spawned session id and PTY. Returns the watcher handle the
   * engine tears down on cleanup. The watcher's JSONL tail — NOT `p.onData` — is the single
   * source of truth for session state (§2). Optional until story 015 lands.
   */
  startWatcher?: (sessionId: string, p: PtyEngineHandle["pty"]) => SessionWatcher;
  /** The live session registry the engine registers into and deletes from on cleanup. */
  sessions?: Map<string, SessionEngine>;
  /** Resize debounce window in ms; defaults to {@link RESIZE_DEBOUNCE_MS}. */
  resizeDebounceMs?: number;
  /** Optional diagnostics hook invoked exactly once, when cleanup runs. */
  onCleanup?: (info: CleanupInfo) => void;
  /** Injectable timer fns (default global setTimeout/clearTimeout); fake-timer tests override. */
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  /**
   * Story 035 — OPTIONAL cosmetic live ANSI mirror (§5). OFF by default. Forwarded to the
   * {@link SessionEngine}; when absent/disabled NO `p.onData` tap is attached and the binding is
   * byte-for-byte the read-only Degrau-1 path. The mirror is cosmetic only — it produces no
   * `SessionUpdate` and never feeds the structural path (§2: state comes only from the JSONL tail).
   */
  ansiMirror?: AnsiMirrorOptions;
}

/**
 * Bind ONE PTY and ONE JSONL watcher into a single per-session {@link SessionEngine}, hosted by
 * THIS one Node process (§2 — no out-of-process supervisor, no `child_process.fork`). The PTY is
 * spawned via story 013's sanitized path; the watcher is started by the injected story-015
 * factory; the returned engine record owns both (PTY handle + watcher handle + resize timer +
 * disposed flag).
 *
 * ── tail-as-source-of-truth fence (§2 ordering) ───────────────────────────────────────────────
 * Session state derives SOLELY from the watcher's JSONL tail. The live ANSI mirror (story 035) is
 * cosmetic and OFF by default: with no `ansiMirror` option, `p.onData` is NEVER subscribed and this
 * binding is byte-for-byte the read-only Degrau-1 path. Even when enabled, the mirror is one-way
 * (bytes → live-view sink) and MUST NOT mutate session state or drive turn transitions. Do not add
 * an `onData`→state path in this binding: structure comes only from the JSONL tail.
 * ──────────────────────────────────────────────────────────────────────────────────────────────
 */
export function createSessionEngine(opts: CreateSessionEngineOptions): SessionEngine {
  // ONE PTY, via the story 013 sanitized spawn path. `settingsFile` (story 034) injects the
  // per-session gate hook via `--settings` — already written by the caller BEFORE this spawn.
  const handle = spawnClaudePty({
    cwd: opts.cwd,
    baseEnv: opts.baseEnv,
    spawn: opts.spawn,
    permissionMode: opts.permissionMode,
    effortLevel: opts.effortLevel,
    agent: opts.agent,
    settingsFile: opts.settingsFile,
  });
  // ONE watcher, started by the story 015 factory and bound to that same PTY.
  const watcher = opts.startWatcher?.(handle.sessionId, handle.pty);

  return new SessionEngine({
    handle,
    watcher,
    sessions: opts.sessions,
    resizeDebounceMs: opts.resizeDebounceMs,
    onCleanup: opts.onCleanup,
    setTimeoutFn: opts.setTimeoutFn,
    clearTimeoutFn: opts.clearTimeoutFn,
    // Story 035: forward the OPTIONAL cosmetic mirror config (OFF by default — no tap when absent).
    ansiMirror: opts.ansiMirror,
  });
}
