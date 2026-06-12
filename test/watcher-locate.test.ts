// Story 015 / Task 1.1 — glob the transcript by sessionId with the 2000ms file-discovery
// watchdog (R1.1, R1.3, R1.4).
// node:test runner: `node --experimental-strip-types --test test/watcher-locate.test.ts`
// (run `npm run build` first — behavioral imports resolve against ../dist).
//
// The watchdog/multi-match/not-found cases drive locateTranscript through its INJECTED `glob`
// (fixture paths) + INJECTED `now`/`sleep` (a deterministic fake clock), so no test waits a real
// 2000ms. The not-found test asserts the fault fires AFTER the watchdog window via the fake clock,
// NOT by sleeping 2s. findTranscript is exercised against a real tmp `~/.claude/projects` tree.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  locateTranscript,
  transcriptGlob,
  findTranscript,
  FILE_DISCOVERY_WATCHDOG_MS,
} from "../dist/jsonl.js";

/**
 * A deterministic fake clock + sleep pair: `sleep(ms)` advances the virtual clock by `ms` and
 * resolves immediately, so a poll loop bounded by `now()` terminates in real-zero time. This is
 * how the not-found case crosses the 2000ms watchdog window WITHOUT a real wait.
 */
function makeFakeClock(startAt = 0) {
  let t = startAt;
  return {
    now: () => t,
    sleep: (ms: number) => {
      t += ms;
      return Promise.resolve();
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

test("locate: exactly one match resolves that single absolute path (R1.1)", async () => {
  const only = "/home/u/.claude/projects/dash-dir/sess-123.jsonl";
  const { transcriptPath } = await locateTranscript("sess-123", {
    glob: () => [only],
    ...makeFakeClock(),
  });
  assert.equal(transcriptPath, only, "the single globbed path is adopted verbatim");
});

test("locate: a match that appears only on a later poll still wins (polls until present)", async () => {
  const clock = makeFakeClock();
  const target = "/home/u/.claude/projects/dash-dir/late.jsonl";
  let polls = 0;
  // Empty for the first two polls, then the transcript appears — still well inside 2000ms.
  const glob = () => (++polls >= 3 ? [target] : []);

  const { transcriptPath } = await locateTranscript("late", {
    glob,
    pollIntervalMs: 50,
    now: clock.now,
    sleep: clock.sleep,
  });

  assert.equal(transcriptPath, target);
  assert.ok(polls >= 3, "kept polling until the transcript materialized");
});

test("locate: zero matches → not-found fault naming the glob pattern + elapsed ms after the 2000ms watchdog (R1.3)", async () => {
  const clock = makeFakeClock();
  let polls = 0;
  const glob = () => {
    polls++;
    return [] as string[];
  };

  await assert.rejects(
    () =>
      locateTranscript("ghost-session", {
        glob,
        pollIntervalMs: 50,
        now: clock.now,
        sleep: clock.sleep,
      }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      // Carries the EXACT glob pattern (single source via transcriptGlob)...
      assert.ok(
        err.message.includes(transcriptGlob("ghost-session")),
        `not-found message must name the glob pattern; got: ${err.message}`,
      );
      // ...the watchdog window...
      assert.ok(
        err.message.includes(String(FILE_DISCOVERY_WATCHDOG_MS)),
        `not-found message must cite the ${FILE_DISCOVERY_WATCHDOG_MS}ms watchdog; got: ${err.message}`,
      );
      // ...and the elapsed ms (>= the watchdog window, since the fault only fires after it).
      assert.match(err.message, /\d+ms/, "not-found message must cite elapsed ms");
      return true;
    },
  );

  // The fault fired AFTER the watchdog window elapsed on the fake clock (not by a real 2s wait).
  assert.ok(
    clock.now() >= FILE_DISCOVERY_WATCHDOG_MS,
    "watchdog window was crossed on the fake clock",
  );
  assert.ok(polls >= 2, "the glob was retried while waiting, not probed only once");
});

test("locate: more than one match → loud multi-match fault listing every matched path (R1.4)", async () => {
  const a = "/home/u/.claude/projects/dir-a/dup.jsonl";
  const b = "/home/u/.claude/projects/dir-b/dup.jsonl";

  await assert.rejects(
    () => locateTranscript("dup", { glob: () => [a, b], ...makeFakeClock() }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes(a), `multi-match must list ${a}; got: ${err.message}`);
      assert.ok(err.message.includes(b), `multi-match must list ${b}; got: ${err.message}`);
      assert.ok(
        /multiple/i.test(err.message),
        `multi-match fault must read as an ambiguity; got: ${err.message}`,
      );
      return true;
    },
  );
});

test("findTranscript: globs a real ~/.claude/projects tree by basename, returns the absolute path (R1.1)", () => {
  // Build a real fixture tree under tmp and point findTranscript at it by overriding HOME, since
  // transcriptGlob hardcodes homedir(). The dir name is the COLLAPSED form — proving the file is
  // found by basename glob, independent of any cwd→dir encoding.
  const home = mkdtempSync(join(tmpdir(), "find-home-"));
  const savedHome = process.env.HOME;
  const savedUserProfile = process.env.USERPROFILE;
  try {
    process.env.HOME = home;
    process.env.USERPROFILE = home; // win32 homedir() source; harmless elsewhere.
    const sessionId = "find-sess-abc";
    const projDir = join(home, ".claude", "projects", "-some-collapsed-dir");
    mkdirSync(projDir, { recursive: true });
    const file = join(projDir, `${sessionId}.jsonl`);
    writeFileSync(file, `${JSON.stringify({ type: "x", cwd: "/whatever" })}\n`);

    const matches = findTranscript(sessionId);
    assert.equal(matches.length, 1, "exactly one transcript matched by basename");
    assert.equal(matches[0], file, "match is the absolute path to <sessionId>.jsonl");
    assert.ok(matches[0].endsWith(`${sessionId}.jsonl`), "basename equals <sessionId>.jsonl");
  } finally {
    process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    rmSync(home, { recursive: true, force: true });
  }
});
