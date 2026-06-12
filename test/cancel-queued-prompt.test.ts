// Story 031 / Task 3.2 — Integration: queued-prompt safety under cancel.
//
// Cancelling the in-flight turn must settle ONLY that turn (via its own story-024 latch) and must NOT
// resolve a prompt queued behind it. The queued prompt then starts as its OWN turn with its own pending
// resolution and its own end-of-turn detection, proving the two turns carry DISTINCT latches (R4.1, R4.2).
//
// The agent has no internal prompt queue — ACP serialises session/prompt, so a queued prompt is not yet
// the in-flight turn. It is modelled here by its own createTurnResolver (the SAME factory prompt() uses
// internally), unregistered on the session record until the in-flight turn ends and it is promoted.
// node:test: build first, then
//   node --experimental-strip-types --test test/cancel-queued-prompt.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeAcpAgent } from "../dist/acp-agent.js";
import { createTurnResolver } from "../dist/end-of-turn.js";

/** Deterministic fake clock — pending callbacks fire only on advance() (mirrors the 024/030/031 harness). */
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

/** Reject after `ms` of REAL time so a never-resolving prompt fails fast instead of hanging the suite. */
function rejectAfter(ms: number): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`prompt did not resolve within ${ms}ms`)), ms).unref?.(),
  ) as Promise<never>;
}

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

const SID = "sess-031-queued";
const asst = (stop_reason: unknown, uuid: string) => ({ type: "assistant", uuid, message: { stop_reason } });

test("session/cancel settles ONLY the in-flight turn; the queued resolver stays pending (R4.1)", async () => {
  const { schedule } = makeClock();
  const { agent } = makeAgent({ schedule });
  injectSession(agent, SID, fakePty());

  // The in-flight turn via the real prompt() path.
  const inflight = agent.prompt({ sessionId: SID, prompt: [{ type: "text", text: "first" }] });
  await Promise.resolve();

  // A second prompt QUEUED behind it — its own resolver, not yet promoted to the in-flight turn.
  const queued = createTurnResolver({ schedule });
  queued.detector.beginTurn();
  let queuedSettled = false;
  void queued.promise.then(() => {
    queuedSettled = true;
  });

  await agent.cancel({ sessionId: SID });

  assert.deepEqual(await Promise.race([inflight, rejectAfter(1000)]), { stopReason: "cancelled" });
  await Promise.resolve(); // give any erroneous queued resolution a chance to surface
  assert.equal(queuedSettled, false, "the queued prompt's resolver is untouched by the cancel");

  queued.cancel(); // housekeeping: settle the modelled queued turn so no resolver is left pending
});

test("the queued prompt then runs as its own turn and resolves on its own latch (R4.2)", async () => {
  const { schedule, advance } = makeClock();
  const { agent } = makeAgent({ schedule });
  const session = injectSession(agent, SID, fakePty());

  const inflight = agent.prompt({ sessionId: SID, prompt: [{ type: "text", text: "first" }] });
  await Promise.resolve();

  const queued = createTurnResolver({ schedule });
  queued.detector.beginTurn();

  await agent.cancel({ sessionId: SID });
  assert.deepEqual(await Promise.race([inflight, rejectAfter(1000)]), { stopReason: "cancelled" });

  // Promote the queued prompt to the in-flight turn: it now owns the record's detector + cancel.
  session.turnDetector = queued.detector;
  session.turnCancel = queued.cancel;

  // It reaches a normal terminal stop_reason and resolves once, on its OWN end-of-turn signal — never
  // the cancelled turn's resolution. Distinct latches.
  queued.detector.observe(asst("end_turn", "q1"));
  advance(200); // Δt quiescence on the queued turn
  assert.deepEqual(
    await Promise.race([queued.promise, rejectAfter(1000)]),
    { stopReason: "end_turn" },
    "the queued turn resolves via its own latch",
  );
});
