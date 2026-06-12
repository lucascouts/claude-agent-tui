// Story 041 / Sub-task 3.1 (R3.2) — the `session/load` REPLAY path emits nested sub-agent
// `tool_call_update`s IDENTICALLY to the live tail pump for the same corpus (no replay-only divergence).
//
// This is the emit-layer sibling of `load-subagent-nested.test.ts` (sub-task 1.2, which proves the
// linearize layer). Sub-task 2.2 added the source+merge + nested-emit loop to `pumpUpdates` ONLY; the
// real Degrau-1 load path (`loadSession` → `replaySessionHistory`) had its OWN read+linearize+emit loop
// that called only the shared `emitTurnUpdates` per top-level turn and never sourced/merged/emitted the
// sidechain. So a LOADED thread rendered the Task but NOT the sub-agent nested under it — exactly the
// shape of the story-026 replay/live divergence (the diff block once lived only in the pump). This test
// drives the REAL replay path over the live-shaped fixture and pins:
//   (a) replay emits ≥1 nested `tool_call_update` on the spawning Task id (toolu_task_1), carrying the
//       sub-agent's content (R3.1 surfaced via the replay path);
//   (b) LIVE-vs-REPLAY EQUALITY (R3.2): the pump over the SAME corpus emits the SAME nested updates —
//       same toolCallIds, same content order — so loaded == live with no replay-only divergence.
//
// node:test runner: `node --experimental-strip-types --test test/load-replay-subagent.test.ts`
// (run `npm run build` first).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ClaudeAcpAgent } from "../dist/acp-agent.js";

const FIXTURE_URL = new URL("../fixtures/lin-live-subagent.jsonl", import.meta.url);

type Row = Record<string, unknown> & { uuid?: string; parent_tool_use_id?: unknown; isSidechain?: unknown };

/** All fixture rows, in transcript order. */
function loadRows(): Row[] {
  return readFileSync(FIXTURE_URL, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Row);
}

/**
 * Split the fixture into the two SOURCE streams the live path concatenates: the main chain (what
 * `getMessages` returns) and the SEPARATE sidechain rows (what `getSubagentMessages` returns). A row is
 * sidechain when it is flagged `isSidechain` or carries a `parent_tool_use_id` — IDENTICAL to the split
 * `load-subagent-nested.test.ts` uses, so both layers exercise the same corpus partition.
 */
function splitStreams(rows: Row[]): { mainChain: Row[]; subagentRows: Row[] } {
  const mainChain: Row[] = [];
  const subagentRows: Row[] = [];
  for (const r of rows) {
    if (r.isSidechain === true || typeof r.parent_tool_use_id === "string") subagentRows.push(r);
    else mainChain.push(r);
  }
  return { mainChain, subagentRows };
}

/**
 * Build an agent whose main transcript is `mainChain` (via `getMessages`) and whose sidechain rows are
 * resolved from a single synthetic agent (via the injected `listSubagents`/`getSubagentMessages`) — the
 * SAME 4th-arg `AgentDeps` injection the pump tests use. `replayOnly` chooses the engine flavor:
 *   - `true`  → watcher/engine undefined (the REAL Degrau-1 load: ONLY `replaySessionHistory` emits);
 *   - `false` → a fake watcher present (the live flavor the pump tests drive explicitly).
 * `captured` records every `sessionUpdate`; `listCalls` proves the R5.2 cheap-path probe count.
 */
function makeAgent(mainChain: Row[], subagentRows: Row[], replayOnly: boolean) {
  const captured: any[] = [];
  const listCalls: string[] = [];
  const client = {
    sessionUpdate: async (n: any) => {
      captured.push(n);
    },
    requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    readTextFile: async () => ({ content: "" }),
    writeTextFile: async () => ({}),
  } as never;
  const fakeStartEngine = (args: { sessionId?: string; cwd: string }) => ({
    sessionId: args.sessionId ?? "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    pty: { onExit: () => ({ dispose() {} }), onData: () => ({ dispose() {} }), resize() {}, write() {}, kill() {} } as never,
    watcher: replayOnly ? undefined : { stop() {}, notifyEndOfTurn() {} },
    engine: undefined,
    cwd: args.cwd,
  });
  const getMessages = async () => mainChain as never;
  const listSubagents = async (sessionId: string) => {
    listCalls.push(sessionId);
    return subagentRows.length ? ["agentA"] : [];
  };
  const getSubagentMessages = async (_sessionId: string, _agentId: string) => subagentRows as never;
  const agent: any = new ClaudeAcpAgent(client, undefined, undefined, {
    startEngine: fakeStartEngine,
    getMessages,
    listSubagents,
    getSubagentMessages,
  });
  return { agent, captured, listCalls };
}

