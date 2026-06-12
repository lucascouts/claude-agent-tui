// Story 017 / Task 2.3 — Orphan-sidechain handling.
//
// Under `nested`, a sidechain whose `parent_tool_use_id` does not resolve to a tool_use present in
// the main stream is an ORPHAN. It must NOT be silently dropped: it is placed INLINE in chronological
// position, and the drift sink fires exactly once for it (per the §6 forward-compat posture, R2.2).
//
// NOTE: implemented at Task 2.1; this is the Task 2.3 REGRESSION GUARD (tsc + assertions).
//
// node:test runner: `node --experimental-strip-types --test test/lin-policy-orphan.test.ts`
import { test } from "node:test";
import assert from "node:assert/strict";
import { applySidechainPolicy, linearizeTurns } from "../dist/linearize.js";

function taskTurn(uuid: string, toolId: string) {
  return {
    type: "assistant",
    uuid,
    session_id: "s",
    parent_tool_use_id: null,
    message: { content: [{ type: "tool_use", id: toolId, name: "Task", input: {} }] },
  };
}
function mainTurn(type: string, uuid: string) {
  return { type, uuid, session_id: "s", parent_tool_use_id: null, message: { content: [] } };
}
function sideRow(uuid: string, parentToolId: string) {
  return { type: "assistant", uuid, session_id: "s", parent_tool_use_id: parentToolId, message: { content: [] } };
}

// `orphan1` points at `toolu_MISSING`, which no main tool_use provides; `side1` resolves to toolu_1.
const FIXTURE = [
  mainTurn("user", "u1"),
  taskTurn("a1", "toolu_1"),
  sideRow("side1", "toolu_1"),
  sideRow("orphan1", "toolu_MISSING"),
  mainTurn("user", "u2"),
];

test("orphan is placed inline (not dropped) and never grouped under a wrong parent", () => {
  const drifts: unknown[] = [];
  const { topLevel, nestedByToolUseId } = applySidechainPolicy(FIXTURE, "nested", {
    onDrift: (r) => drifts.push(r),
  });

  // The orphan appears exactly once, inline at its chronological position (after the resolved side1,
  // before u2). The resolved side1 is nested (absent from topLevel).
  const uuids = topLevel.map((m) => m.uuid);
  assert.deepEqual(uuids, ["u1", "a1", "orphan1", "u2"]);
  assert.equal(uuids.filter((u) => u === "orphan1").length, 1);

  // The orphan is NOT attached to any parent group.
  for (const group of nestedByToolUseId!.values()) {
    assert.ok(!group.some((m) => m.uuid === "orphan1"), "orphan must not be nested under any parent");
  }
  assert.deepEqual((nestedByToolUseId!.get("toolu_1") ?? []).map((m) => m.uuid), ["side1"]);
});

test("the drift sink fires exactly once for the orphan", () => {
  const drifts: Array<{ kind: string; parentToolUseId: string | null; uuid: string }> = [];
  applySidechainPolicy(FIXTURE, "nested", { onDrift: (r) => drifts.push(r) });
  assert.equal(drifts.length, 1);
  assert.deepEqual(drifts[0], {
    kind: "orphan-sidechain",
    parentToolUseId: "toolu_MISSING",
    uuid: "orphan1",
  });
});

test("linearizeTurns surfaces the orphan inline with an upward sidechain pointer", () => {
  const turns = linearizeTurns(FIXTURE, { sidechainPolicy: "nested", onDrift: () => {} });
  const orphan = turns.find((t) => t.uuid === "orphan1");
  assert.ok(orphan, "orphan must appear as a top-level turn");
  assert.deepEqual(orphan!.sidechain, { parentToolUseId: "toolu_MISSING" });
});
