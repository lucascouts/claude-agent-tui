// Story 038 / Task 3.2 (R3.2; resolves story-025 probe 3.3) — ACP-wire usage_update REJECTION
// RESILIENCE: drive the BUILT fork's replay-only `session/load` over the REAL JSON-RPC stdio
// transport against a client that THROWS on every `usage_update`, and prove the rejection never
// breaks the replay — the full content stream is still delivered in order, the fork does not crash.
//
// ── HONEST notification semantics (read before changing an assertion) ───────────────────────────
// Over the wire, `session/update` is a FIRE-AND-FORGET JSON-RPC notification: the agent side
// (`AgentSideConnection.sessionUpdate`) is `sendNotification`, which resolves as soon as the line is
// WRITTEN — there is NO response/ACK correlation (acp.js:1242-1246, 256-257). So the fork NEVER
// observes the client's downstream rejection of a `usage_update`, and therefore does NOT latch or
// suppress: it emits ALL N usage_update notifications (here N=2, one per usage-bearing turn). The
// client's throw, in turn, is SWALLOWED by the SDK's own `tryCallNotificationHandler` (acp.js:1165-
// 1193) — it is caught and `console.error`-logged ("Error handling notification"), not re-thrown and
// not surfaced as an `unhandledRejection` (empirically: zero unhandled rejections this SDK 0.22.1).
// Combined with the receive loop dispatching notifications WITHOUT awaiting `processMessage`
// (acp.js:1067), a rejecting `usage_update` handler cannot stop the subsequent content notifications.
//
// Resilience over the wire therefore comes from the NOTIFICATION SEMANTICS (fire-and-forget) + the
// non-blocking receive loop — NOT from the R8 catch-and-suppress LATCH. The R8 latch is the
// IN-PROCESS protection (catch the client rejection, latch usage off for the session, keep the
// surrounding stream flowing); that is proven in-process by `test/usage-reject.test.ts` (which
// asserts only ONE usage_update is attempted before the latch trips). This wire test is the
// deliberate CONTRAST: it asserts the honest non-suppression (BOTH usage_update emitted, N=2) and
// that the stream survives a rejecting client over the real transport — closing story-025 probe 3.3.
//
// READ-ONLY (R5.1): only `initialize` + `loadSession` are issued — never `session/prompt`; no
// `claude`/PTY is spawned, no network. The child is reaped AND the planted temp dir removed in
// `t.after(() => sim.dispose())` on success OR failure; a fresh plant/sim per test.
//
// Run: `npm --prefix fork run build && node --experimental-strip-types --test test/acp-wire-usage-reject.test.ts`
import { test } from "node:test";
import assert from "node:assert/strict";
import { startZedSim, type ZedSim } from "./helpers/zed-sim-client.ts";
import { plantTranscript, type PlantMessage } from "./helpers/plant-transcript.ts";

// A FIXED FICTIONAL cwd (non-existent ⇒ deterministic project slug; the SDK realpath falls back to
// the literal), mirroring the sibling acp-wire-*.test.ts.
const SIM_CWD = "/zedsim/proj";

// The error the test client throws when it rejects a `usage_update` — a genuine ACP client error.
// Matched exactly by the unhandledRejection guard so an UNEXPECTED rejection still fails the test.
const REJECT_MESSAGE = "zedsim: client rejects UNSTABLE usage_update (probe 3.3)";

