// Upstream #1004 parity — the `manual` alias for `permissions.defaultMode`
// (REBASE-AND-DRIFT.md §15.5).
//
// CONTRACT: Claude Code 2.1.200 renamed the "default" permission mode to "Manual" and
// accepts `"defaultMode": "manual"` in settings.json. `resolvePermissionMode` must map it
// to the SDK wire value `"default"`.
//
// WHY THE LOGGER IS THE ASSERTION, not just the return value. Without the alias the input
// still resolved to `"default"` — through the UNKNOWN-VALUE branch, which logs an error on
// every settings load. Return value alone cannot tell the two paths apart, so a test that
// only checked it would have passed before the port and proved nothing.
//
// node:test (build first):
//   node --experimental-strip-types --test test/mode-alias-manual.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolvePermissionMode } from "../dist/acp-agent.js";

function capturingLogger() {
  const errors: string[] = [];
  return { errors, logger: { error: (...a: unknown[]) => errors.push(a.join(" ")) } };
}

test("#1004 `manual` resolves to the SDK's `default`, with NO error logged", () => {
  const { errors, logger } = capturingLogger();
  assert.equal(resolvePermissionMode("manual", logger as never), "default");
  assert.deepEqual(errors, [], "the alias must be recognised, not fall through the unknown-value branch");
});

test("#1004 the alias is case-insensitive and trimmed, like every other row", () => {
  for (const input of ["Manual", "  MANUAL  ", "MaNuAl"]) {
    const { errors, logger } = capturingLogger();
    assert.equal(resolvePermissionMode(input, logger as never), "default", `input ${JSON.stringify(input)}`);
    assert.deepEqual(errors, [], `input ${JSON.stringify(input)} must not log`);
  }
});

test("#1004 an unknown value still logs and falls back — the port did not widen the accepted set", () => {
  const { errors, logger } = capturingLogger();
  assert.equal(resolvePermissionMode("manualy", logger as never), "default");
  assert.equal(errors.length, 1, "an unknown mode must still be reported");
  assert.match(errors[0]!, /unknown value/i);
});

test("#1004 the pre-existing rows are untouched", () => {
  const { errors, logger } = capturingLogger();
  for (const [input, expected] of [
    ["auto", "auto"],
    ["default", "default"],
    ["acceptEdits", "acceptEdits"],
    ["dontAsk", "dontAsk"],
    ["plan", "plan"],
  ] as const) {
    assert.equal(resolvePermissionMode(input, logger as never), expected, `alias ${input}`);
  }
  assert.deepEqual(errors, [], "no pre-existing alias may have regressed into the unknown branch");
});
