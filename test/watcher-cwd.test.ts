// Story 015 / Task 1.2 — read the runtime cwd from the `.cwd` field INSIDE the matched JSONL,
// never from the directory name (R1.2).
// node:test runner: `node --experimental-strip-types --test test/watcher-cwd.test.ts`
// (run `npm run build` first — behavioral imports resolve against ../dist).
//
// The crux: the cwd→dir transform is irreversible (`a_b` / `a.b` / `"a b"` / `a/b` all collapse
// to the same `a-b` dir), so the dir name can NOT yield the true cwd. The fixture deliberately
// uses the COLLAPSED `a-b` dir name while the inside `.cwd` holds the TRUE `a_b` — the resolved
// cwd must equal the inside `.cwd`, proving it was sourced from inside, not decoded from the dir.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCwdFromInside, resolveWatchTarget } from "../dist/jsonl.js";

/**
 * Build a fixture transcript whose collapsed `a-b` dir name does NOT round-trip to its true
 * `a_b` cwd, write `lines` (already newline-terminated by the caller), and return the path plus
 * the collapsed-dir form (so a test can assert the resolved cwd is NOT the dir form).
 */
function writeFixture(lines: string): { path: string; collapsedDir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "watcher-cwd-"));
  const collapsedDir = "-home-user-a-b"; // collapsed encoding of cwd "/home/user/a_b"
  const dir = join(root, ".claude", "projects", collapsedDir);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "sess-cwd.jsonl");
  writeFileSync(path, lines);
  return { path, collapsedDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("readCwdFromInside: resolves the inside `.cwd`, NOT the collapsed dir name (R1.2)", () => {
  const trueCwd = "/home/user/a_b"; // underscore survives ONLY inside the file
  const { path, collapsedDir, cleanup } = writeFixture(
    `${JSON.stringify({ type: "user", cwd: trueCwd, message: { content: "hi" } })}\n`,
  );
  try {
    const cwd = readCwdFromInside(path);
    assert.equal(cwd, trueCwd, "cwd is read from the inside `.cwd` field");
    assert.notEqual(cwd, collapsedDir, "cwd is NOT the collapsed dir name");
    assert.ok(
      cwd!.includes("a_b"),
      "the true underscore form is preserved (irreversible if decoded)",
    );
  } finally {
    cleanup();
  }
});

test("readCwdFromInside: takes the FIRST event that carries `.cwd` (skips leading cwd-less lines)", () => {
  const trueCwd = "/home/user/a_b";
  const { path, cleanup } = writeFixture(
    `${JSON.stringify({ type: "summary" })}\n` + // no .cwd
      `${JSON.stringify({ type: "user", cwd: trueCwd })}\n` +
      `${JSON.stringify({ type: "assistant", cwd: "/somewhere/else" })}\n`,
  );
  try {
    assert.equal(readCwdFromInside(path), trueCwd, "first event carrying `.cwd` wins");
  } finally {
    cleanup();
  }
});

test("readCwdFromInside: no event carries `.cwd` yet → undefined (defer, do NOT guess from dir)", () => {
  const { path, cleanup } = writeFixture(
    `${JSON.stringify({ type: "summary" })}\n${JSON.stringify({ type: "system" })}\n`,
  );
  try {
    assert.equal(
      readCwdFromInside(path),
      undefined,
      "absent `.cwd` defers rather than decoding the dir",
    );
  } finally {
    cleanup();
  }
});

test("readCwdFromInside: a partial trailing line (no newline) is deferred, not parsed", () => {
  // The complete line has no `.cwd`; the trailing partial (no `\n`) DOES — but it is an incomplete
  // write, so it must be deferred (undefined) rather than read.
  const { path, cleanup } = writeFixture(
    `${JSON.stringify({ type: "summary" })}\n` + `{"type":"user","cwd":"/home/user/a_b"`, // truncated, no newline
  );
  try {
    assert.equal(readCwdFromInside(path), undefined, "partial trailing line is not parsed");
  } finally {
    cleanup();
  }
});

test("readCwdFromInside: a corrupted line is skipped; a later valid `.cwd` line still resolves", () => {
  const trueCwd = "/home/user/a_b";
  const { path, cleanup } = writeFixture(
    `{ this is not json\n` + `${JSON.stringify({ type: "user", cwd: trueCwd })}\n`,
  );
  try {
    assert.equal(
      readCwdFromInside(path),
      trueCwd,
      "corrupted line skipped, valid `.cwd` still found",
    );
  } finally {
    cleanup();
  }
});

test("resolveWatchTarget: real tmp tree → { transcriptPath, cwd } with cwd from inside, not the dir", async () => {
  const trueCwd = "/home/user/a_b";
  const { path, collapsedDir, cleanup } = writeFixture(
    `${JSON.stringify({ type: "user", cwd: trueCwd })}\n`,
  );
  try {
    // Drive resolveWatchTarget through the INJECTED glob so it adopts the fixture path directly
    // (transcriptGlob hardcodes homedir()), then reads the cwd from inside that real file.
    const target = await resolveWatchTarget("sess-cwd", {
      glob: () => [path],
      now: () => 0,
      sleep: () => Promise.resolve(),
    });
    assert.equal(target.transcriptPath, path, "adopts the single globbed path as the watch target");
    assert.equal(target.cwd, trueCwd, "cwd sourced from the inside `.cwd` field");
    assert.notEqual(target.cwd, collapsedDir, "cwd is NOT the decoded dir name");
  } finally {
    cleanup();
  }
});
