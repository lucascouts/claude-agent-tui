// Story 017 / Task 2.2 — Support hidden/inline policies without reordering main turns.
//
// `hidden` omits sidechains; `inline` merges them in chronological position. BOTH leave the main
// turn order untouched (R2.3). The three policies differ ONLY in sidechain placement — the main-turn
// subsequence is byte-identical across hidden/inline/nested.
//
// NOTE: applySidechainPolicy was implemented in full at Task 2.1; this file is the Task 2.2
// REGRESSION GUARD for the hidden/inline contract (per project convention for the 017-021 slices,
// validated by tsc + the assertions below rather than a forced Red).
//
// node:test runner: `node --experimental-strip-types --test test/lin-policy-modes.test.ts`
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

const FIXTURE = [
  mainTurn("user", "u1"),
  taskTurn("a1", "toolu_1"),
  sideRow("side1", "toolu_1"),
  mainTurn("user", "u2"),
  mainTurn("assistant", "a2"),
];
const MAIN_ORDER = ["u1", "a1", "u2", "a2"];

/** The main-turn subsequence of a topLevel stream (sidechains filtered out). */
function mainSubsequence(topLevel: Array<{ uuid?: string; parent_tool_use_id?: string | null }>) {
  return topLevel.filter((m) => (m.parent_tool_use_id ?? null) === null).map((m) => m.uuid);
}

test("hidden: sidechains omitted; main order intact", () => {
  const { topLevel, nestedByToolUseId } = applySidechainPolicy(FIXTURE, "hidden");
  assert.deepEqual(topLevel.map((m) => m.uuid), MAIN_ORDER);
  assert.equal(nestedByToolUseId, undefined);
});

test("inline: sidechain merged in chronological position; main order intact", () => {
  const { topLevel } = applySidechainPolicy(FIXTURE, "inline");
  assert.deepEqual(topLevel.map((m) => m.uuid), ["u1", "a1", "side1", "u2", "a2"]);
  assert.deepEqual(mainSubsequence(topLevel), MAIN_ORDER);
});

test("main-turn subsequence is byte-identical across hidden/inline/nested (R2.3)", () => {
  const hidden = mainSubsequence(applySidechainPolicy(FIXTURE, "hidden").topLevel);
  const inline = mainSubsequence(applySidechainPolicy(FIXTURE, "inline").topLevel);
  const nested = mainSubsequence(applySidechainPolicy(FIXTURE, "nested").topLevel);
  assert.deepEqual(hidden, MAIN_ORDER);
  assert.deepEqual(inline, MAIN_ORDER);
  assert.deepEqual(nested, MAIN_ORDER);
});

test("linearizeTurns main-turn order is identical across policies", () => {
  const order = (p: "hidden" | "inline" | "nested") =>
    linearizeTurns(FIXTURE, { sidechainPolicy: p })
      .filter((t) => t.sidechain === undefined)
      .map((t) => t.uuid);
  assert.deepEqual(order("hidden"), MAIN_ORDER);
  assert.deepEqual(order("inline"), MAIN_ORDER);
  assert.deepEqual(order("nested"), MAIN_ORDER);
});
