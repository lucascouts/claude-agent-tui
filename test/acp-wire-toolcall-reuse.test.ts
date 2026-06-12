// Story 038 / Task 2.1 — ACP-wire tool-call id reuse: the raw `tool_use.id`, reused VERBATIM as the
// ACP `toolCallId`, survives the real JSON-RPC stdio transport with the `tool_call_update` correlated
// to its `tool_call` (R2.1). Resolves story-025 probe 2.1.
//
// This is the over-the-wire regression GUARD for the FORK.md "Zed client-compat verdicts" #2 verdict
// (RAW `tool_use.id` reuse accepted — the §7 reuse contract stories 017-021 assume, and which the
// live-Zed probe confirmed): the fork uses the DEFAULT non-namespaced `toolCallIdFor(toolUseId,
// sessionId)` path (fork/src/tools.ts), so `toolCallId` on the wire is the verbatim `toolu_X`, never a
// `${sessionId}:${toolUseId}` synthetic. We plant a transcript whose assistant emits a `tool_use`
// (id `toolu_X`, a `Bash` round-trip) and whose next user turn carries the matching `tool_result`
// (same `tool_use_id`); drive the replay-only `session/load` over the genuine transport; and assert
// the captured `session/update` stream contains EXACTLY ONE `tool_call` for `toolu_X` and a
// `tool_call_update` carrying the SAME `toolCallId === "toolu_X"` — no duplicate `tool_call`, no
// dropped update. Mirrors the in-process e2e-session-load-replay.test.ts `toolu_E` round-trip, but
// asserts the id correlation OVER THE WIRE.
//
// Correlation note (verified this session from acp-agent.ts:2141/2160/2232): the fork correlates the
// `tool_result` to its `tool_use` via the `tool_use_id` INSIDE the result content block (the
// `toolUseCache[chunk.tool_use_id]` lookup), NOT the event-level `parent_tool_use_id`. So the planted
// content-block `tool_use_id` alone suffices — `plant-transcript.ts` needs no extension. The emitted
// `tool_call` uses `toolCallId: chunk.id` and the `tool_call_update` uses `toolCallId:
// chunk.tool_use_id`; both are the raw `toolu_X`.
//
// `supportsTerminalOutput` is FALSE here (initialize negotiates only `fs` capabilities, no terminal),
// so a `Bash` result yields exactly ONE `tool_call_update` (the completed-status update) — the
// separate `terminal_output` update only fires when terminal output is supported.
//
// READ-ONLY (R5.1): only `initialize` + `loadSession` are issued — never `session/prompt`; no
// `claude`/PTY is spawned, no network. Un-gated under `node --test`: the child is reaped AND the temp
// dir removed in `t.after(() => sim.dispose())` on success OR failure.
//
// Run: `npm --prefix fork run build && node --experimental-strip-types --test test/acp-wire-toolcall-reuse.test.ts`
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startZedSim } from "./helpers/zed-sim-client.ts";
import { plantTranscript, projectSlug, type PlantMessage } from "./helpers/plant-transcript.ts";

// A FIXED FICTIONAL cwd: a non-existent path is the most deterministic choice — the SDK's realpath
// step falls back to the literal, so the project slug F0(cwd) is stable across machines/runs.
const SIM_CWD = "/zedsim/proj";

// The raw tool_use id under guard. The whole point of this test is that this VERBATIM string is what
// crosses the wire as `toolCallId` on BOTH the `tool_call` and its `tool_call_update` (no namespacing,
// no synthesis) — the FORK.md #2 "raw reuse accepted" verdict.
const TOOL_USE_ID = "toolu_X";

// A prior thread carrying ONE tool round-trip: user prompt → assistant `tool_use` (Bash) → user
// `tool_result` (SAME `tool_use_id`) → assistant text. Mirrors e2e-session-load-replay.test.ts's
// PRIOR_THREAD `toolu_E` Edit round-trip, but with a Bash call and asserted over the wire. The planter
// builds the linear parentUuid chain so the SDK reader returns all four turns (not just the leaf).
const TURNS: PlantMessage[] = [
  { type: "user", message: { role: "user", content: [{ type: "text", text: "list files" }] } },
  {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: TOOL_USE_ID, name: "Bash", input: { command: "ls" } }],
    },
  },
  {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: TOOL_USE_ID, content: "a.txt\nb.txt" }],
    },
  },
  { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
];