/** The nested `tool_call_update`s targeting one parent id, in emission order. */
const nestedUpdatesOn = (captured: any[], toolCallId: string) =>
  captured.filter((c) => c.update?.sessionUpdate === "tool_call_update" && c.update?.toolCallId === toolCallId);

/**
 * Reduce captured updates to the comparable LIVE-vs-REPLAY shape: every `tool_call_update` projected to
 * `{ toolCallId, content }` in emission order. This is the byte-comparable surface R3.2 pins — same ids,
 * same content, same order — independent of which loop (pump or replay) produced it.
 */
const nestedShape = (captured: any[]) =>
  captured
    .filter((c) => c.update?.sessionUpdate === "tool_call_update")
    .map((c) => ({ toolCallId: c.update.toolCallId, content: c.update.content }));

const PARENT_ID = "toolu_task_1";

// (a) The REAL replay path emits the sub-agent nested under the spawning Task id (R3.1 via replay).
test("session/load replay emits nested sub-agent tool_call_update under the spawning Task id (R3.1)", async (t) => {
  const { mainChain, subagentRows } = splitStreams(loadRows());
  const { agent, captured } = makeAgent(mainChain, subagentRows, /*replayOnly*/ true);
  t.after(() => agent.dispose());

  await agent.loadSession({ sessionId: "11111111-1111-4111-8111-111111111111", cwd: "/proj", mcpServers: [] });

  const nested = nestedUpdatesOn(captured, PARENT_ID);
  assert.ok(
    nested.length >= 1,
    `the replay path must emit at least one nested tool_call_update on the Task id (got ${nested.length} = the replay-only-divergence gap)`,
  );
  const flat = JSON.stringify(nested);
  assert.ok(flat.includes("subagent step one"), "the sub-agent's first row is nested under the Task id");
  assert.ok(flat.includes("subagent step two"), "the sub-agent's second row is nested under the Task id");
});

// (b) LIVE-vs-REPLAY EQUALITY (R3.2) — the pump and the replay path emit the SAME nested updates for the
// SAME corpus: same toolCallIds, same content, same order. This is the no-replay-only-divergence pin.
test("replay emits nested tool_call_updates IDENTICALLY to the live pump for the same corpus (R3.2)", async (t) => {
  const { mainChain, subagentRows } = splitStreams(loadRows());

  // REPLAY flavor: the real Degrau-1 load (watcher/engine undefined) → only replaySessionHistory emits.
  const replay = makeAgent(mainChain, subagentRows, /*replayOnly*/ true);
  t.after(() => replay.agent.dispose());
  await replay.agent.loadSession({ sessionId: "11111111-1111-4111-8111-111111111111", cwd: "/proj", mcpServers: [] });

  // LIVE flavor: a fresh agent + fresh session, pumped explicitly over the SAME corpus.
  const live = makeAgent(mainChain, subagentRows, /*replayOnly*/ false);
  t.after(() => live.agent.dispose());
  const liveSession = (await live.agent.createSession({ cwd: "/proj", mcpServers: [] })).sessionId;
  await live.agent.pumpUpdates(liveSession);

  const replayNested = nestedShape(replay.captured);
  const liveNested = nestedShape(live.captured);

  assert.ok(replayNested.length >= 1, "guard: the live pump must emit at least one nested update for this corpus");
  // Same COUNT, same toolCallIds in order, same content in order — loaded == live (no divergence).
  assert.deepEqual(
    replayNested.map((n) => n.toolCallId),
    liveNested.map((n) => n.toolCallId),
    "replay and live must target the SAME toolCallIds in the SAME order",
  );
  assert.deepEqual(
    replayNested,
    liveNested,
    "replay and live must emit byte-identical nested tool_call_update content in the SAME order (R3.2)",
  );
  // And every nested update lands on the spawning Task id (no stray parent).
  assert.ok(
    replayNested.every((n) => n.toolCallId === PARENT_ID),
    "every nested update on the replay path targets the spawning Task id",
  );
});
