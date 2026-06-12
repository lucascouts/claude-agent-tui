// Story 023 / Group 4 (task 4.2) — the SDK-coupled cancel()/setPermissionMode()/canUseTool wiring is
// REMOVED from the engine path (re-implemented against the PTY in Degrau 2 / stories 030/032). This is
// a structural guarantee: a comment-stripped scan of src/acp-agent.ts must show no real `session.query.*`
// call and no `canUseTool` method. Comments (which still NAME these symbols to point at Degrau 2) are
// stripped before the assertion so a documentation reference never trips the check.
// node:test runner: `node --experimental-strip-types --test test/sdk-controls-removed.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "src", "acp-agent.ts"), "utf8");

/** Strip `//` line comments and `/* *\/` block comments so only executable code is scanned. */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}
const code = stripComments(src);

test("no real `session.query.*` call survives in the engine path", () => {
  assert.ok(!/\bsession\.query\b/.test(code), "session.query must not be referenced in executable code");
  assert.ok(!/\.query\.(interrupt|setPermissionMode|setModel|next|close|supportedCommands|applyFlagSettings)\s*\(/.test(code),
    "no SDK query.* method is called in executable code");
});

test("the `canUseTool` SDK permission-callback method is removed", () => {
  assert.ok(!/^\s*canUseTool\s*\(/m.test(code), "the canUseTool(sessionId) method definition is gone");
  assert.ok(!/\bcanUseTool\b/.test(code), "no executable reference to canUseTool remains (Degrau-2 re-adds it)");
});

test("cancel() and the prompt() shim are read-only no-ops (no SDK interrupt/loop)", () => {
  // cancel() flips the local `cancelled` flag and returns; it does not interrupt an SDK query.
  assert.ok(/cancel\s*\([^)]*\)\s*:\s*Promise<void>\s*\{/.test(code), "cancel() is still an ACP-compatible method");
  assert.ok(!/query\.interrupt/.test(code), "cancel() no longer calls query.interrupt()");
});
