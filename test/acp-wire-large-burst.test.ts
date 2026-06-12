// Story 038 / Task 4.1 — ACP-wire LARGE-BURST: load a hundreds-to-thousands synthetic transcript
// over the REAL JSON-RPC stdio transport and assert the fork emits EXACTLY ONE ordered
// `session/update` per linearized event, with no drop / merge / reorder (R4.1), read-only (R4.2),
// no fork-side crash (R4.2), fully offline/deterministic (R5.1). This RESOLVES story 025 probe 4.1:
// it is the OVER-THE-WIRE analogue of the in-process load-burst.test.ts — the in-process version
// injects `getMessages` directly, while here the SPAWNED fork uses the REAL `getSessionMessages`,
// reconstructing the thread by following the planter's linear `parentUuid` chain from the leaf.
//
// We plant an n≈2000-slot transcript (alternating user/assistant text + a Bash tool round-trip every
// 50 slots) under a THROWAWAY `.claude` (never the user's real `~/.claude`), spawn `node
// dist/index.js`, complete `initialize`, then call `loadSession`. The fork's replay-only `session/load`
// (story 027) resolves the planted file via `replaySessionHistory → readOrderedMessages →
// getSessionMessages` and replays it through the SAME `emitTurnUpdates` the live pump uses — so the
// captured stream is byte-for-byte the live ordering. We then assert the captured updates match the
// generator's linearized EXPECTED reference 1:1 in order.
//
// READ-ONLY (R4.2): the test issues ONLY `initialize` + `loadSession` — never `session/prompt` /
// `prompt`. The replay-only load spawns no `claude` / PTY (story 027), so there is no engine to write
// to; the burst cannot inject ACP-side input by construction. No crash: `sim.dispose()` reaps the
// child on success OR failure, and `loadSession` must resolve without a transport error.
//
// Throughput (R-note): the elapsed ms for the burst is captured and logged to STDERR as the fork-side
// ceiling. It is INFORMATIONAL — NOT asserted as a threshold — complementing story 039's Zed-side
// throttle finding (the fork emits one-update-per-event with no internal throttle; any backpressure
// is the CLIENT's, which 039 studies in Zed's Rust).
//
// Run: `npm --prefix fork run build && node --experimental-strip-types --test test/acp-wire-large-burst.test.ts`
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { startZedSim } from "./helpers/zed-sim-client.ts";
import { plantTranscript } from "./helpers/plant-transcript.ts";
import { makeLargeTranscript, type ExpectedUpdate } from "./helpers/make-large-transcript.ts";

// A FIXED FICTIONAL cwd: a non-existent path is the most deterministic choice — the SDK's realpath
// step falls back to the literal, so the project slug F0(cwd) is stable across machines/runs.
const SIM_CWD = "/zedsim/burst";

// "hundreds-to-thousands" (R4.1). 2000 slots → ~2039 messages / ~2039 updates after the tool pairs.
const BURST = 2000;
const TOOL_EVERY = 50;

// A 2000-slot burst over REAL stdio takes materially longer than the 4-turn load-replay test (which
// budgets 20s). Give the wire call a generous ceiling so a slow CI box does not false-fail on a
// transport that is making forward progress, and match the per-test timeout to it.
const LOAD_TIMEOUT_MS = 90000;
const TEST_TIMEOUT_MS = 120000;

