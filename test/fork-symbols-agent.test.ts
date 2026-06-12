import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "src");

// Anchor by symbol NAME, never by line number (§3: lines are volatile —
// createSession ≈L1933/L2037, canUseTool ≈L1600/L1704, prompt ≈L732/L900).
const AGENT_SYMBOLS = [
  "createSession",
  "prompt", // now the read-only Degrau-1 stub — the ~590-line SDK loop was DELETED by story 023 (§3)
  // canUseTool: REMOVED by story 023 (R5.3) — the SDK permission callback has no equivalent in the PTY
  // flow; the PTY-backed permission gate returns in Degrau 2 (story 032). It is no longer declared here.
  "toAcpNotifications",
  "streamEventToAcpNotifications",
  "replaySessionHistory",
  "runAcp",
  "initialize",
];

// Matches a DECLARATION of `name` (top-level function, class method, or binding)
// by identifier — never a call site (`this.name(`, `of name(`, `name: ...`).
export function isDeclared(src: string, name: string): boolean {
  const fn = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`, "m");
  const method = new RegExp(
    `^[ \\t]*(?:private\\s+|public\\s+|protected\\s+)?(?:static\\s+)?(?:async\\s+)?${name}\\s*\\(`,
    "m",
  );
  const binding = new RegExp(`^[ \\t]*(?:export\\s+)?(?:const|let|var)\\s+${name}\\s*[:=]`, "m");
  return fn.test(src) || method.test(src) || binding.test(src);
}

const agentSrc = readFileSync(join(srcDir, "acp-agent.ts"), "utf8");

test("fork symbols (acp-agent.ts): all eight reuse/cut symbols are declared by name (R4.2)", () => {
  for (const s of AGENT_SYMBOLS) {
    assert.ok(isDeclared(agentSrc, s), `acp-agent.ts: symbol '${s}' has no declaration`);
  }
});

test("fork symbols (acp-agent.ts): inventory fails loudly for an absent symbol (R4.4)", () => {
  // Control: an identifier never declared in the module must be reported absent.
  assert.equal(isDeclared(agentSrc, "thisSymbolWasNeverDeclared"), false);
});
