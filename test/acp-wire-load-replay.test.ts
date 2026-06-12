// Story 038 / Task 1.2 — ACP-wire load-replay: drive the BUILT fork's replay-only `session/load`
// over the REAL JSON-RPC stdio transport against a transcript planted in an ISOLATED config dir
// (R1.3, R1.4, R5.1).
//
// This is the over-the-wire regression artifact for §4/§11 replay. We plant a small multi-turn
// transcript under a THROWAWAY `.claude` (never the user's real `~/.claude`), spawn `node
// dist/index.js` with `CLAUDE_CONFIG_DIR`/`HOME` pointed at that temp dir, complete `initialize`,
// then call `agent.loadSession({ sessionId, cwd, mcpServers: [] })`. In the child the `getMessages`
// seam is undefined, so `replaySessionHistory → readOrderedMessages` falls through to the genuine
// SDK reader `getSessionMessages(sessionId, { dir: cwd })`, which resolves the PLANTED file at
// `<configDir>/projects/<F0(cwd)>/<sessionId>.jsonl`. We assert the captured `session/update` stream
// reproduces the planted turns in chronological order — every notification having crossed the real
// transport, sourced from the temp dir, with the user's real `~/.claude` untouched.
//
// READ-ONLY (R5.1): only `initialize` + `loadSession` are issued — never `session/prompt`; no
// `claude`/PTY is spawned, no network. Un-gated under `node --test`: the child is reaped AND the
// temp dir removed in `t.after(() => sim.dispose())` on success OR failure.
//
// Run: `npm --prefix fork run build && node --experimental-strip-types --test test/acp-wire-load-replay.test.ts`
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startZedSim } from "./helpers/zed-sim-client.ts";
import { plantTranscript, projectSlug, type PlantMessage } from "./helpers/plant-transcript.ts";

// A FIXED FICTIONAL cwd: a non-existent path is the most deterministic choice — the SDK's realpath
// step falls back to the literal, so the project slug F0(cwd) is stable across machines/runs.
const SIM_CWD = "/zedsim/proj";

// A multi-turn thread (user → assistant → user → assistant): 4 turns with DISTINCT texts so a
// chronological-order assertion is unambiguous. The planter builds the linear parentUuid chain so
// the SDK reader returns all four (not just the leaf).
const TURNS: PlantMessage[] = [
  { type: "user", message: { role: "user", content: [{ type: "text", text: "first user turn" }] } },
  { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "first assistant reply" }] } },
  { type: "user", message: { role: "user", content: [{ type: "text", text: "second user turn" }] } },
  { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "second assistant reply" }] } },
];
const EXPECTED_TEXTS = [
  "first user turn",
  "first assistant reply",
  "second user turn",
  "second assistant reply",
];

// Race a wire call against a timeout so a deadlocked transport or a never-resolving load FAILS loudly
// with the child's stderr instead of hanging the suite (mirrors the smoke test).
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

test("ACP-wire load-replay (§4/§11): loadSession replays a planted transcript in chronological order over real stdio (R1.3)", async (t) => {
  // 1) Plant the transcript in an isolated config dir (UUID sessionId, linear parentUuid chain).
  const planted = plantTranscript({ cwd: SIM_CWD, messages: TURNS });

  // The fixture really exists where the SDK reader will look — guards against a planter path drift
  // before we blame the wire for an empty replay.
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

  // 3) `initialize` MUST precede `loadSession` over the wire (handshake first — cf. the smoke test).
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

  // The replay emitted notifications across the wire — a silent `[]` (e.g. a non-UUID sessionId trap
  // or a config-dir that missed the planted file) would leave this empty.
  assert.ok(sim.captured.length > 0, `loadSession must emit session/update notifications; stderr:\n${collectStderr()}`);

  // Chronological order: extract `update.content.text` from the *_message_chunk notifications and
  // assert the planted turns reproduce in order, with no drop or reorder (mirrors
  // e2e-session-load-replay.test.ts:80-85).
  const texts = sim.captured
    .filter((c) => c?.update?.content?.type === "text")
    .map((c) => c.update.content.text);
  assert.deepEqual(
    texts,
    EXPECTED_TEXTS,
    `the planted turns must replay in chronological order over the wire; stderr:\n${collectStderr()}`,
  );

  // 5) Isolation (R1.4): the child's effective config dir is the planter's temp dir, NOT under the
  //    user's real HOME / real `~/.claude`. The transcript could ONLY have come from the temp dir.
  const realHome = os.homedir();
  assert.equal(sim.configDir, planted.configDir, "the child must run under the PLANTED config dir");
  assert.ok(
    !planted.configDir.startsWith(path.join(realHome, ".claude")),
    "the planted config dir must NOT be under the user's real ~/.claude",
  );
  assert.ok(
    !planted.transcriptPath.startsWith(path.join(realHome, ".claude")),
    "no replayed item may be sourced from the user's real ~/.claude",
  );
});

test("ACP-wire load-replay: dispose() reaps the child AND removes the planted temp dir, idempotently (R5.2)", async (t) => {
  const planted = plantTranscript({ cwd: SIM_CWD, messages: TURNS });
  const sim = startZedSim({ configDir: planted.configDir, home: planted.home, cleanup: planted.cleanup });
  t.after(() => sim.dispose());

  await withTimeout(
    sim.agent.initialize({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    }),
    15000,
    () => "",
  );

  // The temp dir exists before teardown.
  assert.ok(fs.existsSync(planted.home), "the planted temp dir exists before dispose");

  // First dispose kills the child + removes the temp dir; a second call is a safe no-op.
  sim.dispose();
  sim.dispose();
  assert.equal(sim.child.killed, true, "the spawned fork child must be killed after dispose()");
  assert.equal(fs.existsSync(planted.home), false, "dispose() must remove the planted temp dir");
});
