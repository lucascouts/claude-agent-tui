// Story 042 / Task 1.1 (R1.1, R5.1) — ACP-wire usage_update flag, DEFAULT-ON contract: prove that the
// BUILT fork emits the optional UNSTABLE `usage_update` over the REAL stdio transport BY DEFAULT (no
// `USAGE_UPDATE` in its env → >=1 usage_update — the over-the-wire proof of R1.1), and emits ZERO
// usage_update ONLY when the env explicitly opts OUT via `USAGE_UPDATE=0` (R5.1). This flips the
// story-038 default-OFF assertion now that story 039's ZED-CLIENT-STUDY confirmed the user's Zed
// ACCEPTS+RENDERS usage_update by code; the per-session R8 reject latch still guards a rejecting
// client.
//
// `usage_update` (and its R8 reject latch) lives in the SHARED `emitTurnUpdates` (story-038 move from
// `pumpUpdates`), so the replay-only `session/load` the harness exercises emits it too — symmetric to
// the story-026 diff move. We plant a transcript whose ASSISTANT turn carries
// `usage:{input_tokens,output_tokens}` as a sibling of role/content inside `message` (the exact
// carrier `getSessionMessages` round-trips intact), spawn `node dist/index.js`, and over the genuine
// JSON-RPC transport do `initialize` + replay-only `loadSession`. The env reaches the agent via
// index.ts's `usageUpdateEnabled(process.env)` → runAcp → AgentDeps.usageUpdate → the shared emit's
// gate.
//
// READ-ONLY (R5.1): only `initialize` + `loadSession` are issued — never `session/prompt`; no
// `claude`/PTY is spawned, no network. The child is reaped AND the planted temp dir removed in
// `t.after(() => sim.dispose())` on success OR failure; a fresh plant/sim per test.
//
// Run: `npm --prefix fork run build && node --experimental-strip-types --test test/acp-wire-usage-flag.test.ts`
import { test } from "node:test";
import assert from "node:assert/strict";
import { startZedSim } from "./helpers/zed-sim-client.ts";
import { plantTranscript, type PlantMessage } from "./helpers/plant-transcript.ts";

// A FIXED FICTIONAL cwd (non-existent ⇒ deterministic project slug; the SDK realpath falls back to
// the literal), mirroring acp-wire-load-replay.test.ts.
const SIM_CWD = "/zedsim/proj";

// A minimal 2-turn thread whose ASSISTANT message carries usage tokens INSIDE `message` (sibling of
// role/content). The pump/replay reads the carrier as `turn.message.message`, so `usage` must live
// here — NOT at the top level — for `usageUpdatesFor` to see input_tokens/output_tokens.
const USAGE_TURNS: PlantMessage[] = [
  { type: "user", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
  {
    type: "assistant",
    message: {
      role: "assistant",
      usage: { input_tokens: 100, output_tokens: 50 },
      content: [{ type: "text", text: "hi" }],
    },
  },
];

// Race a wire call against a timeout so a deadlocked transport / never-resolving load FAILS loudly
// with the child's stderr instead of hanging the suite (mirrors acp-wire-load-replay.test.ts).
function withTimeout<T>(promise: Promise<T>, ms: number, getInfo: () => string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`ACP-wire usage loadSession timed out after ${ms}ms. Agent stderr:\n${getInfo()}`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/** Plant a usage-bearing transcript, spawn the fork (optionally with USAGE_UPDATE), replay-load it. */
async function replayWithEnv(
  t: { after: (fn: () => void) => void },
  env: Record<string, string | undefined> | undefined,
): Promise<any[]> {
  const planted = plantTranscript({ cwd: SIM_CWD, messages: USAGE_TURNS });
  const sim = startZedSim({ configDir: planted.configDir, home: planted.home, env, cleanup: planted.cleanup });
  t.after(() => sim.dispose());

  const collectStderr = (sim.child as { collectedStderr?: () => string }).collectedStderr ?? (() => "");

  // Handshake first (initialize MUST precede loadSession over the wire).
  await withTimeout(
    sim.agent.initialize({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    }),
    15000,
    collectStderr,
  );

  // READ-ONLY replay-only load over the genuine transport (no session/prompt).
  await withTimeout(
    sim.agent.loadSession({ sessionId: planted.sessionId, cwd: SIM_CWD, mcpServers: [] }),
    20000,
    collectStderr,
  );

  // Sanity: the replay did emit SOMETHING (the planted text turns) over the wire — an empty stream
  // would mean a discovery miss, not a flag effect, so usage assertions below would be meaningless.
  assert.ok(
    sim.captured.length > 0,
    `loadSession must emit session/update notifications; stderr:\n${collectStderr()}`,
  );

  return sim.captured;
}

test("ACP-wire usage flag (R1.1): DEFAULT (no USAGE_UPDATE env) yields >=1 usage_update over real stdio", async (t) => {
  // The over-the-wire proof of R1.1 — the BUILT fork emits usage_update by DEFAULT, no env required.
  const captured = await replayWithEnv(t, undefined);

  const usageUpdates = captured.filter((c) => c?.update?.sessionUpdate === "usage_update");
  assert.ok(
    usageUpdates.length >= 1,
    `default (no USAGE_UPDATE) must yield >=1 usage_update over the wire (default-ON); saw kinds: ${JSON.stringify(
      captured.map((c) => c?.update?.sessionUpdate),
    )}`,
  );
  // The carrier's tokens flow through usageUpdatesFor → toUsageUpdate (used = input + output = 150).
  assert.equal(usageUpdates[0].update.used, 150, "usage_update.used must be input_tokens + output_tokens");
});

test("ACP-wire usage flag (R1.1): with USAGE_UPDATE=1 the replay stream still carries >=1 usage_update", async (t) => {
  const captured = await replayWithEnv(t, { USAGE_UPDATE: "1" });

  const usageUpdates = captured.filter((c) => c?.update?.sessionUpdate === "usage_update");
  assert.ok(
    usageUpdates.length >= 1,
    `USAGE_UPDATE=1 must yield >=1 usage_update over the wire; saw kinds: ${JSON.stringify(
      captured.map((c) => c?.update?.sessionUpdate),
    )}`,
  );
  assert.equal(usageUpdates[0].update.used, 150, "usage_update.used must be input_tokens + output_tokens");
});

test("ACP-wire usage flag (R5.1): USAGE_UPDATE=0 opts OUT — the replay stream carries ZERO usage_update", async (t) => {
  const captured = await replayWithEnv(t, { USAGE_UPDATE: "0" });

  const usageUpdates = captured.filter((c) => c?.update?.sessionUpdate === "usage_update");
  assert.equal(
    usageUpdates.length,
    0,
    `USAGE_UPDATE=0 must emit ZERO usage_update (the opt-out); saw kinds: ${JSON.stringify(
      captured.map((c) => c?.update?.sessionUpdate),
    )}`,
  );
});