// Race a wire call against a timeout so a deadlocked transport FAILS loudly with the child's stderr
// instead of hanging the suite (mirrors acp-wire-load-replay.test.ts).
function withTimeout<T>(promise: Promise<T>, ms: number, getInfo: () => string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`ACP-wire large-burst loadSession timed out after ${ms}ms. Agent stderr:\n${getInfo()}`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

// `loadSession` resolves as soon as `replaySessionHistory` finishes, but then schedules ONE trailing
// `available_commands_update` on a `setTimeout(0)` (acp-agent.ts loadSession). That post-replay
// notification crosses the wire AFTER the call resolves, so whether it has landed in `captured` when
// we read the buffer is a TEST-side timing race (lands under concurrent suite load; not yet when the
// box is idle) — NOT a fork drift. We settle it deterministically: poll until the captured count
// stops growing for a few consecutive ticks, so the count is stable before we assert on it.
async function settleCaptured(captured: any[], idleTicks = 5, tickMs = 20): Promise<void> {
  let last = -1;
  let stable = 0;
  // Bounded so a pathological never-settling stream can't hang the test (the outer test timeout also
  // guards). ~200 iterations * tickMs is far beyond the single trailing notification we expect.
  for (let i = 0; i < 200 && stable < idleTicks; i++) {
    if (captured.length === last) stable++;
    else {
      stable = 0;
      last = captured.length;
    }
    await new Promise((r) => setTimeout(r, tickMs));
  }
}

// Pull the identifying content from a captured `session/update` so it can be matched against an
// ExpectedUpdate. Returns a normalized {kind, key} the assertion compares per index.
function describeCaptured(c: any): { kind: string; key: string } {
  const u = c?.update ?? {};
  const kind = u.sessionUpdate;
  if (kind === "user_message_chunk" || kind === "agent_message_chunk") {
    return { kind, key: u.content?.text };
  }
  if (kind === "tool_call" || kind === "tool_call_update") {
    return { kind, key: u.toolCallId };
  }
  // Any OTHER kind (e.g. an unexpected usage_update / diff / plan) is surfaced verbatim so a
  // count/order mismatch points straight at the intruding update rather than a vague off-by-one.
  return { kind: String(kind), key: JSON.stringify(u) };
}

function describeExpected(e: ExpectedUpdate): { kind: string; key: string } {
  if (e.kind === "user_message_chunk" || e.kind === "agent_message_chunk") {
    return { kind: e.kind, key: e.text };
  }
  return { kind: e.kind, key: e.toolCallId };
}

test(
  "ACP-wire large-burst (§11/R4.1): loadSession emits one ordered session/update per linearized event over real stdio — no drop/merge/reorder",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    // 1) Build the deterministic n-slot transcript + its linearized expected-update reference, and
    //    plant it in an isolated config dir (UUID sessionId, linear parentUuid chain via the planter).
    const { messages, expected } = makeLargeTranscript(BURST, { toolEvery: TOOL_EVERY });
    const planted = plantTranscript({ cwd: SIM_CWD, messages });

    // Guard against a planter path drift before we blame the wire for an empty/short replay.
    assert.ok(fs.existsSync(planted.transcriptPath), `planted transcript must exist at ${planted.transcriptPath}`);

    // 2) Spawn the built fork with the planter's isolated config dir + HOME; reap the child AND the
    //    temp dir on success OR failure (no leaked process — part of the R4.2 "no crash" guarantee).
    const sim = startZedSim({ configDir: planted.configDir, home: planted.home, cleanup: planted.cleanup });
    t.after(() => sim.dispose());
    const collectStderr = (sim.child as { collectedStderr?: () => string }).collectedStderr ?? (() => "");

    // 3) `initialize` MUST precede `loadSession` over the wire. We negotiate NO `_meta.terminal_output`
    //    capability — that is what makes a Bash round-trip map to EXACTLY two updates (tool_call +
    //    tool_call_update) with no separate terminal_output notification, keeping the count exact.
    await withTimeout(
      sim.agent.initialize({
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
      }),
      15000,
      collectStderr,
    );

    // 4) READ-ONLY (R4.2): the ONLY two wire calls in this whole test are `initialize` (above) and
    //    `loadSession` (here). NO `session/prompt` / `prompt` is ever issued, so no ACP-side input is
    //    injected and the replay-only load spawns no `claude` / PTY. Time the burst for the throughput
    //    note (the fork-side ceiling).
    const t0 = performance.now();
    await withTimeout(
      sim.agent.loadSession({ sessionId: planted.sessionId, cwd: SIM_CWD, mcpServers: [] }),
      LOAD_TIMEOUT_MS,
      collectStderr,
    );
    const elapsedMs = performance.now() - t0;

    // Settle the post-replay tick so the single trailing `available_commands_update` (scheduled on a
    // setTimeout(0) inside loadSession) has deterministically landed before we count — otherwise the
    // total flips between expected.length and expected.length+1 depending on event-loop load.
    await settleCaptured(sim.captured);

    // A silent `[]` (e.g. a non-UUID sessionId trap or a config-dir miss) would leave this empty.
    assert.ok(
      sim.captured.length > 0,
      `loadSession must emit session/update notifications; stderr:\n${collectStderr()}`,
    );

    // Partition the captured stream into the BURST updates (the linearized turn updates we assert
    // against the reference) and the single non-burst `available_commands_update` loadSession appends
    // after replay. Both are accounted for below — nothing is dropped from the assertion.
    const burst = sim.captured.filter((c) => c?.update?.sessionUpdate !== "available_commands_update");
    const availCmd = sim.captured.filter((c) => c?.update?.sessionUpdate === "available_commands_update");

    // 5a) NO DROP / NO MERGE (R4.1): exactly one BURST session/update per linearized event — the burst
    //     count is the exact expected linearized count. A drop or merge would make it SHORTER; a
    //     spurious extra update (diff / usage_update / duplicated tool_call) would make it LONGER.
    //     Either is a genuine over-the-wire finding, surfaced — never masked by weakening the assertion.
    assert.equal(
      burst.length,
      expected.length,
      `one session/update per linearized event — no drop, no merge. ` +
        `expected ${expected.length} burst updates, got ${burst.length}. stderr:\n${collectStderr()}`,
    );

    // 5b) ORDERED, 1:1 (R4.1): walk the burst stream and the expected reference in lockstep and assert
    //     each update's kind + identifying content matches in order (texts u0/a1/… in sequence;
    //     tool_call / tool_call_update pinned on the right toolu_… id). A stable, gap-free ordering.
    for (let i = 0; i < expected.length; i++) {
      const got = describeCaptured(burst[i]);
      const want = describeExpected(expected[i]);
      assert.deepEqual(
        got,
        want,
        `update #${i} must match the linearized reference in order (no reorder/merge); ` +
          `expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}. stderr:\n${collectStderr()}`,
      );
    }

    // 5c) EXACT TOTAL: every captured update is accounted for — the burst (expected.length) PLUS
    //     exactly one post-replay `available_commands_update`. This makes the no-merge/no-extra
    //     guarantee total: a stray spurious update of ANY kind would break this equality.
    assert.equal(availCmd.length, 1, "loadSession must append exactly one available_commands_update after replay");
    assert.equal(
      sim.captured.length,
      expected.length + 1,
      `total captured = ${expected.length} burst + 1 available_commands_update; ` +
        `got ${sim.captured.length}. stderr:\n${collectStderr()}`,
    );

    // 6) NO CRASH (R4.2): `loadSession` resolved above without a transport error (a crash would have
    //    rejected the race or emitted a `[]`). The child is still alive (not killed yet — dispose runs
    //    in t.after) and exposes no exit code; assert it did not die mid-burst.
    assert.equal(sim.child.killed, false, "the fork child must not have been killed before dispose()");
    assert.equal(sim.child.exitCode, null, `the fork child must not have crashed mid-burst; stderr:\n${collectStderr()}`);

    // 7) Throughput NOTE (informational; NOT a threshold): record the fork-side ceiling to STDERR
    //    (never STDOUT — that is the ACP protocol channel). Complements story 039's Zed-side throttle.
    //    Counts the BURST updates (the linearized replay), excluding the single trailing notification.
    const updates = burst.length;
    const perUpdateUs = (elapsedMs * 1000) / updates;
    console.error(
      `[burst-throughput] ${updates} session/update over the wire in ${elapsedMs.toFixed(1)}ms ` +
        `(${(updates / (elapsedMs / 1000)).toFixed(0)} updates/s, ${perUpdateUs.toFixed(1)} µs/update) ` +
        `— fork-side ceiling; client-side throttle is story 039's Zed finding.`,
    );
  },
);
