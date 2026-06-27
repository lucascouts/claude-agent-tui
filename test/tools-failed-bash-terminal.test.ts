// Story 056 / Task 4.1 (#776) — a FAILED Bash with a negotiated terminal must render as terminal
// output (terminal_output + terminal_exit exit_code 1), NOT as the error-only markdown early-return.
//
// The fix adds `&& !(toolUse?.name === "Bash" && supportsTerminalOutput)` to the `is_error` early-return
// in `toolUpdateFromToolResult`, so an errored Bash with a terminal falls through to `case "Bash"`
// (which sets exitCode = 1 for an error). Every OTHER errored result — errored non-Bash, OR an errored
// Bash with NO terminal — stays on the markdown early-return, byte-identical to before.
//
// Unit test over the translator function directly (build first — imports resolve against ../dist):
//   node --experimental-strip-types --test test/tools-failed-bash-terminal.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { toolUpdateFromToolResult } from "../dist/tools.js";

const erroredResult = (id: string) =>
  ({ type: "tool_result", tool_use_id: id, is_error: true, content: [{ type: "text", text: "boom" }] }) as any;

const hasTerminalExit = (u: any) => u?._meta?.terminal_exit !== undefined;

test("4.1 errored Bash + terminal negotiated → terminal_output + terminal_exit exit_code 1 (#776)", () => {
  const u: any = toolUpdateFromToolResult(erroredResult("toolu_BASH"), { name: "Bash" }, true);
  // This is the load-bearing assert: BEFORE the fix this errored result took the markdown early-return.
  assert.ok(hasTerminalExit(u), `failed Bash with a terminal must emit terminal_exit, got: ${JSON.stringify(u)}`);
  assert.equal(u._meta.terminal_exit.exit_code, 1, "a failed Bash exits non-zero (exit_code 1)");
  assert.equal(u.content[0].type, "terminal", "the content carries a terminal block");
  assert.match(String(u._meta.terminal_output.data), /boom/, "the failure output reaches terminal_output");
});

test("4.1 errored NON-Bash + terminal → stays the markdown error early-return (no terminal_exit)", () => {
  const u: any = toolUpdateFromToolResult(erroredResult("toolu_READ"), { name: "Read" }, true);
  assert.ok(!hasTerminalExit(u), "a non-Bash error must NOT route to terminal output (early-return unchanged)");
});

test("4.1 errored Bash WITHOUT a terminal → stays the markdown error early-return (no terminal_exit)", () => {
  const u: any = toolUpdateFromToolResult(erroredResult("toolu_BASH2"), { name: "Bash" }, false);
  assert.ok(
    !hasTerminalExit(u),
    "an errored Bash with no negotiated terminal stays on the markdown early-return (#776 is terminal-scoped)",
  );
});

test("4.1 regression: a SUCCESSFUL Bash + terminal still renders terminal output (exit_code 0)", () => {
  const ok = { type: "tool_result", tool_use_id: "toolu_OK", content: [{ type: "text", text: "done" }] } as any;
  const u: any = toolUpdateFromToolResult(ok, { name: "Bash" }, true);
  assert.ok(hasTerminalExit(u), "a successful Bash with a terminal still emits terminal output (unchanged)");
  assert.equal(u._meta.terminal_exit.exit_code, 0, "a successful Bash exits 0");
});
