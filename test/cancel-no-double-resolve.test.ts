// Story 031 / Task 3.1 — Integration: prompt-then-cancel resolves EXACTLY ONCE as 'cancelled', and
// the E3 end-of-turn detector can never also resolve the same turn — in EITHER ordering.
//
// Drives the real prompt() path (story 030) to start an in-flight turn, then issues session/cancel and
// asserts: (a) the single PromptResponse carries stopReason:'cancelled' (R2.1, R2.2); (b) a terminal
// stop_reason arriving AFTER cancel — via the detector the live pump feeds — yields NO second
// resolution: the story-024 single-resolution latch is held and markCancelled() cleared the Δt timer
// + the 5583ms watchdog (R3.1, R3.2); (c) the REVERSED ordering — the detector resolves the turn
// normally FIRST — makes a subsequent session/cancel a silent no-op (R3.3). The cancel/detector race
// is the hard correctness property of the story.
//
// The end-of-turn signal is STUBBED by driving session.turnDetector directly (the seam the live pump
// feeds). The agent's `schedule` is an injected fake clock shared by sendPrompt + the resolver.
// node:test: build first, then
//   node --experimental-strip-types --test test/cancel-no-double-resolve.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeAcpAgent } from "../dist/acp-agent.js";

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

const SID = "sess-031-no-double";
const asst = (stop_reason: unknown, uuid: string) => ({ type: "assistant", uuid, message: { stop_reason } });

test("prompt then session/cancel → exactly one PromptResponse{stopReason:'cancelled'} (R2.1, R2.2)", async () => {
  const { schedule } = makeClock();
  const { agent } = makeAgent({ schedule });
  injectSession(agent, SID, fakePty());

  const p = agent.prompt({ sessionId: SID, prompt: [{ type: "text", text: "a long task" }] });
  await Promise.resolve(); // flush prompt()'s synchronous submit + turn registration
  await agent.cancel({ sessionId: SID });

  assert.deepEqual(await Promise.race([p, rejectAfter(1000)]), { stopReason: "cancelled" });
});

test("a terminal stop_reason AFTER cancel does NOT re-resolve the cancelled turn (R3.1, R3.2)", async () => {
  const { schedule, advance } = makeClock();
  const { agent } = makeAgent({ schedule });
  const session = injectSession(agent, SID, fakePty());

  const p = agent.prompt({ sessionId: SID, prompt: [{ type: "text", text: "a long task" }] });
  await Promise.resolve();
  const detector = session.turnDetector; // capture the in-flight detector before prompt()'s finally clears it
  detector.observe(asst("tool_use", "u0")); // mid-turn, non-terminal
  await agent.cancel({ sessionId: SID });
  assert.deepEqual(await Promise.race([p, rejectAfter(1000)]), { stopReason: "cancelled" });

  // A terminal stop_reason landing in the tail after cancel, plus a full Δt + watchdog advance: the
  // latch is held and markCancelled() cleared the timers, so the turn stays cancelled — no 2nd resolution.
  detector.observe(asst("end_turn", "u1"));
  advance(10000); // well past Δt (200ms) and the 5583ms turn watchdog
  assert.deepEqual(await p, { stopReason: "cancelled" }, "latch held + watchdog cleared → stays cancelled");
});

test("detector resolves normally FIRST → a late session/cancel is a silent no-op (R3.3)", async () => {
  const { schedule, advance } = makeClock();
  const { agent } = makeAgent({ schedule });
  const session = injectSession(agent, SID, fakePty());

  const p = agent.prompt({ sessionId: SID, prompt: [{ type: "text", text: "a quick task" }] });
  await Promise.resolve();
  const detector = session.turnDetector;
  detector.observe(asst("end_turn", "u1"));
  advance(200); // Δt quiescence → normal resolution
  assert.deepEqual(await Promise.race([p, rejectAfter(1000)]), { stopReason: "end_turn" });

  // prompt()'s finally has cleared turnCancel; the late cancel finds no in-flight turn → no-op, no override.
  await assert.doesNotReject(() => agent.cancel({ sessionId: SID }), "a late cancel must be a silent no-op");
  assert.deepEqual(await p, { stopReason: "end_turn" }, "the normal resolution stands");
});
