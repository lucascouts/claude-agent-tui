// Story 031 / Task 2.1 — PTY interrupt escalation on session/cancel: Ctrl+C → Esc (NO kill).
//
// After Task 1 resolves the pending prompt as 'cancelled', the cancel handler best-effort STOPS the
// underlying claude TUI via the story-014 primitives: interrupt() (\x03) immediately, then — only if
// the PTY has not exited within a short local window — escape() (\x1b). The ladder ENDS there.
//
// REVISED by the story-034 live acceptance (R2.3): the original ladder ended in p.kill(), gated on
// "the turn yields" == the PTY exiting (engine.isDisposed) — the story-031 WARNING. The G2 live run
// proved the live TUI aborts the turn on Ctrl+C WITHOUT exiting, so isDisposed never reads as
// yielded and the kill rung killed EVERY live cancelled session, orphaning the next prompt. kill()
// is a teardown concern, never a cancel rung (§8 asked only for \x03). The escalation window is a
// short LOCAL timeout, distinct from the turn watchdog (NOT re-derived here). (R1.2, R1.3.)
//
// The escalation window is injected via AgentDeps.cancelEscalationMs (the same seam style as the
// `schedule` clock) so the fake clock drives it deterministically — the test pins no production value.
// node:test: build first, then
//   node --experimental-strip-types --test test/cancel-escalation.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeAcpAgent } from "../dist/acp-agent.js";
import { SessionEngine } from "../dist/engine-lifecycle.js";
import { makeFakePty, makeFakeWatcher } from "./lifecycle-fakes.ts";

/** Injected escalation window (ms) — the test drives the fake clock by exactly this. */
const ESCALATION_MS = 100;

/** Deterministic fake clock driving the escalation windows; callbacks fire only on advance(). */
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

function makeAgent(deps: any = {}) {
  const client: any = {
    async sessionUpdate() {},
  };
  const agent: any = new ClaudeAcpAgent(client, console, undefined, {
    cancelEscalationMs: ESCALATION_MS,
    ...deps,
  });
  return { agent };
}

/**
 * Inject a session carrying an IN-FLIGHT turn (stub `turnCancel`, so R1.1 holds) plus a real
 * SessionEngine wrapping a fake PTY — the "stubbed engine handle" whose interrupt/escape/kill/
 * isDisposed are the story-014 primitives under test. Returns the PTY call log + the exit trigger.
 */
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
    turnCancel: () => {}, // an in-flight turn is present (R1.1); the resolution itself is Task 1's test
  };
  return { session: agent.sessions[sid], calls: fp.calls, fireExit: fp.fireExit };
}

const SID = "sess-031-escalation";

test("session/cancel writes Ctrl+C (\\x03) to the PTY first, before any escalation (R1.2)", async () => {
  const { schedule } = makeClock();
  const { agent } = makeAgent({ schedule });
  const { calls } = injectLiveSession(agent, SID);

  await agent.cancel({ sessionId: SID });

  assert.deepEqual(calls.write, ["\x03"], "interrupt() writes \\x03 synchronously; no escalation yet");
  assert.equal(calls.kill, 0, "no kill before the escalation window elapses");
});

test("when the PTY stays alive, escalate to Esc (\\x1b) and STOP — kill is never a cancel rung (R1.2, 034/R2.3)", async () => {
  const { schedule, advance } = makeClock();
  const { agent } = makeAgent({ schedule });
  const { calls } = injectLiveSession(agent, SID);

  await agent.cancel({ sessionId: SID });
  assert.deepEqual(calls.write, ["\x03"], "Ctrl+C first");

  advance(ESCALATION_MS); // PTY still alive past window 1 → Esc
  assert.deepEqual(calls.write, ["\x03", "\x1b"], "escalates to Esc when the PTY has not exited");
  assert.equal(calls.kill, 0, "not killed after Esc");

  advance(ESCALATION_MS * 10); // far past every former window — the ladder has ended
  assert.equal(calls.kill, 0, "NEVER escalates to p.kill(): a live session survives its cancel");
  assert.deepEqual(calls.write, ["\x03", "\x1b"], "no further byte writes after Esc");
});

test("when the turn yields (PTY exits) after Ctrl+C, no escalation occurs (R1.2, R1.3)", async () => {
  const { schedule, advance } = makeClock();
  const { agent } = makeAgent({ schedule });
  const { calls, fireExit } = injectLiveSession(agent, SID);

  await agent.cancel({ sessionId: SID });
  assert.deepEqual(calls.write, ["\x03"], "Ctrl+C was sent");

  fireExit({ exitCode: 0, signal: 0 }); // the turn yielded → PTY exited → engine disposed
  advance(ESCALATION_MS * 4); // well past both windows

  assert.deepEqual(calls.write, ["\x03"], "no Esc — the ladder halts once the PTY yields");
  assert.equal(calls.kill, 0, "no kill — the ladder halts once the PTY yields");
});

test("session/cancel after the PTY has already exited is inert: zero writes/kills, no throw (R1.3)", async () => {
  const { schedule, advance } = makeClock();
  const { agent } = makeAgent({ schedule });
  const { calls, fireExit } = injectLiveSession(agent, SID);

  fireExit({ exitCode: 0, signal: 0 }); // PTY exited BEFORE the cancel
  await assert.doesNotReject(() => agent.cancel({ sessionId: SID }), "cancel after exit must not throw");
  advance(ESCALATION_MS * 4);

  assert.deepEqual(calls.write, [], "no bytes written to a dead PTY");
  assert.equal(calls.kill, 0, "no kill issued to a dead PTY");
});

test("session/cancel with no in-flight turn does not interrupt the PTY (R1.3)", async () => {
  const { schedule, advance } = makeClock();
  const { agent } = makeAgent({ schedule });
  const { session, calls } = injectLiveSession(agent, SID);
  session.turnCancel = undefined; // no in-flight turn

  await agent.cancel({ sessionId: SID });
  advance(ESCALATION_MS * 4);

  assert.deepEqual(calls.write, [], "no Ctrl+C when there is no in-flight turn to interrupt");
  assert.equal(calls.kill, 0, "no kill when there is no in-flight turn");
});
