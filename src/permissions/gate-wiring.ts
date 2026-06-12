// Story 034 (§9 / R3.3) — runtime wiring of the HYBRID permission gate into the real session path.
//
// Stories 032/033 delivered the gate as STANDALONE, offline-tested seams: the verified-free loopback
// port (gate/port.ts), the non-destructive `--settings` hook writer (gate/settings-writer.ts), the
// fail-closed `PreToolUse` http hook server (hook-server.ts), the `tool_use.id` correlation + ACP
// `session/request_permission` bridge (request-permission.ts), and the #52822 allow keystroke
// mitigation (allow-inject.ts). THIS module is the missing glue: one {@link SessionGate} PER SESSION
// that composes those REAL units (no re-implementation) so `createSession` can:
//
//   1. allocate a free loopback port (`findFreePort`) and start the hook server on it;
//   2. write the per-session SCRATCH settings file carrying the hook (`injectHook`) — NEVER the
//      user's `~/.claude/settings*.json` and NEVER the project `settings.local.json`; the scratch
//      lives in `os.tmpdir()` and is handed to the spawn as `--settings "<file>"` (GATE_FINDINGS
//      blocker c: settings MUST be on disk BEFORE the spawn — claude reads them only at startup);
//   3. decide each `PreToolUse` via the REAL story-033 decider chain: correlate by `tool_use.id`
//      against the JSONL (fed by the pump through {@link SessionGate.correlator}) → raise ACP
//      `session/request_permission` in Zed → enforce (`deny` body intercepts BEFORE the tool runs);
//   4. on `allow`, run the #52822 sweep: if the native TUI prompt still renders, inject the `'1\r'`
//      keystroke RAW into the PTY (allow-inject — deliberately NOT `sendPrompt`, whose leading
//      Ctrl+U clear byte must never touch a pending native dialog); on a stuck prompt WARN and hold;
//   5. tear everything down (close the server, `restore` the scratch) on `teardownSession` AND on
//      PTY exit — idempotently, leaking no port, server, or scratch file.
//
// FAIL CLOSED (PERMISSIONS.md §6): every uncertain path in the chain below already resolves to deny
// (malformed payload / no decider / decider timeout → hook-server; missing/duplicate id, ACP
// transport error, cancelled outcome → request-permission). This module adds two more: a missing
// session binding (no ACP sessionId to prompt with) denies, and a correlation that never appears
// within the bounded wait lets request-permission deny. Nothing here ever approves silently.
//
// OFFLINE: this module spawns NO claude and bills nothing; the http server binds 127.0.0.1 only.

import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { findFreePort } from "../gate/port.js";
import { injectHook, restore, type Backup } from "../gate/settings-writer.js";
import { startHookServer, type ForwardedToolCall, type HookServer } from "./hook-server.js";
import {
  requestPermission,
  ToolUseCorrelator,
  type PermissionClient,
} from "./request-permission.js";
import { clearNativePrompt, type PtyWriter, type Schedule } from "./allow-inject.js";

/**
 * Substrings that evidence the native TUI permission prompt (the bordered "Do you want to
 * proceed?" box with numbered options), matched case-sensitively against the ANSI-stripped recent
 * PTY output. COPIED VERBATIM from the Degrau-0 billed probe (`experiments/e-gate.ts`
 * `NATIVE_PERMISSION_PROMPT_MARKERS`, claude 2.1.161) — the only empirical characterization of the
 * prompt's rendering we have. ANY hit ⇒ the native prompt is showing (#52822 reproduced).
 */
export const NATIVE_PERMISSION_PROMPT_MARKERS: readonly string[] = [
  "Do you want to proceed",
  "Do you want to allow",
  "Yes, and don't ask again",
  "Yes, allow",
  "1. Yes",
  "No, and tell Claude",
];

/** Strip CSI / common ANSI escape sequences so prompt markers match the plain text (e-gate probe). */
function stripAnsiText(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
}

/** True iff any native-prompt marker appears in `text` (after ANSI stripping). */
export function textShowsNativePrompt(text: string): boolean {
  const stripped = stripAnsiText(text);
  return NATIVE_PERMISSION_PROMPT_MARKERS.some((m) => stripped.includes(m));
}

