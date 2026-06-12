// Story 024 / Task 1.1 — Terminal-stop predicate (E3 augmented predicate).
//
// E3 binding decision (experiments/DEGRAU0-RESULTS.md, Binding decision 2): end-of-turn is the
// LAST `assistant` event whose `message.stop_reason` is a TERMINAL value {end_turn, stop_sequence,
// max_tokens}. A `tool_use` pause (or `null`) is mid-turn, NOT a boundary. The predicate is PURE
// and never throws on an unknown `.type` or a string-vs-array `content` (§6 tolerant parser).
//
// node:test runner: `node --experimental-strip-types --test test/end-of-turn-predicate.test.ts`
// (run `npm run build` first — the behavioral import resolves against ../dist).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TERMINAL_STOP_REASONS,
  isTerminalStop,
  findTerminalCandidate,
} from "../dist/end-of-turn.js";

/** A minimal assistant event carrying the given `message.stop_reason`. */
const asst = (stop_reason: unknown) => ({ type: "assistant", message: { stop_reason } });

test("TERMINAL_STOP_REASONS is exactly the E3 terminal set {end_turn, stop_sequence, max_tokens}", () => {
  for (const r of ["end_turn", "stop_sequence", "max_tokens"]) {
    assert.ok(TERMINAL_STOP_REASONS.has(r), `${r} must be terminal`);
  }
  assert.ok(!TERMINAL_STOP_REASONS.has("tool_use"), "tool_use is mid-turn, not terminal");
  assert.equal(TERMINAL_STOP_REASONS.size, 3);
});

test("isTerminalStop is true for each terminal stop_reason on an assistant event", () => {
  assert.equal(isTerminalStop(asst("end_turn")), true);
  assert.equal(isTerminalStop(asst("stop_sequence")), true);
  assert.equal(isTerminalStop(asst("max_tokens")), true);
});

test("isTerminalStop is false for tool_use, null/undefined, and a user event", () => {
  assert.equal(isTerminalStop(asst("tool_use")), false);
  assert.equal(isTerminalStop(asst(null)), false);
  assert.equal(isTerminalStop(asst(undefined)), false);
  // a user event with a terminal-looking stop_reason is still NOT a boundary (type gate)
  assert.equal(
    isTerminalStop({ type: "user", message: { stop_reason: "end_turn" } }),
    false,
  );
});

test("isTerminalStop never throws on unknown .type or string/missing content", () => {
  assert.equal(isTerminalStop({ type: "system", message: "raw string content" }), false);
  assert.equal(isTerminalStop({ type: "assistant", message: "raw string" }), false);
  assert.equal(isTerminalStop({ type: "assistant" }), false);
  assert.equal(isTerminalStop({}), false);
  assert.equal(isTerminalStop(null as unknown as { type?: unknown }), false);
  assert.equal(isTerminalStop(undefined as unknown as { type?: unknown }), false);
});

test("findTerminalCandidate returns the LAST terminal assistant event when several exist", () => {
  const events = [
    asst("tool_use"),
    asst("end_turn"), // terminal #1
    asst("tool_use"),
    asst("max_tokens"), // terminal #2 (LAST) — expected
  ];
  assert.equal(findTerminalCandidate(events), events[3]);
});

test("findTerminalCandidate returns undefined for a tool_use-only turn", () => {
  const events = [
    asst("tool_use"),
    asst(null),
    { type: "user", message: { stop_reason: "end_turn" } },
  ];
  assert.equal(findTerminalCandidate(events), undefined);
});

// === Story 041 / Task 4.1 — a sidechain row's terminal stop NEVER ends the parent turn (R4.1) ===
//
// A subagent (sidechain) assistant row carries a non-null `parent_tool_use_id`. Such a row may carry
// `stop_reason:'end_turn'` (the subagent's OWN turn ended), but that must NOT be treated as a
// terminal boundary for the PARENT turn — only a MAIN-chain assistant terminal stop ends the parent.

/** A sidechain assistant row: a non-null `parent_tool_use_id` plus a terminal `stop_reason`. */
const sidechainAsst = (stop_reason: unknown, parent_tool_use_id = "toolu_parent") => ({
  type: "assistant",
  parent_tool_use_id,
  message: { stop_reason },
});

test("isTerminalStop is false for a sidechain assistant row even with stop_reason:'end_turn' (R4.1)", () => {
  // every terminal stop_reason on a sidechain row stays NON-terminal
  assert.equal(isTerminalStop(sidechainAsst("end_turn")), false);
  assert.equal(isTerminalStop(sidechainAsst("stop_sequence")), false);
  assert.equal(isTerminalStop(sidechainAsst("max_tokens")), false);
  // the camelCase alias is treated identically (linearize reads parent_tool_use_id ?? parentToolUseId)
  assert.equal(
    isTerminalStop({ type: "assistant", parentToolUseId: "toolu_parent", message: { stop_reason: "end_turn" } }),
    false,
  );
});

test("isTerminalStop stays true for a MAIN-chain assistant terminal stop (parent_tool_use_id null/absent) — no regression (R4.1)", () => {
  assert.equal(isTerminalStop(asst("end_turn")), true); // absent parent_tool_use_id
  assert.equal(
    isTerminalStop({ type: "assistant", parent_tool_use_id: null, message: { stop_reason: "end_turn" } }),
    true,
  );
});

test("findTerminalCandidate skips a sidechain end_turn but still picks a later MAIN-chain terminal (R4.1)", () => {
  const events = [
    asst("tool_use"),
    sidechainAsst("end_turn"), // subagent's own end — must NOT be the candidate
    asst("end_turn"), // main-chain terminal — the real boundary
  ];
  assert.equal(findTerminalCandidate(events), events[2]);
});

test("findTerminalCandidate returns undefined when the ONLY terminal stop is on a sidechain row (R4.1)", () => {
  const events = [
    asst("tool_use"),
    sidechainAsst("end_turn"), // a sidechain end_turn can never resolve the parent turn
  ];
  assert.equal(findTerminalCandidate(events), undefined);
});
