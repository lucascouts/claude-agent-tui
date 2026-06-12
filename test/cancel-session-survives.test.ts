// Story 034 (live-acceptance fix, R2.3) — the session SURVIVES a cancel.
//
// The G2 live acceptance (sessions 22e2672c / 6262610a) proved the story-031 WARNING: the live TUI
// aborts the turn on Ctrl+C WITHOUT exiting, so `engine.isDisposed` never reads as "yielded" and the
// cancel ladder always escalated to p.kill() — every live cancel killed the session, and the next
// prompt vanished into a dead PTY (silent post-exit-safe write + a stall-watchdog hang).
//
// Corrected semantics (this fix):
//   1. The cancel ladder is Ctrl+C → Esc and STOPS — it NEVER auto-kills a live PTY. kill() remains
//      the teardown path (closing the thread), not a cancel step. (§8 asked only for \x03.)
//   2. After a cancel, the next session/prompt submits into the still-alive PTY (R2.3).
//   3. prompt() on a session whose engine IS disposed rejects immediately with a legible error —
//      never a silent no-op write that hangs until the stall watchdog.
//
// node:test: build first, then
//   node --experimental-strip-types --test test/cancel-session-survives.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeAcpAgent } from "../dist/acp-agent.js";
import { SessionEngine } from "../dist/engine-lifecycle.js";
import { makeFakePty, makeFakeWatcher } from "./lifecycle-fakes.ts";

const ESCALATION_MS = 100;

function makeClock() {
  let now = 0;
  const timers: Array<{ at: number; fn: () => void; cancelled: boolean }> = [];
  const schedule = (fn: () => void, ms: number) => {
    const t = { at: now + ms, fn, cancelled: false };
    timers.push(t);
    return () => {
      t.cancelled = true;
    };
  };
  const advance = (ms: number) => {
    now += ms;
    for (const t of [...timers].sort((a, b) => a.at - b.at)) {
      if (!t.cancelled && t.at <= now) {
        t.cancelled = true;
        t.fn();
      }
    }
  };
  return { schedule, advance };
}

/** Reject after `ms` of REAL time so a hanging prompt fails fast instead of stalling the suite. */
function rejectAfter(ms: number): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`did not settle within ${ms}ms`)), ms).unref?.(),
  ) as Promise<never>;
}

function makeAgent(deps: any = {}) {
  const client: any = { async sessionUpdate() {} };
  const agent: any = new ClaudeAcpAgent(client, console, undefined, {
    cancelEscalationMs: ESCALATION_MS,
    ...deps,
  });
  return { agent };
}

function injectLiveSession(agent: any, sid: string) {
  const fp = makeFakePty();
  const { watcher } = makeFakeWatcher();
  const engine = new SessionEngine({ handle: { sessionId: sid, pty: fp.pty }, watcher });
  agent.sessions[sid] = {
    pty: fp.pty,
    engine,
    emitted: new Set(),
    cancelled: false,
    cwd: "/tmp/x",
    toolUseCache: {},
    guardChecked: false,
    settingsManager: { dispose() {} },
    watcher,
    turnCancel: () => {}, // an in-flight turn is present so the ladder actually runs
  };
  return { session: agent.sessions[sid], calls: fp.calls, fireExit: fp.fireExit };
}

const SID = "sess-034-survives";

test("the cancel ladder NEVER auto-kills a live PTY: Ctrl+C → Esc → stop (R2.3)", async () => {
  const { schedule, advance } = makeClock();
  const { agent } = makeAgent({ schedule });
  const { calls } = injectLiveSession(agent, SID);

  await agent.cancel({ sessionId: SID });
  assert.deepEqual(calls.write, ["\x03"], "Ctrl+C first");

  advance(ESCALATION_MS); // window 1 elapses → Esc (safe: a no-op on an idle TUI)
  assert.deepEqual(calls.write, ["\x03", "\x1b"], "Esc is still the second rung");

  advance(ESCALATION_MS * 10); // far past every former window
  assert.equal(calls.kill, 0, "kill is NOT a cancel rung — a live session must survive its cancel");
});

test("after a cancel, the next session/prompt submits into the still-alive PTY (R2.3)", async () => {
  const { schedule, advance } = makeClock();
  const { agent } = makeAgent({ schedule });
  const { session, calls } = injectLiveSession(agent, SID);

  await agent.cancel({ sessionId: SID });
  advance(ESCALATION_MS * 10); // the full ladder ran; the PTY must still be alive
  assert.equal(calls.kill, 0, "precondition: the cancel did not kill the PTY");

  session.cancelled = false; // a new turn begins after the cancelled one settled
  const next = agent.prompt({ sessionId: SID, prompt: [{ type: "text", text: "ainda vivo?" }] });
  advance(60); // the §8 write→\r submission delay
  assert.ok(
    calls.write.some((w: string) => w.includes("ainda vivo?")),
    "the post-cancel prompt reaches the live PTY",
  );

  await agent.cancel({ sessionId: SID }); // housekeeping: settle the pending turn
  assert.deepEqual(await Promise.race([next, rejectAfter(1000)]), { stopReason: "cancelled" });
});

test("every submission CLEARS residual TUI input first: Ctrl+U precedes the payload (034 G2 contamination fix)", async () => {
  // The G2 re-runs (sessions 76fbf771 and 78e56a85) proved the TUI RESTORES a cancelled prompt into
  // its input box: the next submission concatenated both texts into one user event ("Conte de 1 a
  // 100…Qual o nome…"). Esc was the first candidate and was REFUTED live; experiments/e-clear.ts
  // proved Ctrl+U (\x15, kill-line) empties the box. sendPrompt therefore leads with a lone Ctrl+U
  // (no-op on an empty box), then writes the payload after a settle delay, then the §8 \r.
  const { schedule, advance } = makeClock();
  const { agent } = makeAgent({ schedule });
  const { session, calls } = injectLiveSession(agent, SID);

  const p = agent.prompt({ sessionId: SID, prompt: [{ type: "text", text: "limpo?" }] });
  await Promise.resolve();
  assert.deepEqual(calls.write, ["\x15"], "a lone Ctrl+U is the FIRST byte — clearing any residual input");

  advance(60); // settle delay → the payload follows as its own write
  assert.deepEqual(calls.write, ["\x15", "limpo?"], "the payload is written separately, after the clear settles");

  advance(60); // §8 submission delay → \r
  assert.deepEqual(calls.write, ["\x15", "limpo?", "\r"], "the submit \\r still closes the sequence");

  await agent.cancel({ sessionId: SID }); // housekeeping: settle the pending turn
  assert.deepEqual(await Promise.race([p, rejectAfter(1000)]), { stopReason: "cancelled" });
  void session;
});

test("prompt() on a DISPOSED engine rejects immediately with a legible error — no stall-watchdog hang", async () => {
  const { schedule } = makeClock();
  const { agent } = makeAgent({ schedule });
  const { fireExit } = injectLiveSession(agent, SID);

  fireExit({ exitCode: 0, signal: 0 }); // the PTY exited (e.g. user killed it / crash) → engine disposed

  await assert.rejects(
    () =>
      Promise.race([
        agent.prompt({ sessionId: SID, prompt: [{ type: "text", text: "para um morto" }] }),
        rejectAfter(1000),
      ]),
    /disposed|exited/i,
    "a prompt into a dead engine fails fast and legibly, never silently hanging",
  );
});