/** Default bounded wait for the JSONL `tool_use` correlation to land after a hook fires (ms).
 *  The hook fires AFTER claude appended the assistant `tool_use` line, but the fs-watch → pump
 *  re-read is asynchronous — this window absorbs that lag. On expiry the decider proceeds and
 *  request-permission fails closed (deny) on the still-missing correlation. */
export const DEFAULT_CORRELATION_WAIT_MS = 5000;
/** Default poll interval for the correlation wait (ms). */
export const DEFAULT_CORRELATION_POLL_MS = 50;
/** Default window for the native prompt to APPEAR after an allow decision (#52822 sweep, ms).
 *  If no marker renders within it, allow-suppression held (the 2.1.161 case) — nothing to clear. */
export const DEFAULT_PROMPT_APPEAR_MS = 1500;
/** Default poll interval for the sweep's appear/clear phases (ms). */
export const DEFAULT_PROMPT_POLL_MS = 100;
/** Default budget for the keystroke to clear the prompt before the stuck warning (ms). */
export const DEFAULT_INJECT_TIMEOUT_MS = 2000;
/** Default bounded wait for the hook server to close on teardown (ms) — teardown never hangs on a
 *  socket held open by an in-flight decider; on expiry it warns and proceeds (the process-level
 *  close still completes in the background). */
export const DEFAULT_CLOSE_TIMEOUT_MS = 2000;
/** Cap on the retained rolling tail of recent PTY output (chars) for the prompt probe. */
const OUTPUT_TAIL_CAP = 16384;

/** Filename prefix of the per-session scratch settings file (diagnosable in `ls /tmp`). */
export const SCRATCH_SETTINGS_PREFIX = "fork-acp-gate-settings-";

/** The minimal PTY surface the gate needs: a raw writer (allow keystroke) and, when available, an
 *  `onData` tap feeding the native-prompt probe. Structurally satisfied by node-pty's IPty; the
 *  replay-only noop PTY also satisfies it (but replay-only sessions never get a gate). */
export interface GatePty extends PtyWriter {
  onData?(cb: (data: string) => void): { dispose(): void };
}

/** Options for {@link setupSessionGate}. Timing knobs are injectable for offline tests. */
export interface SessionGateOptions {
  /** The ACP client surface (`AgentSideConnection` satisfies it: `requestPermission(params)`). */
  client: PermissionClient;
  /** Diagnostics sink for every fail-closed / stuck-prompt warning (production: logger.error). */
  onWarn?: (message: string) => void;
  /** Injectable timer seam (same discipline as allow-inject/end-of-turn). Default: setTimeout. */
  schedule?: Schedule;
  /** Directory for the per-session scratch settings file. Default: `os.tmpdir()`. */
  settingsDir?: string;
  /** Hook timeout written into the scratch settings, in SECONDS (claude default 600). */
  hookTimeoutSeconds?: number;
  /** Hook-server decider budget (ms) before it fails closed; default per hook-server. */
  deciderTimeoutMs?: number;
  /** See {@link DEFAULT_CORRELATION_WAIT_MS}. */
  correlationWaitMs?: number;
  /** See {@link DEFAULT_CORRELATION_POLL_MS}. */
  correlationPollMs?: number;
  /** See {@link DEFAULT_PROMPT_APPEAR_MS}. */
  promptAppearMs?: number;
  /** See {@link DEFAULT_PROMPT_POLL_MS}. */
  promptPollMs?: number;
  /** See {@link DEFAULT_INJECT_TIMEOUT_MS}. */
  injectTimeoutMs?: number;
  /** See {@link DEFAULT_CLOSE_TIMEOUT_MS}. */
  closeTimeoutMs?: number;
  /** Injectable port allocator (default: the story-032 `findFreePort`). */
  findPort?: () => Promise<number>;
}

