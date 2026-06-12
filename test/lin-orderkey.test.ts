// Story 017 / Task 3.1 — Assign a stable, uuid-anchored, append-only order key.
//
// `chainPositionKey` derives each turn's order key from its uuid-anchored monotonic chain POSITION
// (RECONCILED: array position, since parentUuid is absent in the reduced live shape — see
// .draft/deviations.yaml). Because getSessionMessages returns a monotonic ordered SUPERSET on each
// re-parse (E5), a turn at order k stays k after appends: re-parsing a prefix then prefix+appended
// lines yields byte-identical orderKeys for the shared prefix, with only the new turns appended
// (R3.1, R3.2). A previously ordered turn is never re-keyed or re-emitted.
//
// node:test runner: `node --experimental-strip-types --test test/lin-orderkey.test.ts`
import { test } from "node:test";
import assert from "node:assert/strict";
import { chainPositionKey, linearizeTurns } from "../dist/linearize.js";

function mainTurn(type: string, uuid: string) {
  return { type, uuid, session_id: "s", parent_tool_use_id: null, message: { content: [] } };
}

test("chainPositionKey is deterministic for the same uuid + position", () => {
  assert.equal(chainPositionKey("u1", 0), chainPositionKey("u1", 0));
  // Distinct positions sort by position; distinct uuids at the same position differ.
  assert.ok(chainPositionKey("u1", 0) < chainPositionKey("u2", 1));
  assert.notEqual(chainPositionKey("uA", 0), chainPositionKey("uB", 0));
});

test("re-parse extends the order: shared-prefix orderKeys are byte-identical, only new turns appended", () => {
  const prefix = [mainTurn("user", "u1"), mainTurn("assistant", "a1")];
  const extended = [...prefix, mainTurn("user", "u2"), mainTurn("assistant", "a2")];

  const first = linearizeTurns(prefix);
  const second = linearizeTurns(extended);

  // The shared prefix keeps identical orderKeys (no reshuffle, no re-key — R3.1/R3.2).
  assert.deepEqual(
    second.slice(0, first.length).map((t) => t.orderKey),
    first.map((t) => t.orderKey),
  );
  // Only the new turns are appended after the shared prefix.
  assert.deepEqual(
    second.slice(first.length).map((t) => t.uuid),
    ["u2", "a2"],
  );
  // The full key sequence is strictly increasing (stable, append-only ordering).
  const keys = second.map((t) => t.orderKey);
  const sorted = [...keys].sort();
  assert.deepEqual(keys, sorted);
});

test("orderKey is uuid-anchored: same position, different uuid → different key", () => {
  const a = linearizeTurns([mainTurn("user", "uX")]);
  const b = linearizeTurns([mainTurn("user", "uY")]);
  assert.notEqual(a[0].orderKey, b[0].orderKey);
});
