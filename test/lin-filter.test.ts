// Story 017 / Task 1.2 — Filter isSidechain/isMeta out of the top-level turn stream.
//
// `linearizeTurns` partitions the SDK message sequence into `main` (top-level user/assistant turns)
// and `sidechain`, and drops `isMeta`. The TOP-LEVEL stream it returns contains ONLY main-chain
// turns — sidechain and meta events are excluded (R1.2). Role is mapped from `.type` WITHOUT
// enumerating a fixed type set (forward-compat with story 016's tolerant switch): an unknown `.type`
// still produces a Turn (role echoed verbatim) for downstream ignore.
//
// RECONCILIATION (Option 1): the LIVE getSessionMessages output is ALREADY main-chain only (E5;
// isSidechain/isMeta filtered by the SDK). These fixtures are RAW-shaped (carry isSidechain/isMeta)
// to exercise the partition logic directly — the same logic that, fed a raw-JSONL fallback source
// (R1.3) or a getSubagentMessages merge, keeps sidechain/meta out of the top level.
//
// node:test runner: `node --experimental-strip-types --test test/lin-filter.test.ts`
import { test } from "node:test";
import assert from "node:assert/strict";
import { linearizeTurns } from "../dist/linearize.js";

/** Build a raw-shaped message carrying the partition signals (isSidechain / isMeta / parent_tool_use_id). */
function msg(
  type: string,
  uuid: string,
  extra: { isSidechain?: boolean; isMeta?: boolean; parent_tool_use_id?: string | null } = {},
) {
  return {
    type,
    uuid,
    session_id: "sess",
    message: { content: [] },
    parent_tool_use_id: extra.parent_tool_use_id ?? null,
    ...(extra.isSidechain !== undefined ? { isSidechain: extra.isSidechain } : {}),
    ...(extra.isMeta !== undefined ? { isMeta: extra.isMeta } : {}),
  };
}

test("top-level stream excludes resolved sidechain and meta, keeps main turns intact", () => {
  const messages = [
    msg("user", "u1"),
    // a1 spawns a Task tool_use; side1 (isSidechain, resolving to it) is nested out of the top level.
    {
      type: "assistant",
      uuid: "a1",
      session_id: "sess",
      parent_tool_use_id: null,
      message: { content: [{ type: "tool_use", id: "toolu_x", name: "Task" }] },
    },
    msg("assistant", "side1", { isSidechain: true, parent_tool_use_id: "toolu_x" }),
    msg("system", "meta1", { isMeta: true }),
    msg("user", "u2"),
  ];

  const turns = linearizeTurns(messages);

  // Only the 3 main-chain turns survive, in order (meta always excluded; resolved sidechain nested).
  assert.deepEqual(
    turns.map((t) => t.uuid),
    ["u1", "a1", "u2"],
  );
  // Validation contract: top-level count === main-chain count.
  assert.equal(turns.length, 3);
});

test("a non-null parent_tool_use_id is treated as a sidechain signal (reduced live shape)", () => {
  // In the reduced SDK shape there is no isSidechain field; the only sidechain signal is a non-null
  // parent_tool_use_id (a subagent row). A sidechain that RESOLVES to a spawning tool_use on the main
  // chain is held OUT of the top-level stream (nested under the default policy). (An UNRESOLVED orphan
  // is placed inline instead — that is exercised in lin-policy-orphan.test.ts, Task 2.3.)
  const messages = [
    msg("user", "u1"),
    {
      type: "assistant",
      uuid: "a1",
      session_id: "sess",
      parent_tool_use_id: null,
      message: { content: [{ type: "tool_use", id: "toolu_task_1", name: "Task" }] },
    },
    msg("assistant", "nested1", { parent_tool_use_id: "toolu_task_1" }),
    msg("user", "u2"),
  ];
  const turns = linearizeTurns(messages);
  assert.deepEqual(
    turns.map((t) => t.uuid),
    ["u1", "a1", "u2"],
  );
});

test("role is echoed from .type without enumerating a fixed set (forward-compat)", () => {
  const messages = [msg("user", "u1"), msg("assistant", "a1"), msg("future-type", "f1")];
  const turns = linearizeTurns(messages);
  assert.deepEqual(
    turns.map((t) => t.role),
    ["user", "assistant", "future-type"],
  );
  // The unknown type still produces a top-level Turn (left for the §7 tolerant switch to ignore).
  assert.equal(turns.length, 3);
});

test("each Turn carries uuid, role, message passthrough and an orderKey", () => {
  const m = msg("user", "u1");
  const [turn] = linearizeTurns([m]);
  assert.equal(turn.uuid, "u1");
  assert.equal(turn.role, "user");
  assert.equal(turn.message, m); // passed through untouched (same reference) to the translator
  assert.equal(typeof turn.orderKey, "string");
  assert.ok(turn.orderKey.length > 0);
});