// A multi-turn thread (user → assistant → user → assistant) whose TWO assistant turns each carry
// usage tokens INSIDE `message` (sibling of role/content — the exact carrier `getSessionMessages`
// round-trips, read as `turn.message.message.usage`). Distinct texts make the order assertion
// unambiguous; two usage-bearing turns are what make the honest non-suppression count (N=2) provable.
const USAGE_TURNS: PlantMessage[] = [
  { type: "user", message: { role: "user", content: [{ type: "text", text: "q1" }] } },
  {
    type: "assistant",
    message: { role: "assistant", usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: "text", text: "a1" }] },
  },
  { type: "user", message: { role: "user", content: [{ type: "text", text: "q2" }] } },
  {
    type: "assistant",
    message: { role: "assistant", usage: { input_tokens: 20, output_tokens: 8 }, content: [{ type: "text", text: "a2" }] },
  },
];
// The content stream the replay must deliver COMPLETE and IN ORDER (text chunks only; usage_update
// and any trailing available_commands_update are filtered out — cf. e2e-session-load-replay.test.ts).
const EXPECTED_TEXTS = ["q1", "a1", "q2", "a2"];

// Race a wire call against a timeout so a deadlocked transport / never-resolving load FAILS loudly
// with the child's stderr instead of hanging the suite (mirrors the sibling wire tests).
function withTimeout<T>(promise: Promise<T>, ms: number, getInfo: () => string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`ACP-wire usage-reject loadSession timed out after ${ms}ms. Agent stderr:\n${getInfo()}`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

interface RejectingSim {
  sim: ZedSim;
  /** The planted session id to pass to `loadSession`. */
  sessionId: string;
  /** Every `usage_update` the client received and REJECTED (one push per throw), in arrival order. */
  usageAttempts: any[];
  collectStderr: () => string;
}

/**
 * Plant the usage-bearing transcript, spawn the fork with USAGE_UPDATE=1, and wire the test client so
 * its `sessionUpdate` THROWS on every `usage_update` (recording the attempt first) and captures
 * everything else. Returns the sim, the planted sessionId, and the rejection counter. The caller
 * drives initialize/loadSession.
 */
function startRejectingSim(t: { after: (fn: () => void) => void }): RejectingSim {
  const planted = plantTranscript({ cwd: SIM_CWD, messages: USAGE_TURNS });
  const usageAttempts: any[] = [];
  const sim = startZedSim({
    configDir: planted.configDir,
    home: planted.home,
    env: { USAGE_UPDATE: "1" }, // opt IN so the fork actually emits usage_update over the wire
    cleanup: planted.cleanup,
    // The reject hook: a real ACP client error on the UNSTABLE usage_update. Record the attempt, then
    // throw — the throw becomes the client handler's rejection over the genuine transport. The fork,
    // emitting via fire-and-forget sendNotification, never sees it (honest non-suppression).
    onSessionUpdate: (params) => {
      if (params?.update?.sessionUpdate === "usage_update") {
        usageAttempts.push(params);
        throw new Error(REJECT_MESSAGE);
      }
    },
  });
  t.after(() => sim.dispose());
  const collectStderr = (sim.child as { collectedStderr?: () => string }).collectedStderr ?? (() => "");
  return { sim, sessionId: planted.sessionId, usageAttempts, collectStderr };
}

test(
  "ACP-wire usage-reject (R3.2, story-025/3.3): a client that rejects every usage_update does not break the replay — stream is delivered COMPLETE + IN ORDER over real stdio",
  async (t) => {
    // The client's throw is SWALLOWED by the SDK (see header) — it is NOT an unhandledRejection in
    // this SDK 0.22.1. We still install a temporary guard that FAILS the test on ANY unexpected
    // rejection and re-throws nothing of our own, so the runner stays clean and the observed
    // zero-unhandled-rejection semantics are documented as an assertion (checked after teardown).
    const unexpectedRejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      const msg = reason instanceof Error ? reason.message : String(reason);
      // Defensive: our deliberate client rejection is caught by the SDK and must NEVER reach here; if
      // the SDK semantics ever changed and it DID, it would still be "expected" and not a failure — but
      // anything else is a genuine leaked rejection we want to surface.
      if (!msg.includes(REJECT_MESSAGE)) unexpectedRejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    t.after(() => process.off("unhandledRejection", onUnhandled));

    const { sim, sessionId, usageAttempts, collectStderr } = startRejectingSim(t);

    // Handshake first (initialize MUST precede loadSession over the wire).
    await withTimeout(
      sim.agent.initialize({
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
      }),
      15000,
      collectStderr,
    );

    // (1) RESILIENCE: the replay-only load RESOLVES over the genuine transport even though the client
    //     rejects every usage_update — the rejection never breaks the transport. (READ-ONLY: no prompt.)
    await withTimeout(
      sim.agent.loadSession({ sessionId, cwd: SIM_CWD, mcpServers: [] }),
      20000,
      collectStderr,
    );

    // Let any late notification / would-be rejection settle before asserting on the wire counters.
    await new Promise((r) => setTimeout(r, 200));

    // The replay emitted SOMETHING — a silent [] would make the assertions below meaningless.
    assert.ok(
      sim.captured.length > 0,
      `loadSession must emit session/update notifications; stderr:\n${collectStderr()}`,
    );

    // (2) The content stream is delivered COMPLETE and IN ORDER despite the rejecting client. Extract
    //     the text chunks (usage_update is rejected so never captured; a trailing
    //     available_commands_update is filtered out) and assert the planted turns reproduce in order.
    const texts = sim.captured
      .filter((c) => c?.update?.content?.type === "text")
      .map((c) => c.update.content.text);
    assert.deepEqual(
      texts,
      EXPECTED_TEXTS,
      `the content stream must replay COMPLETE and IN ORDER despite the usage rejection; stderr:\n${collectStderr()}`,
    );

    // (3) The client genuinely rejected >=1 usage_update (each rejection recorded one attempt).
    assert.ok(
      usageAttempts.length >= 1,
      `the client must have rejected >=1 usage_update; stderr:\n${collectStderr()}`,
    );

    // (4) HONEST NON-SUPPRESSION (the deliberate contrast with the in-process R8 latch): over the wire
    //     the fork emits BOTH usage_update — it does NOT latch/suppress after the first rejection,
    //     because `sessionUpdate` is fire-and-forget and the fork never sees the client's rejection.
    //     Exactly N=2, one per usage-bearing assistant turn. (Contrast: usage-reject.test.ts asserts
    //     length===1 in-process, where the catch+latch DOES suppress the second.)
    assert.equal(
      usageAttempts.length,
      2,
      `over the wire the fork must emit BOTH usage_update (no suppression); got ${usageAttempts.length}. ` +
        `stderr:\n${collectStderr()}`,
    );

    // The deliberate client rejection is caught by the SDK and never leaks as an unhandledRejection;
    // any OTHER unhandled rejection is a real fault.
    assert.deepEqual(
      unexpectedRejections,
      [],
      `no unexpected unhandledRejection may leak from the rejecting-client replay; saw: ${unexpectedRejections.map(String).join(", ")}`,
    );
  },
);

test(
  "ACP-wire usage-reject (R5.2): the fork did not crash — dispose() reaps the child after a rejecting-client replay, idempotently",
  async (t) => {
    const { sim, sessionId, usageAttempts, collectStderr } = startRejectingSim(t);

    await withTimeout(
      sim.agent.initialize({
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
      }),
      15000,
      collectStderr,
    );
    await withTimeout(sim.agent.loadSession({ sessionId, cwd: SIM_CWD, mcpServers: [] }), 20000, collectStderr);
    await new Promise((r) => setTimeout(r, 200));

    // The fork stayed up through the rejected usage_update(s): the child is still alive (not crashed)
    // right up until WE reap it. (A crash mid-replay would have surfaced as a killed child / a
    // loadSession timeout above.)
    assert.ok(usageAttempts.length >= 1, "precondition: the client rejected at least one usage_update");
    assert.equal(sim.child.killed, false, "the fork child must still be alive (uncrashed) before dispose()");

    // dispose() reaps the child; a second call is a safe no-op (no leaked process).
    sim.dispose();
    sim.dispose();
    assert.equal(sim.child.killed, true, "dispose() must reap the fork child (no leaked process)");
  },
);
