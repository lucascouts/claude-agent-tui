// Story 056 / Task 5.1 (R5.1, #812) — push the sanitized session title via `session_info_update`
// at the story-024 end-of-turn boundary: deduped, fire-and-forget, and NEVER on cancel/watchdog.
//
// CONTRACT (story.md R5.1):
//   - A REAL end-of-turn boundary → EXACTLY ONE client.sessionUpdate whose update.sessionUpdate is
//     "session_info_update" and update.title === sanitizeTitle(getSessionInfo().summary).
//   - A CANCEL (session/cancel) → NO session_info_update emit (the cancel latch never fires onTurnResolved).
//   - getSessionInfo() resolving `undefined` (no transcript) → NO emit.
//   - The SAME summary across two turns → ONE emit (dedup via session.lastEmittedTitle); a CHANGED
//     summary → TWO distinct emits.
//   - getSessionInfo() REJECTING → the rejection is swallowed; prompt()/PromptResponse still resolves.
//   - The push is fire-and-forget: a slow/never-resolving getSessionInfo must NOT delay PromptResponse.
//
// Plus a focused end-of-turn.ts unit assert: onTurnResolved fires on a boundary but NOT on cancel().
//
// HERMETIC: getSessionInfo is the injected `getSessionInfo` deps seam (never touches ~/.claude); the
// turn is driven by feeding session.turnDetector directly + a fake clock shared with the resolver —
// the exact seam the live pump feeds (the prompt-submit-endofturn / session-cancel-resolve precedent).
// node:test (build first):
//   node --experimental-strip-types --test test/session-title-push.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeAcpAgent } from "../dist/acp-agent.js";
import { createTurnResolver } from "../dist/end-of-turn.js";

/** Deterministic fake clock shared by sendPrompt (\r delay) and the turn resolver (Δt + watchdog). */
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

/** Reject after `ms` REAL time so a never-resolving prompt fails fast (a hang) instead of timing the suite out. */
function rejectAfter(ms: number): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`prompt did not resolve within ${ms}ms`)), ms).unref?.(),
  ) as Promise<never>;
}

type Update = { sessionId: string; update: { sessionUpdate: string; title?: string | null } };

