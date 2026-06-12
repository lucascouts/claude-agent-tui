// Story 038 / Task 1.1 — ACP-wire smoke: the harness spawns the BUILT fork and completes
// `initialize` over the REAL JSON-RPC stdio transport (R1.1, R1.2, R5.1, R5.2).
//
// This is the over-the-wire regression artifact for the §15 handshake. `startZedSim`
// spawns `node dist/index.js` (its no-`--cli` runAcp branch) and connects via the SDK's
// own ClientSideConnection over ndJsonStream(child.stdin/child.stdout). We then call
// `agent.initialize(...)` and assert the negotiated reply carries the integer
// `protocolVersion === 1` and `agentCapabilities.loadSession === true` — proving the value
// crossed the genuine transport, not an in-process call (cf. initialize-protocol.test.ts,
// the in-process UNIT guard of the same shape).
//
// Fully offline (R5.1): no `claude`/PTY is spawned, no network. Un-gated under `node
// --test` (R5.2): no RUN_INTEGRATION_TESTS; the child is reaped in `t.after` on success OR
// failure, so the runner exits cleanly with no `--test-force-exit`.
//
// Run: `npm --prefix fork run build && node --experimental-strip-types --test test/acp-wire-smoke.test.ts`
import { test } from "node:test";
import assert from "node:assert/strict";
import { startZedSim } from "./helpers/zed-sim-client.ts";

// Race the handshake against a timeout so a deadlocked transport (e.g. swapped stream
// order) FAILS loudly with the child's stderr, instead of hanging the suite.
function withTimeout<T>(promise: Promise<T>, ms: number, getInfo: () => string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`initialize over the ACP wire timed out after ${ms}ms. Agent stderr:\n${getInfo()}`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

test("ACP-wire smoke (§15): initialize over real stdio negotiates protocolVersion 1 + loadSession (R1.1, R1.2)", async (t) => {
  const sim = startZedSim();
  // Guaranteed teardown on success OR failure — reaps the spawned fork (R5.2).
  t.after(() => sim.dispose());

  const collectStderr = (sim.child as { collectedStderr?: () => string }).collectedStderr ?? (() => "");

  const initResult: any = await withTimeout(
    sim.agent.initialize({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    }),
    15000,
    collectStderr,
  );

  // protocolVersion pinned to the INTEGER 1 (rejects a string-"1" regression) — proven over
  // the wire, having survived JSON-RPC encode/decode.
  assert.equal(typeof initResult.protocolVersion, "number", "protocolVersion must be a number, not a string");
  assert.ok(Number.isInteger(initResult.protocolVersion), "protocolVersion must be an integer");
  assert.equal(initResult.protocolVersion, 1, "protocolVersion must be exactly 1 over the wire");

  // The capability Zed reads to enable session/load must round-trip as true.
  assert.ok(
    initResult.agentCapabilities && typeof initResult.agentCapabilities === "object",
    "agentCapabilities must be present in the wire response",
  );
  assert.equal(
    initResult.agentCapabilities.loadSession,
    true,
    "agentCapabilities.loadSession must be true over the wire",
  );

  // READ-ONLY initialize triggers no agent→client notifications.
  assert.deepEqual(sim.captured, [], "initialize alone must emit no sessionUpdate notifications");
});

test("ACP-wire smoke: dispose() is idempotent and leaves no live child (R5.2)", async (t) => {
  const sim = startZedSim();
  t.after(() => sim.dispose());

  await withTimeout(
    sim.agent.initialize({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    }),
    15000,
    () => "",
  );

  // First dispose kills the child; a second call is a safe no-op (idempotent guard).
  sim.dispose();
  sim.dispose();
  assert.equal(sim.child.killed, true, "the spawned fork child must be killed after dispose()");
});
