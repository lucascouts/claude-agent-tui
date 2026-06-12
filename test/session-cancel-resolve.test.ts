// Story 031 / Task 1.1 — session/cancel resolves the in-flight prompt 'cancelled' exactly once.
//
// Wires ACP session/cancel to the inert cancel seams that already exist: the story-024 single-
// resolution latch (createTurnResolver) and the markCancelled() detector seam. The work is split:
//   (a) end-of-turn.ts: a new TurnResolver.cancel() that CLAIMS the story-024 latch to resolve
//       PromptResponse{stopReason:'cancelled'} and calls detector.markCancelled() (clears Δt +
//       watchdog so the detector cannot also fire). It does NOT re-implement the latch — it calls it.
//   (b) acp-agent.ts: the cancel() handler looks up the in-flight turn's stored cancel and drives it
//       (no-op when no turn is in-flight, when the turn already cancelled, or for an unknown session).
// The latch is the arbiter: a second cancel, OR a normal end-of-turn arriving after cancel, never
// produces a second resolution. (R1.1 wiring, R1.3, R2.1, R2.2, R2.3, R3.1, R3.2, R3.3.)
//
// PTY interrupt escalation (Ctrl+C → Esc → kill) is Task 2; this file pins the RESOLUTION only.
//
// node:test: build first, then
//   node --experimental-strip-types --test test/session-cancel-resolve.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeAcpAgent } from "../dist/acp-agent.js";
import { createTurnResolver } from "../dist/end-of-turn.js";

/** Deterministic fake clock — pending callbacks fire only on advance() (mirrors the 024/030 harness). */
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

/** Reject after `ms` of REAL time so an unwired cancel (pending prompt) fails fast as Red, not a hang. */
function rejectAfter(ms: number): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`prompt did not resolve within ${ms}ms — cancel not wired`)), ms).unref?.(),
  ) as Promise<never>;
}

const asst = (stop_reason: unknown, uuid: string) => ({
  type: "assistant",
  uuid,
  message: { stop_reason },
});

function makeAgent(deps: any = {}) {
  const updates: unknown[] = [];
  const client: any = {
    async sessionUpdate(u: unknown) {
      updates.push(u);
    },
  };
  const agent: any = new ClaudeAcpAgent(client, console, undefined, deps);
  return { agent, updates };
}

function fakePty() {
  const writes: string[] = [];
  return {
    writes,
    write: (d: string) => {
      writes.push(d);
    },
    onData: () => ({ dispose() {} }),
    onExit: () => ({ dispose() {} }),
    kill: () => {},
    resize: () => {},
  };
}

function injectSession(agent: any, sid: string, pty: any) {
  agent.sessions[sid] = {
    pty,
    emitted: new Set(),
    cancelled: false,
    cwd: "/tmp/x",
    toolUseCache: {},
    guardChecked: false,
    settingsManager: { dispose() {} },
    watcher: undefined,
  };
  return agent.sessions[sid];
}

const SID = "sess-031-cancel";

// ── Resolver seam (end-of-turn.ts): TurnResolver.cancel() claims the 024 latch ──────────────────

test("resolver.cancel() resolves the pending prompt with {stopReason:'cancelled'} (R2.1, R2.2)", async () => {
  const { schedule } = makeClock();
  const { detector, promise, cancel } = createTurnResolver({ schedule });
  detector.beginTurn();
  cancel();
  assert.deepEqual(await promise, { stopReason: "cancelled" });
});

test("resolver.cancel() marks the detector cancelled — a later terminal event cannot re-resolve (R3.1, R3.2)", async () => {
  const { schedule, advance } = makeClock();
  const { detector, promise, cancel } = createTurnResolver({ schedule });
  detector.beginTurn();
  detector.observe(asst("tool_use", "u0")); // mid-turn, non-terminal
  cancel();
  // A terminal stop_reason arriving AFTER cancel must not fire end-of-turn (markCancelled cleared the
  // Δt timer + the 5583ms watchdog and latched the detector).
  detector.observe(asst("end_turn", "u1"));
  advance(10000); // past Δt (200ms) and the turn watchdog (5583ms)
  assert.deepEqual(await promise, { stopReason: "cancelled" }, "stays cancelled — detector suppressed");
});

test("a second resolver.cancel() is a no-op — exactly one resolution (R2.3)", async () => {
  const { schedule } = makeClock();
  const { detector, promise, cancel } = createTurnResolver({ schedule });
  detector.beginTurn();
  cancel();
  assert.doesNotThrow(() => cancel(), "a repeat cancel must not throw");
  assert.deepEqual(await promise, { stopReason: "cancelled" });
});

test("detector resolves normally FIRST → a late resolver.cancel() does not override it (R3.3)", async () => {
  const { schedule, advance } = makeClock();
  const { detector, promise, cancel } = createTurnResolver({ schedule });
  detector.beginTurn();
  detector.observe(asst("end_turn", "u1"));
  advance(200); // Δt quiescence → normal resolution
  assert.deepEqual(await promise, { stopReason: "end_turn" });
  assert.doesNotThrow(() => cancel(), "a late cancel after a normal resolve is a no-op, not a throw");
  assert.deepEqual(await promise, { stopReason: "end_turn" }, "the normal resolution stands");
});

// ── Handler (acp-agent.ts): cancel() drives the in-flight turn's stored cancel ───────────────────

test("agent.cancel() resolves the in-flight prompt as 'cancelled' (R1.1 wiring, R2.1)", async () => {
  const { schedule } = makeClock();
  const { agent } = makeAgent({ schedule });
  injectSession(agent, SID, fakePty());

  const p = agent.prompt({ sessionId: SID, prompt: [{ type: "text", text: "hi" }] });
  await Promise.resolve(); // flush prompt()'s synchronous submit + turn registration
  await agent.cancel({ sessionId: SID });

  assert.deepEqual(await Promise.race([p, rejectAfter(1000)]), { stopReason: "cancelled" });
});

test("a second agent.cancel() performs zero further resolutions and does not throw (R2.3)", async () => {
  const { schedule } = makeClock();
  const { agent } = makeAgent({ schedule });
  injectSession(agent, SID, fakePty());

  const p = agent.prompt({ sessionId: SID, prompt: [{ type: "text", text: "hi" }] });
  await Promise.resolve();
  await agent.cancel({ sessionId: SID });
  assert.deepEqual(await Promise.race([p, rejectAfter(1000)]), { stopReason: "cancelled" });

  await assert.doesNotReject(() => agent.cancel({ sessionId: SID }), "a repeat session/cancel is a no-op");
});

test("agent.cancel() with no in-flight turn resolves nothing and does not throw (R1.3, R2.3)", async () => {
  const { schedule } = makeClock();
  const { agent } = makeAgent({ schedule });
  injectSession(agent, SID, fakePty());
  await assert.doesNotReject(() => agent.cancel({ sessionId: SID }), "no in-flight turn → silent no-op");
});

test("agent.cancel() for an unknown session is a no-op (R1.3)", async () => {
  const { schedule } = makeClock();
  const { agent } = makeAgent({ schedule });
  await assert.doesNotReject(() => agent.cancel({ sessionId: "does-not-exist" }));
});