function makeAgent(deps: any = {}) {
  const updates: Update[] = [];
  const client: any = {
    async sessionUpdate(u: Update) {
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

const CWD = "/work/proj";

function injectSession(agent: any, sid: string, pty: any) {
  agent.sessions[sid] = {
    pty,
    emitted: new Set(),
    emittedNested: new Set(),
    cancelled: false,
    cwd: CWD,
    toolUseCache: {},
    guardChecked: false,
    settingsManager: { dispose() {} },
    watcher: undefined,
  };
  return agent.sessions[sid];
}

const asst = (stop_reason: unknown, uuid: string) => ({
  type: "assistant",
  uuid,
  message: { stop_reason },
});

/** Drive ONE real end-of-turn through prompt(): submit → feed a terminal boundary → Δt quiescence. */
async function runTurn(
  agent: any,
  advance: (ms: number) => void,
  sid: string,
  uuid: string,
  text = "hi",
): Promise<unknown> {
  const session = agent.sessions[sid];
  const p = agent.prompt({ sessionId: sid, prompt: [{ type: "text", text }] });
  await Promise.resolve(); // flush prompt()'s synchronous submit + turn registration
  session.turnDetector.observe(asst("end_turn", uuid)); // terminal candidate → arms Δt
  advance(200); // Δt quiescence → real end-of-turn boundary → onTurnResolved
  return p;
}

/** session_info_update emits only (the title pushes), in order. */
const titlePushes = (updates: Update[]) =>
  updates.filter((u) => u.update?.sessionUpdate === "session_info_update");

const SID = "sess-056-title";

// ── Scenario 1 — a real end-of-turn pushes exactly one sanitized title ───────────────────────────

test("5.1 a real end-of-turn → ONE session_info_update with title === sanitizeTitle(summary) (R5.1)", async () => {
  const { schedule, advance } = makeClock();
  // A summary with newlines + runaway whitespace exercises sanitizeTitle (collapses to one line).
  const summary = "  Refactor\n\n   the   turn   resolver  ";
  const { agent, updates } = makeAgent({
    schedule,
    getSessionInfo: async () => ({ summary }),
  });
  const session = injectSession(agent, SID, fakePty());

  const res = await Promise.race([runTurn(agent, advance, SID, "u1"), rejectAfter(2000)]);
  assert.deepEqual(res, { stopReason: "end_turn" }, "the turn resolves normally on the boundary");

  // Let the fire-and-forget push (an awaited getSessionInfo + sessionUpdate) drain its microtasks.
  await new Promise((r) => setTimeout(r, 0));

  const pushes = titlePushes(updates);
  assert.equal(pushes.length, 1, `exactly one session_info_update, got ${pushes.length}`);
  assert.equal(pushes[0].sessionId, SID, "the push targets the resolving session");
  // Load-bearing: the title is the COLLAPSED single-line form, not the raw summary (proves sanitizeTitle ran).
  assert.equal(pushes[0].update.title, "Refactor the turn resolver");
  assert.notEqual(pushes[0].update.title, summary, "the raw multi-line summary is NOT pushed verbatim");
  // Dedup state recorded for the next turn.
  assert.equal(session.lastEmittedTitle, "Refactor the turn resolver");
});

// ── Scenario 2 — a cancel never pushes a title ───────────────────────────────────────────────────

test("5.1 a cancel → NO session_info_update (the cancel latch never fires onTurnResolved) (R5.1)", async () => {
  const { schedule, advance } = makeClock();
  let infoCalls = 0;
  const { agent, updates } = makeAgent({
    schedule,
    getSessionInfo: async () => {
      infoCalls++;
      return { summary: "should never be pushed on cancel" };
    },
  });
  injectSession(agent, SID, fakePty());

  const p = agent.prompt({ sessionId: SID, prompt: [{ type: "text", text: "hi" }] });
  await Promise.resolve(); // flush submit + turn registration
  await agent.cancel({ sessionId: SID }); // resolves the turn 'cancelled' via the 024 latch
  assert.deepEqual(await Promise.race([p, rejectAfter(1000)]), { stopReason: "cancelled" });

  await new Promise((r) => setTimeout(r, 0)); // drain any (wrongly) scheduled push
  // Load-bearing: scenario fails if cancel pushed. getSessionInfo must not even be CONSULTED on cancel.
  assert.equal(titlePushes(updates).length, 0, "cancel must emit no session_info_update");
  assert.equal(infoCalls, 0, "getSessionInfo is never consulted on a cancelled turn");
});

// ── Scenario 3 — getSessionInfo undefined → no emit ──────────────────────────────────────────────

test("5.1 getSessionInfo resolves undefined (no transcript) → NO emit (R5.1)", async () => {
  const { schedule, advance } = makeClock();
  const { agent, updates } = makeAgent({
    schedule,
    getSessionInfo: async () => undefined,
  });
  const session = injectSession(agent, SID, fakePty());

  await Promise.race([runTurn(agent, advance, SID, "u1"), rejectAfter(2000)]);
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(titlePushes(updates).length, 0, "no transcript → no title push");
  assert.equal(session.lastEmittedTitle, undefined, "no dedup state recorded when nothing was pushed");
});

// ── Scenario 4 — same summary across two turns → one emit (dedup) ─────────────────────────────────

test("5.1 the SAME summary across two turns → ONE emit (dedup via lastEmittedTitle) (R5.1)", async () => {
  const { schedule, advance } = makeClock();
  const { agent, updates } = makeAgent({
    schedule,
    getSessionInfo: async () => ({ summary: "Stable session title" }),
  });
  injectSession(agent, SID, fakePty());

  await Promise.race([runTurn(agent, advance, SID, "u1"), rejectAfter(2000)]);
  await new Promise((r) => setTimeout(r, 0));
  await Promise.race([runTurn(agent, advance, SID, "u2"), rejectAfter(2000)]);
  await new Promise((r) => setTimeout(r, 0));

  const pushes = titlePushes(updates);
  assert.equal(pushes.length, 1, `an unchanged title is pushed once, got ${pushes.length}`);
  assert.equal(pushes[0].update.title, "Stable session title");
});

// ── Scenario 5 — changed summary across two turns → two distinct emits ────────────────────────────

test("5.1 a CHANGED summary across two turns → TWO distinct emits (R5.1)", async () => {
  const { schedule, advance } = makeClock();
  const summaries = ["First title", "Second title"];
  let i = 0;
  const { agent, updates } = makeAgent({
    schedule,
    getSessionInfo: async () => ({ summary: summaries[Math.min(i++, summaries.length - 1)] }),
  });
  injectSession(agent, SID, fakePty());

  await Promise.race([runTurn(agent, advance, SID, "u1"), rejectAfter(2000)]);
  await new Promise((r) => setTimeout(r, 0));
  await Promise.race([runTurn(agent, advance, SID, "u2"), rejectAfter(2000)]);
  await new Promise((r) => setTimeout(r, 0));

  const pushes = titlePushes(updates);
  assert.equal(pushes.length, 2, `a changed title emits twice, got ${pushes.length}`);
  assert.deepEqual(
    pushes.map((u) => u.update.title),
    ["First title", "Second title"],
    "each turn pushes its own distinct title",
  );
});

// ── Scenario 6 — getSessionInfo rejects → the turn still resolves (swallowed) ─────────────────────

test("5.1 getSessionInfo REJECTS → the push is swallowed; the turn still resolves normally (R5.1)", async () => {
  const { schedule, advance } = makeClock();
  const { agent, updates } = makeAgent({
    schedule,
    getSessionInfo: async () => {
      throw new Error("boom — transcript read failed");
    },
  });
  injectSession(agent, SID, fakePty());

  // Load-bearing: a rejecting reader must NOT propagate into PromptResponse (the method is never awaited).
  const res = await Promise.race([runTurn(agent, advance, SID, "u1"), rejectAfter(2000)]);
  assert.deepEqual(res, { stopReason: "end_turn" }, "the rejection is swallowed — the turn resolves");

  await new Promise((r) => setTimeout(r, 0));
  assert.equal(titlePushes(updates).length, 0, "a failed read pushes nothing");
});

// ── Scenario 7 — a slow/never-resolving getSessionInfo must NOT delay PromptResponse ──────────────

test("5.1 a never-resolving getSessionInfo does NOT hang the turn (fire-and-forget, R5.1)", async () => {
  const { schedule, advance } = makeClock();
  let pushAttempted = false;
  const { agent, updates } = makeAgent({
    schedule,
    // Never resolves — if the push were awaited inside prompt(), the turn would hang here.
    getSessionInfo: () => {
      pushAttempted = true;
      return new Promise<never>(() => {});
    },
  });
  injectSession(agent, SID, fakePty());

  // The turn MUST settle from the detector boundary alone, independent of the pending push.
  const res = await Promise.race([runTurn(agent, advance, SID, "u1"), rejectAfter(2000)]);
  assert.deepEqual(res, { stopReason: "end_turn" }, "PromptResponse resolves without awaiting the push");

  await new Promise((r) => setTimeout(r, 0));
  assert.equal(pushAttempted, true, "the push WAS dispatched on the boundary (it is just not awaited)");
  assert.equal(titlePushes(updates).length, 0, "the pending push emits nothing yet — and never blocked the turn");
});

// ── Focused end-of-turn.ts unit assert — onTurnResolved fires on a boundary, NOT on cancel() ──────

test("5.1 (unit) onTurnResolved fires on a real boundary but NOT on cancel() (drive the resolver directly)", async () => {
  // (a) Real boundary → exactly one onTurnResolved, AFTER the prompt resolves.
  {
    const { schedule, advance } = makeClock();
    const calls: string[] = [];
    const { detector, promise } = createTurnResolver({
      schedule,
      onTurnResolved: () => calls.push("resolved"),
    });
    detector.beginTurn();
    detector.observe(asst("end_turn", "u1"));
    advance(200);
    assert.deepEqual(await promise, { stopReason: "end_turn" });
    assert.deepEqual(calls, ["resolved"], "onTurnResolved fires EXACTLY ONCE on a real end-of-turn");
    advance(10_000);
    assert.equal(calls.length, 1, "a settled turn does not re-fire onTurnResolved");
  }

  // (b) cancel() → onTurnResolved must NOT fire (load-bearing: the latch claims 'cancelled' first).
  {
    const { schedule, advance } = makeClock();
    const calls: string[] = [];
    const { detector, promise, cancel } = createTurnResolver({
      schedule,
      onTurnResolved: () => calls.push("resolved"),
    });
    detector.beginTurn();
    detector.observe(asst("tool_use", "u0")); // mid-turn
    cancel();
    detector.observe(asst("end_turn", "u1")); // a late boundary after cancel must not fire it
    advance(10_000);
    assert.deepEqual(await promise, { stopReason: "cancelled" });
    assert.deepEqual(calls, [], "cancel() never fires onTurnResolved — no title push on cancel");
  }
});
