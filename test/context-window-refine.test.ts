// Story 069 / Task 2.1 (R1, R1.3, UB1, UB2, R4) — ACP-wire proof that the usage_update `size`
// denominator FOLLOWS each turn's REAL model. The session is seeded with the `default` alias window
// (200K, story 068), but once a turn's assistant message carries a real `model` id (the JSONL `model`
// field, e.g. `claude-opus-4-8`) the pump must AUTHORITATIVELY refine `session.contextWindowSize` via
// `inferContextWindowFromModelId` BEFORE building that turn's usage_update — so `size` reflects what
// ACTUALLY ran (opus-4-8 → 1M, sonnet-4-6 → 200K), not the stale alias seed.
//
// Mirrors acp-wire-usage-flag.test.ts: plant a transcript whose ASSISTANT turns carry `usage` AND
// `model` as siblings of role/content inside `message` (the carrier the pump reads as
// `turn.message.message`), spawn the BUILT fork (`node dist/index.js`), and over the genuine JSON-RPC
// stdio transport do `initialize` + replay-only `loadSession`. No `USAGE_UPDATE` env → DEFAULT-ON
// (story 042), so the replay emits a usage_update per usage-bearing turn.
//
// ROBUST design: TWO assistant turns with OPPOSITE-window models. Both share the SAME `default` seed
// before the wire, so the differing-size assertion can only pass when `size` TRACKS each turn's model
// — proving the refine independently of the alias seed (a single-turn test could pass by coincidence
// if the seed happened to match). The usage TOKENS are untouched (R4): used = input + output per turn.
//
// READ-ONLY (R4 / UB2): only `initialize` + `loadSession` are issued — never `session/prompt`; no
// `claude`/PTY is spawned, no network. The child is reaped AND the planted temp dir removed in
// `t.after(() => sim.dispose())` on success OR failure; a fresh plant/sim per test.
//
// Run: `npm --prefix fork run build && node --experimental-strip-types --test test/context-window-refine.test.ts`
import { test } from "node:test";
import assert from "node:assert/strict";
import { startZedSim } from "./helpers/zed-sim-client.ts";
import { plantTranscript, type PlantMessage } from "./helpers/plant-transcript.ts";

// A FIXED FICTIONAL cwd (non-existent ⇒ deterministic project slug; the SDK realpath falls back to
// the literal), mirroring acp-wire-usage-flag.test.ts.
const SIM_CWD = "/zedsim/proj";

// The two windows the assertions key off — kept named so the test reads as the contract it proves.
const OPUS_WINDOW = 1_000_000; // claude-opus-4-8 → native 1M (opus 4-7+)
const SONNET_WINDOW = 200_000; // claude-sonnet-4-6 → standard 200K

// One user turn then TWO assistant turns carrying OPPOSITE-window models. `usage` and `model` both
// live INSIDE `message` (siblings of role/content) — the exact carrier `getSessionMessages`
// round-trips and the pump reads as `turn.message.message`. The seed (`default` alias) window is
// 200K for BOTH turns, so a usage_update whose `size` differs per turn can ONLY come from the
// per-turn model refine.
const USAGE_TURNS: PlantMessage[] = [
  { type: "user", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
  {
    type: "assistant",
    message: {
      role: "assistant",
      model: "claude-opus-4-8",
      usage: { input_tokens: 100, output_tokens: 50 },
      content: [{ type: "text", text: "a" }],
    },
  },
  {
    type: "assistant",
    message: {
      role: "assistant",
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 200, output_tokens: 100 },
      content: [{ type: "text", text: "b" }],
    },
  },
];

// Race a wire call against a timeout so a deadlocked transport / never-resolving load FAILS loudly
// with the child's stderr instead of hanging the suite (verbatim from acp-wire-usage-flag.test.ts).
function withTimeout<T>(promise: Promise<T>, ms: number, getInfo: () => string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`ACP-wire refine loadSession timed out after ${ms}ms. Agent stderr:\n${getInfo()}`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/** Plant the model-bearing transcript, spawn the fork (default-ON usage), replay-load it over the wire. */
async function replayUsageUpdates(t: { after: (fn: () => void) => void }): Promise<any[]> {
  const planted = plantTranscript({ cwd: SIM_CWD, messages: USAGE_TURNS });
  // No USAGE_UPDATE env → default-ON (story 042), so the replay emits a usage_update per usage turn.
  const sim = startZedSim({ configDir: planted.configDir, home: planted.home, cleanup: planted.cleanup });
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

  // Sanity: the replay did emit SOMETHING (the planted text turns) — an empty stream would mean a
  // discovery miss, not a refine effect, so the size assertions below would be meaningless.
  assert.ok(
    sim.captured.length > 0,
    `loadSession must emit session/update notifications; stderr:\n${collectStderr()}`,
  );

  // The usage_updates in arrival order — one per usage-bearing assistant turn, in transcript order.
  const usageUpdates = sim.captured.filter((c) => c?.update?.sessionUpdate === "usage_update");
  assert.equal(
    usageUpdates.length,
    2,
    `expected exactly 2 usage_update (one per assistant turn); saw kinds: ${JSON.stringify(
      sim.captured.map((c) => c?.update?.sessionUpdate),
    )}`,
  );
  return usageUpdates;
}

test("069 R1/UB1: usage_update.size FOLLOWS each turn's REAL model over real stdio (opus→1M, sonnet→200K)", async (t) => {
  const usageUpdates = await replayUsageUpdates(t);

  // Turn 1 ran on claude-opus-4-8 → the pump refines the window to 1M BEFORE building this update.
  assert.equal(
    usageUpdates[0].update.size,
    OPUS_WINDOW,
    "opus-4-8 turn: size must refine to 1M (the turn's real model), not the 200K alias seed",
  );
  // Turn 2 ran on claude-sonnet-4-6 → the pump refines the window back to 200K for THIS turn.
  assert.equal(
    usageUpdates[1].update.size,
    SONNET_WINDOW,
    "sonnet-4-6 turn: size must refine to 200K (the turn's real model)",
  );

  // The proof's teeth: the two sizes must DIFFER. Before the wire both carry the shared seed window,
  // so an identical pair is exactly the Red state — only the per-turn model refine makes them differ.
  assert.notEqual(
    usageUpdates[0].update.size,
    usageUpdates[1].update.size,
    "the two turns' sizes must differ — size must track the per-turn model, not a single seed",
  );
});

test("069 R4: the usage TOKENS are untouched by the refine (used = input + output per turn)", async (t) => {
  const usageUpdates = await replayUsageUpdates(t);

  // The refine touches ONLY `size` (the window denominator); `used` is the carrier's tokens verbatim.
  assert.equal(usageUpdates[0].update.used, 150, "opus turn: used = 100 + 50 (tokens unchanged by refine)");
  assert.equal(usageUpdates[1].update.used, 300, "sonnet turn: used = 200 + 100 (tokens unchanged by refine)");
});
