import { test } from "node:test";
import assert from "node:assert/strict";
import { toolCallIdFor } from "../dist/tools.js";

// Story 025 / Task 2.2 (R2.1, R2.3) — toolCallIdFor derives the ACP `toolCallId` from a
// JSONL `tool_use.id`. It is pure, total and side-effect-free.
//
// Default mode reuses the raw id VERBATIM — the §7 reuse contract that stories 017–021
// assume. Namespaced mode (enabled only if the live-Zed probe in Task 2.1 shows the
// user's Zed requires per-session uniqueness) returns a deterministic, replay-STABLE
// per-session id: identical for the same (toolUseId, sessionId), distinct across
// sessions. Whether namespacing is actually required is the empirical verdict recorded
// in FORK.md (Task 2.1); this test pins BOTH modes of the pure function.

test("toolCallIdFor: default mode reuses the raw tool_use.id verbatim (R2.1)", () => {
  assert.equal(toolCallIdFor("toolu_abc123", "sess-1"), "toolu_abc123");
  // default is raw regardless of session
  assert.equal(toolCallIdFor("toolu_abc123", "sess-2"), "toolu_abc123");
  // explicit { namespaced: false } equals the default
  assert.equal(toolCallIdFor("toolu_abc123", "sess-1", { namespaced: false }), "toolu_abc123");
});

test("toolCallIdFor: namespaced mode is deterministic and replay-stable across calls (R2.3)", () => {
  const a = toolCallIdFor("toolu_abc123", "sess-1", { namespaced: true });
  const b = toolCallIdFor("toolu_abc123", "sess-1", { namespaced: true });
  assert.equal(a, b, "same (toolUseId, sessionId) must yield the same id (replay-stable)");
  assert.notEqual(a, "toolu_abc123", "namespaced id must differ from the raw id");
  assert.ok(a.includes("toolu_abc123"), "namespaced id must still carry the raw tool_use.id");
});

test("toolCallIdFor: namespaced mode is distinct across sessions (R2.3)", () => {
  const s1 = toolCallIdFor("toolu_abc123", "sess-1", { namespaced: true });
  const s2 = toolCallIdFor("toolu_abc123", "sess-2", { namespaced: true });
  assert.notEqual(s1, s2, "the same tool_use.id in different sessions must namespace differently");
});

test("toolCallIdFor: namespaced mode distinguishes different tool_use ids within one session", () => {
  const t1 = toolCallIdFor("toolu_aaa", "sess-1", { namespaced: true });
  const t2 = toolCallIdFor("toolu_bbb", "sess-1", { namespaced: true });
  assert.notEqual(t1, t2, "distinct tool_use ids must not collide after namespacing");
});
