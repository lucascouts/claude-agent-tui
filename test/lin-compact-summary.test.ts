// Story 017 / Task 4.2 — Cover the post-/compact summary anchor (R4.3).
//
// A post-`/compact` `summary` event is the chain ANCHOR for the first subsequent turn — NOT a
// rendered user/assistant turn. getSessionMessages excludes it from the main chain on the LIVE path
// (system/summary are not returned by default). linearizeTurns mirrors that: a `summary` (and any
// `system`) row is treated as a continuity anchor, kept OUT of the top-level turns, and the linear
// order stays continuous across the compaction boundary (no gap, no duplicate).
//
// node:test runner: `node --experimental-strip-types --test test/lin-compact-summary.test.ts`
import { test } from "node:test";
import assert from "node:assert/strict";
import { linearizeTurns } from "../dist/linearize.js";

function row(type: string, uuid: string) {
  return { type, uuid, session_id: "s", parent_tool_use_id: null, message: { content: [] } };
}

test("summary is not emitted as a top-level turn; order is continuous across the boundary", () => {
  const messages = [
    row("user", "u1"),
    row("assistant", "a1"),
    row("summary", "sum1"), // post-/compact anchor — NOT a turn
    row("user", "u2"),
    row("assistant", "a2"),
  ];
  const turns = linearizeTurns(messages);

  // The summary is absent from the rendered turns.
  assert.deepEqual(
    turns.map((t) => t.uuid),
    ["u1", "a1", "u2", "a2"],
  );
  assert.ok(!turns.some((t) => t.role === "summary"));

  // Order is CONTINUOUS across the boundary: orderKeys strictly increasing, no gap, no duplicate.
  const keys = turns.map((t) => t.orderKey);
  assert.deepEqual(keys, [...keys].sort());
  assert.equal(new Set(keys).size, keys.length);
});

test("a 'system' row is likewise treated as a non-turn anchor", () => {
  const turns = linearizeTurns([row("user", "u1"), row("system", "sys1"), row("assistant", "a1")]);
  assert.deepEqual(
    turns.map((t) => t.uuid),
    ["u1", "a1"],
  );
});