/** The per-session gate runtime handle `createSession` owns and `teardownSession` disposes. */
export interface SessionGate {
  /** The verified-free loopback port the hook server bound (== the port in the scratch hook URL). */
  port: number;
  /** Absolute path of the per-session scratch settings file (hand to the spawn as `--settings`). */
  settingsPath: string;
  /** The per-session `tool_use.id` correlation map. The live pump REGISTERS every JSONL `tool_use`
   *  id here (`correlator.register(id)`) so a hook call can be matched before it is approved. */
  correlator: ToolUseCorrelator;
  /**
   * Bind the AUTHORITATIVE ACP session id (known only AFTER the engine spawn on the fresh path)
   * and an optional `nudge` invoked on every hook arrival to force an immediate pump re-read
   * (shrinking the JSONL-correlation race). MUST be called before the first tool call can be
   * approved — an unbound gate fails closed (deny).
   */
  bindSession(sessionId: string, nudge?: () => void): void;
  /** Bind the live PTY: stores the raw writer for the allow keystroke and (when the PTY exposes
   *  `onData`) attaches the recent-output tap feeding the native-prompt probe. */
  bindPty(pty: GatePty): void;
  /** Idempotent teardown: close the hook server (bounded) and restore/delete the scratch settings.
   *  Safe to call from BOTH `teardownSession` and the PTY `onExit` hook. */
  teardown(): Promise<void>;
  /** True once {@link teardown} has run. */
  readonly isTorndown: boolean;
}

const defaultSchedule: Schedule = (fn, ms) => {
  setTimeout(fn, ms);
};

/** Internal mutable state of one session's gate. */
class SessionGateImpl implements SessionGate {
  port = 0;
  settingsPath = "";
  readonly correlator = new ToolUseCorrelator();

  private server?: HookServer;
  private backup?: Backup;
  private sessionId?: string;
  private nudge?: () => void;
  private pty?: PtyWriter;
  private outputTap?: { dispose(): void };
  /** Rolling tail of recent PTY output + absolute count of chars ever appended (probe offsets). */
  private outputTail = "";
  private totalOutput = 0;
  private torndown = false;

  constructor(private readonly opts: SessionGateOptions) {}

  get isTorndown(): boolean {
    return this.torndown;
  }

  private warn(message: string): void {
    this.opts.onWarn?.(message);
  }

  private get schedule(): Schedule {
    return this.opts.schedule ?? defaultSchedule;
  }

  /** Start the hook server, then write the scratch settings (server first, so the URL the settings
   *  point at is live before claude can ever read them; settings BEFORE the spawn is the caller's
   *  ordering contract — blocker c). */
  async start(): Promise<void> {
    const findPort = this.opts.findPort ?? findFreePort;
    this.port = await findPort();

    this.server = await startHookServer({
      port: this.port,
      deciderTimeoutMs: this.opts.deciderTimeoutMs,
      onWarn: (m) => this.warn(m),
      onToolCall: (call) => this.decide(call),
    });

    const dir = this.opts.settingsDir ?? os.tmpdir();
    this.settingsPath = path.join(dir, `${SCRATCH_SETTINGS_PREFIX}${randomUUID()}.json`);
    try {
      this.backup = await injectHook({
        settingsPath: this.settingsPath,
        port: this.port,
        timeout: this.opts.hookTimeoutSeconds,
      });
    } catch (err) {
      // The settings write failed AFTER the server bound — close it before surfacing, so a failed
      // gate setup leaks nothing (the caller aborts createSession; FORK_GATE=off is the escape hatch).
      await this.closeServerBounded();
      throw err;
    }
  }

  bindSession(sessionId: string, nudge?: () => void): void {
    this.sessionId = sessionId;
    this.nudge = nudge;
  }

  bindPty(pty: GatePty): void {
    this.pty = pty;
    if (typeof pty.onData === "function") {
      this.outputTap = pty.onData((data: string) => {
        this.totalOutput += data.length;
        this.outputTail = (this.outputTail + data).slice(-OUTPUT_TAIL_CAP);
      });
    }
  }

  /** Bytes received after the absolute output offset `mark` (clipped to the retained tail). */
  private outputSince(mark: number): string {
    const available = Math.min(this.outputTail.length, Math.max(0, this.totalOutput - mark));
    return available === 0 ? "" : this.outputTail.slice(-available);
  }

