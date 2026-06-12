// Story 017 / Task 4.1 — Cover branch/fork and re-prompt edge cases (R4.1, R4.2).
//
// Forks (a parentUuid with two children, e.g. an edited re-prompt) and re-prompts (a new user turn
// re-anchored to an earlier ancestor) are resolved by getSessionMessages on the LIVE path (it returns
// the surviving chain). The R1.3 fallback (buildChainEquivalent) reproduces that resolution over RAW
// JSONL — so the abandoned branch is dropped and the re-anchored ancestor is never duplicated. This
// pins both: the fallback's resolution, and linearizeTurns preserving an already-resolved chain.
//
// node:test runner: `node --experimental-strip-types --test test/lin-fork-reprompt.test.ts`
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChainEquivalent, linearizeTurns } from "../dist/linearize.js";

// FORK: u1 → a1; a1 has TWO children — uX (abandoned edited branch) and u2 (surviving). Tip = a2.
const FORK_RAW = [
  JSON.stringify({ type: "user", uuid: "u1", parentUuid: null, message: { content: [] } }),
  JSON.stringify({ type: "assistant", uuid: "a1", parentUuid: "u1", message: { content: [] } }),
  JSON.stringify({ type: "user", uuid: "uX", parentUuid: "a1", message: { content: [] } }), // abandoned
  JSON.stringify({ type: "user", uuid: "u2", parentUuid: "a1", message: { content: [] } }),
  JSON.stringify({ type: "assistant", uuid: "a2", parentUuid: "u2", message: { content: [] } }),
];

// RE-PROMPT: original continuation u2/a2 abandoned; re-prompt u2b re-anchored to ancestor a1 → a3 tip.
const REPROMPT_RAW = [
  JSON.stringify({ type: "user", uuid: "u1", parentUuid: null, message: { content: [] } }),
  JSON.stringify({ type: "assistant", uuid: "a1", parentUuid: "u1", message: { content: [] } }),
  JSON.stringify({ type: "user", uuid: "u2", parentUuid: "a1", message: { content: [] } }), // abandoned
  JSON.stringify({ type: "assistant", uuid: "a2", parentUuid: "u2", message: { content: [] } }), // abandoned
  JSON.stringify({ type: "user", uuid: "u2b", parentUuid: "a1", message: { content: [] } }), // re-prompt
  JSON.stringify({ type: "assistant", uuid: "a3", parentUuid: "u2b", message: { content: [] } }),
];

test("fork: only the surviving chain is emitted; the abandoned branch is absent (R4.1)", () => {
  const chain = buildChainEquivalent(FORK_RAW, { enabled: true }).map((m) => m.uuid);
  assert.deepEqual(chain, ["u1", "a1", "u2", "a2"]);
  assert.ok(!chain.includes("uX"), "abandoned fork branch must not appear");
});

test("re-prompt: placed chronologically with NO ancestor duplication (R4.2)", () => {
  const chain = buildChainEquivalent(REPROMPT_RAW, { enabled: true }).map((m) => m.uuid);
  assert.deepEqual(chain, ["u1", "a1", "u2b", "a3"]);
  // The re-anchored ancestor a1 appears exactly once.
  assert.equal(chain.filter((u) => u === "a1").length, 1);
  // The abandoned original continuation is gone.
  assert.ok(!chain.includes("u2") && !chain.includes("a2"));
});

test("linearizeTurns preserves an already-resolved surviving chain with no duplicates", () => {
  // getSessionMessages would already return the resolved chain; linearizeTurns must not duplicate.
  const resolved = [
    { type: "user", uuid: "u1", session_id: "s", parent_tool_use_id: null, message: { content: [] } },
    { type: "assistant", uuid: "a1", session_id: "s", parent_tool_use_id: null, message: { content: [] } },
    { type: "user", uuid: "u2b", session_id: "s", parent_tool_use_id: null, message: { content: [] } },
    { type: "assistant", uuid: "a3", session_id: "s", parent_tool_use_id: null, message: { content: [] } },
  ];
  const uuids = linearizeTurns(resolved).map((t) => t.uuid);
  assert.deepEqual(uuids, ["u1", "a1", "u2b", "a3"]);
  assert.equal(new Set(uuids).size, uuids.length, "no duplicated turns");
});
