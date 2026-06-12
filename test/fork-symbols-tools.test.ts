import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "src");

// The five tools.ts translator symbols reused 1:1 by the fork (§3/§17).
const TOOLS_SYMBOLS = [
  "toolInfoFromToolUse",
  "toolUpdateFromToolResult",
  "toolUpdateFromDiffToolResponse",
  "planEntries",
  "taskStateToPlanEntries",
];

// Matches a DECLARATION of `name` (top-level function, class method, or binding)
// by identifier — never a call site. Anchor by NAME, not line number (§3).
function isDeclared(src: string, name: string): boolean {
  const fn = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`, "m");
  const method = new RegExp(
    `^[ \\t]*(?:private\\s+|public\\s+|protected\\s+)?(?:static\\s+)?(?:async\\s+)?${name}\\s*\\(`,
    "m",
  );
  const binding = new RegExp(`^[ \\t]*(?:export\\s+)?(?:const|let|var)\\s+${name}\\s*[:=]`, "m");
  return fn.test(src) || method.test(src) || binding.test(src);
}

const toolsSrc = readFileSync(join(srcDir, "tools.ts"), "utf8");

test("fork symbols (tools.ts): all five translator symbols are declared by name (R4.3)", () => {
  for (const s of TOOLS_SYMBOLS) {
    assert.ok(isDeclared(toolsSrc, s), `tools.ts: symbol '${s}' has no declaration`);
  }
});

test("fork symbols (tools.ts): inventory fails loudly for an absent symbol (R4.4)", () => {
  assert.equal(isDeclared(toolsSrc, "thisSymbolWasNeverDeclared"), false);
});
