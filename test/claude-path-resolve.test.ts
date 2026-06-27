// Story 012 / Task 1.2 (R1, R1.2) — engine resolution routes through the
// E1-validated PATH resolver.
//
// Two guarantees:
//   1. Unit: given a PATH seeded with a fake dir holding an executable `claude`,
//      `resolveClaudePath()` returns that absolute PATH candidate (never an
//      SDK-internal path).
//   2. Source wiring: the `--cli` spawn (index.ts) consumes `resolveClaudePath`.
//      (Story 023 removed the SDK `pathToClaudeCodeExecutable` seam from acp-agent.ts;
//      the Degrau-1 PTY engine resolves `claude` via the login-shell PATH — story 013.)
//
// node:test runner: `node --experimental-strip-types --test
// test/claude-path-resolve.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { resolveClaudePath } from "../src/claude-path.ts";
// Story 056: engine-pty gained its first src→src import (./agent-catalog.js for the R3.3 name guard),
// which does not resolve from src/ under --experimental-strip-types; import the built module (the
// dominant test convention — dist over src) so the compiled `./agent-catalog.js` resolves.
import { buildClaudeCmd } from "../dist/engine-pty.js";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "src");

test("resolve (R1.2): returns the executable `claude` seeded on PATH", () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-resolve-"));
  const fake = join(dir, "claude");
  const savedPath = process.env.PATH;
  try {
    writeFileSync(fake, "#!/bin/sh\nexit 0\n");
    chmodSync(fake, 0o755);
    process.env.PATH = dir; // only this dir, so the seeded `claude` is the hit
    const resolved = resolveClaudePath();
    assert.equal(resolved, fake, `expected the seeded PATH candidate, got "${resolved}"`);
    assert.ok(
      !resolved.includes("claude-agent-sdk"),
      `must never resolve under the SDK package, got "${resolved}"`,
    );
  } finally {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolve (R1.2, post-023): the Degrau-1 PTY engine resolves `claude` from the login-shell PATH, not an SDK-internal path", () => {
  // Story 023 removed the SDK options path from createSession, so acp-agent.ts no longer carries the
  // `pathToClaudeCodeExecutable` seam. The PTY engine (story 013) spawns `claude` through the login
  // shell, so it resolves from PATH — the same E1 guarantee, via the shell instead of an explicit
  // resolveClaudePath() call here. The `--cli` spawn in index.ts still consumes resolveClaudePath().
  const agentSrc = readFileSync(join(srcDir, "acp-agent.ts"), "utf8");
  // Match the SDK option *assignment* (`pathToClaudeCodeExecutable:`), not bare comment mentions.
  assert.ok(
    !/pathToClaudeCodeExecutable\s*:/.test(agentSrc),
    "after the 023 rewrite acp-agent.ts must not assign the SDK `pathToClaudeCodeExecutable` option",
  );
  const cmd = buildClaudeCmd("11111111-1111-4111-8111-111111111111");
  assert.match(
    cmd,
    /(^|\s)claude\s/,
    `the engine spawns a bare \`claude\` command (PATH-resolved via the shell), got: ${cmd}`,
  );
  assert.ok(!/claude-agent-sdk/.test(cmd), "the engine must never spawn an SDK-internal claude path");
});

test("resolve (R1): the --cli spawn consumes resolveClaudePath()", () => {
  const indexSrc = readFileSync(join(srcDir, "index.ts"), "utf8");
  assert.match(
    indexSrc,
    /resolveClaudePath\(\)/,
    "index.ts must resolve the spawned binary via resolveClaudePath()",
  );
});
