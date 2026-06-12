// Story 017 / Task 4.4 — Assert linearized order matches the reference transcript (live + replay).
//
// Runs the reference fixture through the SHARED readOrderedTurns seam (the single function both the
// live re-parse and session/load replay call) and asserts the produced order — uuid + stable
// orderKey + nested sidechain attachment — equals the recorded expected.json EXACTLY (R5.1, R5.2).
// Because both seams are the same function, the live and replay results are deep-equal by construction.
//
// node:test runner: `node --experimental-strip-types --test test/lin-reference-order.test.ts`
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readOrderedTurns } from "../dist/linearize.js";

const FIXTURE_URL = new URL("../fixtures/lin-task-sidechain.jsonl", import.meta.url);
const EXPECTED_URL = new URL("../fixtures/lin-task-sidechain.expected.json", import.meta.url);

const messages = readFileSync(FIXTURE_URL, "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));
const expected = JSON.parse(readFileSync(EXPECTED_URL, "utf8"));

/** Project a Turn[] to the frozen reference shape (orderKey/uuid/role/nested uuids). */
function project(turns: Array<{ orderKey: string; uuid: string; role: string; nested?: Array<{ uuid?: string }> }>) {
  return turns.map((t) => ({
    orderKey: t.orderKey,
    uuid: t.uuid,
    role: t.role,
    nested: (t.nested ?? []).map((m) => m.uuid),
  }));
}

test("linearized order of the real-shaped fixture equals the recorded expected order (R5.1)", async () => {
  const turns = await readOrderedTurns("sess-ref", "/proj", { getMessages: () => messages });
  assert.deepEqual(project(turns), expected);
});

test("the assertion runs through the shared live + replay seam, which cannot diverge (R5.2)", async () => {
  const live = await readOrderedTurns("sess-ref", "/proj", { getMessages: () => messages }); // live
  const replay = await readOrderedTurns("sess-ref", "/proj", { getMessages: () => messages }); // replay
  assert.deepEqual(project(live), project(replay));
  assert.deepEqual(project(live), expected);
});

test("zero order divergences against the reference (uuid sequence + summary excluded)", async () => {
  const turns = await readOrderedTurns("sess-ref", "/proj", { getMessages: () => messages });
  assert.deepEqual(
    turns.map((t) => t.uuid),
    ["u1", "a1", "u2", "a2"],
  );
  assert.ok(!turns.some((t) => t.uuid === "sum1"), "summary anchor must not be a rendered turn");
});
