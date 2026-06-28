// Story 049 / Task 4.1 (R1.3, R1.4, R5.3) — fail fast with a clear, PATH-naming error.
//
// UPDATED for story 049: the hardcoded `2.1.159` native-binary fallback is REMOVED
// (a version-specific path that almost certainly no longer exists is a silent dead
// end). Resolution is now PATH-only; on a miss, resolveClaudePath() must throw an
// Error naming the PATH lookup that was attempted plus the install hint — and must
// NO LONGER mention any native-binary / `.vscode` fallback (R1.3). The fail-loud
// contract (a missing CLI surfaces here, not as an opaque spawn ENOENT deep in the
// PTY engine, story 013) is preserved minus the fallback clause.
//
// Determinism: PATH is pointed at an empty temp dir (no `claude`). HOME no longer
// matters (the homedir-based fallback is gone) but is still stubbed empty so the
// test is hermetic regardless of the host.
//
// node:test runner: `node --experimental-strip-types --test
// test/claude-path-missing.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Story 059: dist over src — claude-path.ts gained a src→src `./image-vision-smoke.js` import (story 058)
// that does not resolve from src/ under --experimental-strip-types; import the built module (dist over src).
import { resolveClaudePath } from "../dist/claude-path.js";

/** Run `fn` with PATH/HOME stubbed to claude-free temp dirs, then restore. */
function withNoClaude(pathValue: string, fn: () => void): void {
  const savedPath = process.env.PATH;
  const savedHome = process.env.HOME;
  const emptyHome = mkdtempSync(join(tmpdir(), "claude-missing-home-"));
  try {
    process.env.PATH = pathValue;
    process.env.HOME = emptyHome; // hermetic — even though the homedir fallback is gone
    fn();
  } finally {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(emptyHome, { recursive: true, force: true });
  }
}

test("missing (R1.4): throws naming the PATH lookup, with NO native-binary fallback clause (R1.3)", () => {
  const emptyPathDir = mkdtempSync(join(tmpdir(), "claude-missing-path-"));
  try {
    withNoClaude(emptyPathDir, () => {
      assert.throws(
        () => resolveClaudePath(),
        (err: unknown) => {
          assert.ok(err instanceof Error, "must throw an Error");
          assert.match(err.message, /PATH lookup/, "must name the PATH-lookup attempt");
          assert.match(
            err.message,
            /Install the Claude Code subscription CLI/,
            "must give the install hint",
          );
          // R1.3 — the fallback is GONE: the message must not point at it anymore.
          assert.ok(
            !/native-binary fallback/.test(err.message),
            "must NOT mention the removed native-binary fallback",
          );
          assert.ok(
            !/\.vscode/.test(err.message),
            "must NOT mention the removed `.vscode` fallback path",
          );
          assert.ok(
            !/claude-agent-sdk/.test(err.message),
            "must never point the user at the SDK-embedded binary",
          );
          return true;
        },
      );
    });
  } finally {
    rmSync(emptyPathDir, { recursive: true, force: true });
  }
});

test("missing (R1.4): empty PATH still fails fast naming the PATH lookup (no fallback clause)", () => {
  withNoClaude("", () => {
    assert.throws(
      () => resolveClaudePath(),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /PATH lookup over 0 entr/, "empty PATH => zero entries scanned");
        assert.ok(
          !/native-binary fallback/.test(err.message),
          "must NOT mention the removed native-binary fallback",
        );
        return true;
      },
    );
  });
});
