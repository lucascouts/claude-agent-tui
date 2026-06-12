// Story 017 / Task 2.1 — Implement the chosen flattening policy (nested via parent_tool_use_id).
//
// Under the default `nested` policy, each sidechain (subagent) event is attached under its spawning
// `Task` tool_use via `parent_tool_use_id` — it NEVER appears as a free-standing top-level turn, and
// the top-level turn count stays equal to the main-chain count (R2.1, R2.2). `applySidechainPolicy`
// returns `{ topLevel, nestedByToolUseId }`; every resolved sidechain groups under a parentToolUseId
// that is present (as a tool_use id) in the main stream.
//
// node:test runner: `node --experimental-strip-types --test test/lin-policy-nested.test.ts`
import { test } from "node:test";
import assert from "node:assert/strict";
import { applySidechainPolicy, linearizeTurns } from "../dist/linearize.js";

/** A main assistant turn whose content carries a `Task` tool_use with id `toolId`. */
function taskTurn(uuid: string, toolId: string) {
  return {
    type: "assistant",
    uuid,
    session_id: "s",
    parent_tool_use_id: null,
    message: { content: [{ type: "tool_use", id: toolId, name: "Task", input: {} }] },
  };
}
/** A plain main user/assistant turn. */
function mainTurn(type: string, uuid: string) {
  return { type, uuid, session_id: "s", parent_tool_use_id: null, message: { content: [] } };
}
/** A sidechain (subagent) row spawned by `parentToolId`. */
function sideRow(uuid: string, parentToolId: string) {
  return {
    type: "assistant",
    uuid,
    session_id: "s",
    parent_tool_use_id: parentToolId,
    message: { content: [] },
  };
}

const FIXTURE = [
  mainTurn("user", "u1"),
  taskTurn("a1", "toolu_task_1"), // spawns the sidechain
  sideRow("side1", "toolu_task_1"),
  sideRow("side2", "toolu_task_1"),
  mainTurn("user", "u2"),
];

test("nested: sidechains group under their spawning tool_use id, none in top level", () => {
  const { topLevel, nestedByToolUseId } = applySidechainPolicy(FIXTURE, "nested");
  // Top-level count equals the main-chain count (3 main turns).
  assert.deepEqual(
    topLevel.map((m) => m.uuid),
    ["u1", "a1", "u2"],
  );
  // The two sidechain rows are grouped under the Task tool_use id.
  assert.ok(nestedByToolUseId, "nestedByToolUseId must be present under the nested policy");
  assert.deepEqual(
    (nestedByToolUseId.get("toolu_task_1") ?? []).map((m) => m.uuid),
    ["side1", "side2"],
  );
});

test("nested: every sidechain resolves to a parentToolUseId present in the main stream", () => {
  const { nestedByToolUseId } = applySidechainPolicy(FIXTURE, "nested");
  // The only key is the Task tool_use id that exists on the main chain.
  assert.deepEqual([...nestedByToolUseId!.keys()], ["toolu_task_1"]);
});

test("nested: linearizeTurns attaches nested children to the spawning parent turn", () => {
  const turns = linearizeTurns(FIXTURE, { sidechainPolicy: "nested" });
  assert.deepEqual(
    turns.map((t) => t.uuid),
    ["u1", "a1", "u2"],
  );
  const parent = turns.find((t) => t.uuid === "a1")!;
  assert.deepEqual((parent.nested ?? []).map((m) => m.uuid), ["side1", "side2"]);
  // No top-level turn is itself a sidechain.
  assert.ok(turns.every((t) => t.sidechain === undefined));
});
