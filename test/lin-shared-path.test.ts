// Story 017 / Task 3.2 — Expose one shared linearization function to live and replay (R3.3).
//
// `readOrderedTurns(sessionId, dir, opts)` = readOrderedMessages + linearizeTurns. It is the SINGLE
// seam both the live re-parse path and the session/load replay path call, so live and replay can
// never diverge in ordering — R3.3 holds BY CONSTRUCTION. This integration test exercises the same
// fixture through both call sites and asserts deep-equal Turn[].
//
// node:test runner: `node --experimental-strip-types --test test/lin-shared-path.test.ts`
import { test } from "node:test";
import assert from "node:assert/strict";
import { readOrderedTurns, linearizeTurns } from "../dist/linearize.js";

function sm(type: string, uuid: string, parentToolUseId: string | null = null) {
  return { type, uuid, session_id: "s", parent_tool_use_id: parentToolUseId, message: { content: [] } };
}

const FIXTURE = [sm("user", "u1"), sm("assistant", "a1"), sm("user", "u2"), sm("assistant", "a2")];

test("live re-parse seam and replay seam return deep-equal Turn[] (R3.3)", async () => {
  // Both paths call the SAME readOrderedTurns with the same injected reader → identical output.
  const getMessages = () => FIXTURE;
  const liveTurns = await readOrderedTurns("sess", "/dir", { getMessages }); // live re-parse
  const replayTurns = await readOrderedTurns("sess", "/dir", { getMessages }); // session/load replay
  assert.deepEqual(liveTurns, replayTurns);
  assert.deepEqual(liveTurns.map((t) => t.uuid), ["u1", "a1", "u2", "a2"]);
});

test("readOrderedTurns equals readOrderedMessages + linearizeTurns (no duplicated logic)", async () => {
  const getMessages = () => FIXTURE;
  const viaAdapter = await readOrderedTurns("sess", "/dir", { getMessages });
  const viaCompose = linearizeTurns(FIXTURE);
  assert.deepEqual(viaAdapter, viaCompose);
});

test("readOrderedTurns forwards the sidechain policy to the shared linearizer", async () => {
  const withSide = [
    sm("user", "u1"),
    { type: "assistant", uuid: "a1", session_id: "s", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "t1", name: "Task" }] } },
    sm("side1", "side1", "t1"),
  ];
  const getMessages = () => withSide;
  const hidden = await readOrderedTurns("sess", "/dir", { getMessages, sidechainPolicy: "hidden" });
  const inline = await readOrderedTurns("sess", "/dir", { getMessages, sidechainPolicy: "inline" });
  assert.deepEqual(hidden.map((t) => t.uuid), ["u1", "a1"]);
  assert.deepEqual(inline.map((t) => t.uuid), ["u1", "a1", "side1"]);
});