  /**
   * The REAL decider chain (the hook→ACP connection): nudge the pump → bounded-wait for the JSONL
   * `tool_use.id` correlation → raise ACP `session/request_permission` (story 033, fail-closed) →
   * on `allow`, arm the #52822 native-prompt sweep. Every deny path is request-permission's own.
   */
  private async decide(call: ForwardedToolCall): Promise<"allow" | "deny"> {
    if (this.torndown) return "deny"; // a hook racing teardown is never approved

    // Kick the pump so the freshest JSONL (carrying this call's `tool_use` line) is re-read NOW.
    try {
      this.nudge?.();
    } catch {
      // a nudge failure only widens the correlation wait below; never approves/denies by itself
    }

    const sessionId = this.sessionId ?? call.sessionId;
    if (!sessionId) {
      this.warn(
        `[gate §9] FAIL CLOSED: PreToolUse for tool_use ${call.toolUseId} arrived before the gate ` +
          `was bound to an ACP session — denying (cannot raise session/request_permission).`,
      );
      return "deny";
    }

    await this.waitForCorrelation(call.toolUseId);

    const decision = await requestPermission({
      client: this.opts.client,
      sessionId,
      toolCall: {
        toolUseId: call.toolUseId,
        toolName: call.toolName,
        toolInput: call.toolInput,
      },
      correlator: this.correlator,
      onWarn: (m) => this.warn(m),
    });

    if (decision === "allow") {
      // Return the allow body FIRST (claude is blocked on this response); sweep out of band.
      this.armAllowSweep(call);
    }
    return decision;
  }

  /** Bounded poll until the pump has registered `toolUseId` as a clean single JSONL match. On
   *  expiry, resolve anyway — `requestPermission` then fails closed on the missing correlation. */
  private waitForCorrelation(toolUseId: string): Promise<void> {
    const waitMs = this.opts.correlationWaitMs ?? DEFAULT_CORRELATION_WAIT_MS;
    const pollMs = this.opts.correlationPollMs ?? DEFAULT_CORRELATION_POLL_MS;
    if (this.correlator.isCleanMatch(toolUseId)) return Promise.resolve();
    return new Promise((resolve) => {
      let elapsed = 0;
      const poll = (): void => {
        if (this.torndown || this.correlator.isCleanMatch(toolUseId)) {
          resolve();
          return;
        }
        elapsed += pollMs;
        if (elapsed >= waitMs) {
          this.warn(
            `[gate §9] correlation wait expired (${waitMs}ms) for tool_use ${toolUseId} — the JSONL ` +
              `tool_use line never reached the pump; the decision will fail closed (deny).`,
          );
          resolve();
          return;
        }
        this.schedule(poll, pollMs);
      };
      this.schedule(poll, pollMs);
    });
  }

  /**
   * #52822 sweep (allow path, best-effort by design): wait a bounded window for the native TUI
   * prompt to APPEAR in the post-decision PTY output; if it never renders, allow-suppression held
   * (the 2.1.161 case) and nothing is typed. If it renders, clear it via the story-033
   * `clearNativePrompt` — the `'1\r'` keystroke goes RAW through `pty.write` (never `sendPrompt`,
   * whose leading Ctrl+U clear byte must not touch a pending dialog). On a stuck prompt it WARNS
   * and holds — never a silent approve (R3.2).
   *
   * Post-keystroke probe semantics (honest limits): the prompt counts as CLEARED only when NEW
   * output arrives after the keystroke and carries no prompt marker (the TUI re-rendered past the
   * dialog). Zero new output ⇒ still shown ⇒ the stuck warning fires at the timeout. A re-rendered
   * marker ⇒ still shown. This is a byte-stream heuristic over the Degrau-0 markers — the live
   * fidelity check is story 034's acceptance run.
   */
  private armAllowSweep(call: ForwardedToolCall): void {
    const pty = this.pty;
    if (!pty) {
      this.warn(
        `[gate §9] allow for tool_use ${call.toolUseId}: no PTY bound — cannot run the #52822 ` +
          `keystroke sweep; if the native prompt appears it needs a manual keystroke.`,
      );
      return;
    }
    const appearMs = this.opts.promptAppearMs ?? DEFAULT_PROMPT_APPEAR_MS;
    const pollMs = this.opts.promptPollMs ?? DEFAULT_PROMPT_POLL_MS;
    const appearMark = this.totalOutput; // only output AFTER the allow decision is scanned

    let elapsed = 0;
    const pollAppear = (): void => {
      if (this.torndown) return;
      if (textShowsNativePrompt(this.outputSince(appearMark))) {
        void this.runClear(call, pty);
        return;
      }
      elapsed += pollMs;
      if (elapsed >= appearMs) return; // suppressed (the 2.1.161 case) — nothing to clear
      this.schedule(pollAppear, pollMs);
    };
    this.schedule(pollAppear, pollMs);
  }

