// Story 012 / Task 2.1 (R1.3) — fail fast with a clear, location-naming error.
//
// When neither a PATH `claude` nor the documented native-binary fallback is
// executable, resolveClaudePath() must throw an Error naming BOTH attempted
// locations (the PATH lookup and the native-binary fallback) plus the install
// hint — so a missing subscription CLI surfaces here, not as an opaque spawn
// ENOENT deep in the PTY engine (story 013).
//
// Determinism: PATH is pointed at an empty temp dir (no `claude`), and HOME at an
// empty temp dir so os.homedir()'s native-binary fallback path is unreachable.
// On POSIX, os.homedir() honors $HOME.
//
// Regression-guard note: the throw is part of the E1-validated helper ported in
// task 1.2, so this contract already holds when this test is authored — it pins
// the fail-fast behavior against future weakening rather than driving new code.
//
// node:test runner: `node --experimental-strip-types --test
// test/claude-path-missing.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveClaudePath } from "../src/claude-path.ts";

/** Run `fn` with PATH/HOME stubbed to claude-free temp dirs, then restore. */
function withNoClaude(pathValue: string, fn: () => void): void {
  const savedPath = process.env.PATH;
  const savedHome = process.env.HOME;
  const emptyHome = mkdtempSync(join(tmpdir(), "claude-missing-home-"));
  try {
    process.env.PATH = pathValue;
    process.env.HOME = emptyHome; // os.homedir() -> emptyHome; fallback unreachable
    fn();
  } finally {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(emptyHome, { recursive: true, force: true });
  }
}

test("missing (R1.3): throws naming BOTH the PATH lookup and the native-binary fallback", () => {
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
            /native-binary fallback/,
            "must name the native-binary fallback attempt",
          );
          assert.match(err.message, /\.vscode/, "must include the documented fallback path");
          assert.match(err.message, /Install the Claude Code subscription CLI/, "must give the install hint");
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

test("missing (R1.3): empty PATH still fails fast naming both locations", () => {
  withNoClaude("", () => {
    assert.throws(
      () => resolveClaudePath(),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /PATH lookup over 0 entr/, "empty PATH => zero entries scanned");
        assert.match(err.message, /native-binary fallback/);
        return true;
      },
    );
  });
});