// Race a wire call against a timeout so a deadlocked transport or a never-resolving load FAILS loudly
// with the child's stderr instead of hanging the suite (mirrors the sibling wire tests).
function withTimeout<T>(promise: Promise<T>, ms: number, getInfo: () => string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`ACP-wire loadSession timed out after ${ms}ms. Agent stderr:\n${getInfo()}`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

test("ACP-wire tool-call id reuse (§7, R2.1): the raw tool_use.id reused as toolCallId survives the wire with its update correlated (resolves 025/2.1, guards FORK.md #2)", async (t) => {
  // 1) Plant the tool round-trip in an isolated config dir (UUID sessionId, linear parentUuid chain).
  const planted = plantTranscript({ cwd: SIM_CWD, messages: TURNS });

  // The fixture really exists where the SDK reader will look — guards against a planter path drift
  // before we blame the wire for a missing tool_call.
  assert.ok(fs.existsSync(planted.transcriptPath), `planted transcript must exist at ${planted.transcriptPath}`);
  assert.ok(
    planted.transcriptPath.startsWith(planted.configDir + path.sep) &&
      planted.transcriptPath.endsWith(path.join("projects", projectSlug(SIM_CWD), `${planted.sessionId}.jsonl`)),
    "the transcript path must match configDir/projects/<F0(cwd)>/<sessionId>.jsonl",
  );

  // 2) Spawn the built fork with the planter's isolated config dir + HOME, and reap both the child
  //    and the temp dir on success OR failure.
  const sim = startZedSim({ configDir: planted.configDir, home: planted.home, cleanup: planted.cleanup });
  t.after(() => sim.dispose());

  const collectStderr = (sim.child as { collectedStderr?: () => string }).collectedStderr ?? (() => "");

  // 3) `initialize` MUST precede `loadSession` over the wire (handshake first). Only `fs` capabilities
  //    are negotiated — no terminal — so the Bash result yields a single `tool_call_update`.
  await withTimeout(
    sim.agent.initialize({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    }),
    15000,
    collectStderr,
  );

  // 4) READ-ONLY replay-only load over the genuine transport (no `session/prompt`).
  await withTimeout(
    sim.agent.loadSession({ sessionId: planted.sessionId, cwd: SIM_CWD, mcpServers: [] }),
    20000,
    collectStderr,
  );

  // The replay emitted notifications across the wire — a silent `[]` (e.g. a non-UUID sessionId trap or
  // a config-dir that missed the planted file) would leave this empty.
  assert.ok(sim.captured.length > 0, `loadSession must emit session/update notifications; stderr:\n${collectStderr()}`);

  // --- The id-reuse contract over the wire (R2.1) -------------------------------------------------
  // EXACTLY ONE `tool_call` for `toolu_X`, carrying the verbatim raw id (not `${sessionId}:toolu_X`).
  const toolCalls = sim.captured.filter(
    (c) => c?.update?.sessionUpdate === "tool_call" && c.update.toolCallId === TOOL_USE_ID,
  );
  assert.equal(
    toolCalls.length,
    1,
    `expected exactly ONE tool_call for "${TOOL_USE_ID}" over the wire (no duplicate); got ${toolCalls.length}. stderr:\n${collectStderr()}`,
  );
  // The toolCallId is the raw tool_use.id VERBATIM — the FORK.md #2 "raw reuse accepted" verdict, now
  // wire-regression-guarded. A namespaced `${sessionId}:${toolUseId}` regression would fail here.
  assert.equal(
    toolCalls[0].update.toolCallId,
    TOOL_USE_ID,
    "the tool_call toolCallId must be the raw tool_use.id verbatim (non-namespaced)",
  );

  // No OTHER `tool_call` may smuggle the same id under a different/synthetic key (e.g. a namespaced
  // duplicate) — there is exactly one `tool_call` for this round-trip, full stop.
  const allToolCalls = sim.captured.filter((c) => c?.update?.sessionUpdate === "tool_call");
  assert.equal(
    allToolCalls.length,
    1,
    `the planted thread has ONE tool round-trip ⇒ exactly one tool_call over the wire; got ${allToolCalls.length}`,
  );

  // At least one `tool_call_update` carrying the SAME `toolCallId` — the update is CORRELATED to the
  // call and was NOT dropped on the wire.
  const updates = sim.captured.filter(
    (c) => c?.update?.sessionUpdate === "tool_call_update" && c.update.toolCallId === TOOL_USE_ID,
  );
  assert.ok(
    updates.length >= 1,
    `the tool_call_update must arrive correlated on "${TOOL_USE_ID}" (not dropped); got ${updates.length}. stderr:\n${collectStderr()}`,
  );
  // Every correlated update carries the verbatim raw id (defends against a partial namespacing on the
  // result path only).
  for (const u of updates) {
    assert.equal(
      u.update.toolCallId,
      TOOL_USE_ID,
      "each tool_call_update toolCallId must equal the tool_call's, verbatim — correlated by the raw id",
    );
  }

  // The call precedes its update over the wire (a `tool_call_update` ahead of its `tool_call` would be
  // an out-of-order regression Zed would render as an orphan update).
  const firstCallIdx = sim.captured.findIndex(
    (c) => c?.update?.sessionUpdate === "tool_call" && c.update.toolCallId === TOOL_USE_ID,
  );
  const firstUpdateIdx = sim.captured.findIndex(
    (c) => c?.update?.sessionUpdate === "tool_call_update" && c.update.toolCallId === TOOL_USE_ID,
  );
  assert.ok(
    firstCallIdx >= 0 && firstUpdateIdx > firstCallIdx,
    "the tool_call must arrive before its correlated tool_call_update over the wire",
  );
});