  /** Drive the story-033 keystroke injection against the live output probe (see armAllowSweep). */
  private async runClear(call: ForwardedToolCall, pty: PtyWriter): Promise<void> {
    let keystrokeMark: number | null = null;
    const isPromptShown = (): boolean => {
      if (keystrokeMark === null) {
        // First probe (pre-keystroke): the appear-poll already proved the prompt is up. Mark the
        // output offset so the post-keystroke probes scan only the TUI's REACTION to the keystroke.
        keystrokeMark = this.totalOutput;
        return true;
      }
      if (this.totalOutput === keystrokeMark) return true; // TUI has not reacted yet — still shown
      return textShowsNativePrompt(this.outputSince(keystrokeMark));
    };

    const result = await clearNativePrompt({
      pty,
      decision: "allow",
      isPromptShown,
      timeoutMs: this.opts.injectTimeoutMs ?? DEFAULT_INJECT_TIMEOUT_MS,
      pollMs: this.opts.promptPollMs ?? DEFAULT_PROMPT_POLL_MS,
      schedule: this.schedule,
      onWarn: (m) => this.warn(m),
    });
    if (result.status === "stuck") {
      // clearNativePrompt already warned; name the tool here for the session log's correlation.
      this.warn(
        `[gate §9] STUCK PROMPT for tool_use ${call.toolUseId} (tool "${call.toolName}") — the ` +
          `allow keystroke did not clear the native prompt; holding (no silent approve).`,
      );
    }
  }

  /** Close the hook server with a bounded wait so teardown never hangs on an in-flight request. */
  private async closeServerBounded(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    const closeTimeoutMs = this.opts.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
    let timedOut = false;
    await Promise.race([
      server.close(),
      new Promise<void>((resolve) =>
        this.schedule(() => {
          timedOut = true;
          resolve();
        }, closeTimeoutMs),
      ),
    ]);
    if (timedOut) {
      this.warn(
        `[gate §9] hook server on 127.0.0.1:${this.port} did not close within ${closeTimeoutMs}ms ` +
          `(an in-flight decider may be holding a request open); teardown proceeds — the close ` +
          `completes in the background.`,
      );
    }
  }

  async teardown(): Promise<void> {
    if (this.torndown) return;
    this.torndown = true;

    this.outputTap?.dispose();
    this.outputTap = undefined;

    await this.closeServerBounded();

    const backup = this.backup;
    this.backup = undefined;
    if (backup) {
      try {
        await restore(backup); // scratch was created by injectHook (existed:false) → deleted here
      } catch (err) {
        this.warn(
          `[gate §9] scratch settings restore failed for ${backup.settingsPath} ` +
            `(${err instanceof Error ? err.message : String(err)}) — the file may need manual removal.`,
        );
      }
    }
  }
}

/**
 * Set up the per-session HYBRID gate runtime (story 034 wiring): allocate a verified-free loopback
 * port, start the fail-closed `PreToolUse` hook server with the REAL story-033 decider chain, and
 * write the per-session scratch settings file the spawn consumes via `--settings "<file>"`.
 *
 * ORDERING CONTRACT (GATE_FINDINGS blocker c): the caller MUST `await setupSessionGate(...)` and
 * pass {@link SessionGate.settingsPath} to the spawn BEFORE the claude PTY is spawned — claude reads
 * settings only at startup, so a late write misses the first tool call. After the spawn the caller
 * binds the authoritative session id ({@link SessionGate.bindSession}) and the live PTY
 * ({@link SessionGate.bindPty}), and disposes via {@link SessionGate.teardown} on session teardown
 * AND PTY exit (idempotent).
 *
 * On a setup failure (port exhaustion, bind error, settings write error) the promise REJECTS with
 * everything already cleaned up — the caller fails the session creation LOUDLY rather than spawning
 * an ungated claude that LOOKS gated (the blocker-b hazard). `FORK_GATE=off` is the escape hatch.
 */
export async function setupSessionGate(opts: SessionGateOptions): Promise<SessionGate> {
  const gate = new SessionGateImpl(opts);
  await gate.start();
  return gate;
}
