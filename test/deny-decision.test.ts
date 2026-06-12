// Story 033 / Task 2.3 — a deny outcome maps to permissionDecision:'deny' / exit 2, and a
// matcher-scoped deny targets the intended tool (R2.3).
//
// OFFLINE: pure decision functions; no server, no claude, no Zed.
//
// node:test: build first, then
//   node --experimental-strip-types --test test/deny-decision.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  allowDecision,
  defaultDenyReason,
  denyDecision,
  denyMatchesTool,
  HOOK_DENY_EXIT_CODE,
  type DenyToolCall,
} from "../dist/permissions/deny.js";

const TOOL: DenyToolCall = { toolName: "Bash", toolUseId: "toolu_abc123" };

test("2.3 a deny outcome maps to permissionDecision:'deny' in the §9 hook body", () => {
  const body = denyDecision(TOOL);
  assert.equal(body.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(body.hookSpecificOutput.permissionDecision, "deny", "deny must intercept the tool");
  assert.ok(
    body.hookSpecificOutput.permissionDecisionReason.length > 0,
    "a deny is never a blank reason (the TUI/log must show why)",
  );
  assert.match(
    body.hookSpecificOutput.permissionDecisionReason,
    /Bash/,
    "the default reason names the denied tool",
  );
  assert.match(body.hookSpecificOutput.permissionDecisionReason, /toolu_abc123/);
});

test("2.3 the exit-2 form is exposed for an exec-style hook (intercept code)", () => {
  // Degrau-0 / §9: deny is honored as `permissionDecision:'deny'` body OR process exit code 2.
  assert.equal(HOOK_DENY_EXIT_CODE, 2, "the deny exit code must be 2 (the §9 intercept code)");
});

test("2.3 an explicit reason overrides the default and is carried verbatim", () => {
  const body = denyDecision(TOOL, "policy: rm -rf is never allowed");
  assert.equal(body.hookSpecificOutput.permissionDecisionReason, "policy: rm -rf is never allowed");
});

test("2.3 allowDecision maps to permissionDecision:'allow' (best-effort — see #52822)", () => {
  const body = allowDecision(TOOL);
  assert.equal(body.hookSpecificOutput.permissionDecision, "allow");
  assert.equal(body.hookSpecificOutput.hookEventName, "PreToolUse");
});

test("2.3 a matcher-scoped deny targets ONLY the intended tool (not the precursor) — #37210/#33106", () => {
  // The broad "*" matcher denied a PRECURSOR tool in Degrau 0, masking per-tool reliability. A
  // matcher scoped to "Edit" must match Edit and NOT a precursor Read.
  assert.equal(denyMatchesTool("Edit", "Edit"), true, "scoped matcher hits its tool");
  assert.equal(denyMatchesTool("Edit", "Read"), false, "scoped matcher does NOT hit the precursor");
  assert.equal(denyMatchesTool("Bash", "Edit"), false, "scoped matcher is exact, not fuzzy");
});

test("2.3 the broad '*' matcher matches every tool (the Degrau-0 probe shape)", () => {
  assert.equal(denyMatchesTool("*", "Edit"), true);
  assert.equal(denyMatchesTool("*", "Bash"), true);
  assert.equal(denyMatchesTool("*", "mcp__perplexity__search"), true);
});

test("2.3 defaultDenyReason is self-describing (tool + tool_use id)", () => {
  const reason = defaultDenyReason({ toolName: "Edit", toolUseId: "toolu_zzz" });
  assert.match(reason, /Edit/);
  assert.match(reason, /toolu_zzz/);
  assert.match(reason, /intercepted/i, "states the tool was intercepted before it ran");
});
