// Story 041 / Sub-task 1.2 — Merge → linearizeTurns nested attach (live-shaped fixture).
//
// PROVES the live render path: the main chain and the SEPARATE sub-agent rows arrive as two streams
// (story 041 merges them as `mainChain.concat(subagentRows)` BEFORE linearization — design key
// decision #1, merge-before-linearize, reusing story 017's nested policy UNCHANGED). Fed through
// `linearizeTurns` under the default `nested` policy, the merged stream must:
//   - hydrate `Turn.nested` on the spawning turn, keyed by `parent_tool_use_id` (R1.1);
//   - order `Turn.nested` by `uuid` (R1.2) — the fixture deliberately feeds the rows OUT of uuid
//     order (`sb-z2` before `sb-a1`) so this assertion cannot pass by input-order coincidence;
//   - fall back to story 017's orphan policy for an unmatched sub-agent row: placed INLINE as a
//     top-level turn AND logged via the injectable drift sink — never silently dropped (R1.3).
//
// REGRESSION-GUARD NOTE: this sub-task reuses story 017's nested policy, so the merge path may pass
// on first run (project memory `degrau1-type-or-reuse-subtask-unexpected-green`). The assertions are
// honest regression guards — the orphan-fallback and uuid-ordering checks are where correctness is
// actually pinned. The fixture is the live (reduced 6-field) shape, distinct from the 017 raw fixture.
//
// node:test runner: `node --experimental-strip-types --test test/load-subagent-nested.test.ts`
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { linearizeTurns } from "../dist/linearize.js";
import type { SidechainDriftRecord, Turn } from "../dist/linearize.js";

const FIXTURE_URL = new URL("../fixtures/lin-live-subagent.jsonl", import.meta.url);
const EXPECTED_URL = new URL("../fixtures/lin-live-subagent.expected.json", import.meta.url);

type Row = Record<string, unknown> & { uuid?: string };

/** All fixture rows, in transcript order (the merged stream as it would arrive on the live path). */
function loadRows(): Row[] {
  return readFileSync(FIXTURE_URL, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Row);
}

/** Split the merged transcript back into the two SOURCE streams story 041 concatenates. */
function splitStreams(rows: Row[]): { mainChain: Row[]; subagentRows: Row[] } {
  const mainChain: Row[] = [];
  const subagentRows: Row[] = [];
  for (const r of rows) {
    if (r.isSidechain === true || typeof r.parent_tool_use_id === "string") subagentRows.push(r);
    else mainChain.push(r);
  }
  return { mainChain, subagentRows };
}

/** Project a Turn[] to the frozen reference shape (orderKey/uuid/role/nested uuids) — mirrors 017. */
function project(turns: Turn[]) {
  return turns.map((t) => ({
    orderKey: t.orderKey,
    uuid: t.uuid,
    role: t.role,
    nested: (t.nested ?? []).map((m) => (m as Row).uuid),
  }));
}

test("split: the live fixture yields a main chain + SEPARATE sub-agent rows (the two merge inputs)", () => {
  const { mainChain, subagentRows } = splitStreams(loadRows());
  // Main chain carries the Task spawner but NONE of the sidechain rows.
  assert.deepEqual(mainChain.map((r) => r.uuid), ["u1", "a1", "u2", "a2"]);
  // 2 resolved sub-agent rows (under one Task) + 1 orphan = 3 separate rows.
  assert.deepEqual(subagentRows.map((r) => r.uuid), ["sb-z2", "sb-a1", "orphan1"]);
});

test("merge-before-linearize: concat(mainChain, subagentRows) hydrates Turn.nested by parent_tool_use_id (R1.1)", () => {
  const { mainChain, subagentRows } = splitStreams(loadRows());
  const turns = linearizeTurns(mainChain.concat(subagentRows), { sidechainPolicy: "nested" });

  const spawner = turns.find((t) => t.uuid === "a1");
  assert.ok(spawner, "the Task-spawning turn a1 must remain a top-level turn");
  // The matching sub-agent rows hydrate onto the spawning turn (keyed by toolu_task_1), not top level.
  assert.deepEqual(
    (spawner.nested ?? []).map((m) => (m as Row).uuid).sort(),
    ["sb-a1", "sb-z2"],
    "both resolved sub-agent rows must attach under their spawning Task",
  );
  // No resolved (matched) sub-agent row leaks into the top level.
  assert.ok(!turns.some((t) => t.uuid === "sb-a1" || t.uuid === "sb-z2"),
    "matched sub-agent rows must NOT appear as top-level turns");
});

test("ordering: Turn.nested is sorted by uuid even when fed out of uuid order (R1.2)", () => {
  const { mainChain, subagentRows } = splitStreams(loadRows());
  // subagentRows arrive as [sb-z2, sb-a1] — OUT of uuid order on purpose.
  assert.deepEqual(
    subagentRows.filter((r) => r.parent_tool_use_id === "toolu_task_1").map((r) => r.uuid),
    ["sb-z2", "sb-a1"],
    "guard: the fixture must feed the rows out of uuid order for this test to be meaningful",
  );
  const turns = linearizeTurns(mainChain.concat(subagentRows), { sidechainPolicy: "nested" });
  const spawner = turns.find((t) => t.uuid === "a1")!;
  assert.deepEqual(
    (spawner.nested ?? []).map((m) => (m as Row).uuid),
    ["sb-a1", "sb-z2"],
    "Turn.nested must be ordered by uuid, not by input/insertion order",
  );
});

test("orphan fallback (R1.3): an unmatched sub-agent row is placed INLINE and logged, never dropped", () => {
  const { mainChain, subagentRows } = splitStreams(loadRows());
  const drift: SidechainDriftRecord[] = [];
  const turns = linearizeTurns(mainChain.concat(subagentRows), {
    sidechainPolicy: "nested",
    onDrift: (r) => drift.push(r),
  });

  // (a) NOT dropped — the orphan survives as a top-level turn in chronological position.
  const orphanTurn = turns.find((t) => t.uuid === "orphan1");
  assert.ok(orphanTurn, "orphan sub-agent row must NOT be silently dropped — it stays inline");
  assert.deepEqual(orphanTurn.sidechain, { parentToolUseId: "toolu_missing_99" },
    "the inline orphan turn must point up to its (unresolved) claimed Task id");

  // (b) Logged exactly once via the injected drift sink, with the unresolved parent id + uuid.
  const orphanDrift = drift.filter((d) => d.uuid === "orphan1");
  assert.equal(orphanDrift.length, 1, "the orphan must emit exactly one drift record");
  assert.deepEqual(orphanDrift[0], {
    kind: "orphan-sidechain",
    parentToolUseId: "toolu_missing_99",
    uuid: "orphan1",
  });

  // (c) The orphan is NOT attached as nested under any turn (it didn't resolve to a real Task).
  assert.ok(!turns.some((t) => (t.nested ?? []).some((m) => (m as Row).uuid === "orphan1")),
    "an unresolved orphan must not be attached as a nested child of any turn");
});

test("full projection of the merged live stream equals the recorded expected order", () => {
  const { mainChain, subagentRows } = splitStreams(loadRows());
  const expected = JSON.parse(readFileSync(EXPECTED_URL, "utf8"));
  const turns = linearizeTurns(mainChain.concat(subagentRows), { sidechainPolicy: "nested" });
  assert.deepEqual(project(turns), expected);
});
