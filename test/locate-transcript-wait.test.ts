// Story 028 / Task 1.1 — cancellable + unbounded transcript discovery seam (R1.2).
// node:test runner: `node --experimental-strip-types --test test/locate-transcript-wait.test.ts`
// (run `npm run build` first — behavioral imports resolve against ../dist).
//
// The bugfix gives locateTranscript two capabilities WITHOUT changing the default 2000ms path:
//   1. watchdogMs: Infinity → poll indefinitely, NEVER throwing the not-found fault — the fresh
//      createSession path must wait for a transcript the TUI writes only on the first interaction.
//   2. signal?: AbortSignal → a caller can cancel the (possibly unbounded) poll; an abort mid-poll
//      rejects with a recognizable AbortError sentinel, NOT a not-found error, so the caller can
//      swallow exactly the teardown-before-interaction case and surface everything else.
//
// The ABORT case is the Red driver: without the signal seam, aborting is a no-op and the poll falls
// through to the not-found fault. The Infinity-no-throw, default-2000ms-not-found, and multi-match
// cases are regression guards on behaviour that must stay unchanged. All cases drive a deterministic
// fake clock (sleep advances virtual time and resolves immediately) so no test waits a real 2000ms.
import { test } from "node:test";
import assert from "node:assert/strict";
import { locateTranscript, transcriptGlob, FILE_DISCOVERY_WATCHDOG_MS } from "../dist/jsonl.js";

/** Deterministic fake clock + sleep: sleep(ms) advances virtual time and resolves immediately. */
function makeFakeClock(startAt = 0) {
  let t = startAt;
  return {
    now: () => t,
    sleep: (ms: number) => {
      t += ms;
      return Promise.resolve();
    },
  };
}

test("locate: watchdogMs Infinity polls past the default window and resolves once the transcript appears, never throwing not-found (R1.2)", async () => {
  const clock = makeFakeClock();
  const target = "/home/u/.claude/projects/dash-dir/deferred.jsonl";
  let polls = 0;
  // Absent for many polls (a fresh session before its first interaction), then it appears — only
  // AFTER virtual time has crossed the default 2000ms watchdog, so a non-Infinity poll would have
  // already thrown not-found. Reaching the match proves Infinity disabled the fault.
  const glob = () => (++polls >= 50 ? [target] : []);

  const { transcriptPath } = await locateTranscript("deferred", {
    watchdogMs: Infinity,
    pollIntervalMs: 50,
    now: clock.now,
    sleep: clock.sleep,
    glob,
  });

  assert.equal(transcriptPath, target, "the transcript that finally appeared is adopted");
  assert.ok(
    clock.now() >= FILE_DISCOVERY_WATCHDOG_MS,
    "polled beyond the default watchdog window without firing the not-found fault",
  );
});

test("locate: an AbortSignal aborted mid-poll rejects with an AbortError sentinel, not a not-found error (R1.2)", async () => {
  const clock = makeFakeClock();
  const ac = new AbortController();
  let polls = 0;
  // Never matches; abort partway through. A FINITE watchdog bounds the no-signal-handling path so a
  // regression rejects cleanly with not-found (rather than hanging), and the assertions below prove
  // the abort — not the watchdog — is what rejected.
  const glob = () => {
    if (++polls === 3) ac.abort();
    return [] as string[];
  };

  await assert.rejects(
    () =>
      locateTranscript("aborted-session", {
        watchdogMs: 1000,
        pollIntervalMs: 50,
        now: clock.now,
        sleep: clock.sleep,
        glob,
        signal: ac.signal,
      }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal(
        err.name,
        "AbortError",
        `abort must reject with an AbortError sentinel; got ${(err as Error).name}: ${(err as Error).message}`,
      );
      assert.doesNotMatch(
        err.message,
        /Transcript not found/,
        "an aborted poll must NOT surface the not-found diagnostic",
      );
      return true;
    },
  );

  // The abort short-circuited the poll well before the 1000ms watchdog could fire.
  assert.ok(clock.now() < 1000, "abort rejected before the watchdog window elapsed");
});

test("locate: defaults (2000ms) with a glob that never matches still throws the not-found diagnostic (regression)", async () => {
  const clock = makeFakeClock();
  let polls = 0;
  const glob = () => {
    polls++;
    return [] as string[];
  };

  await assert.rejects(
    () =>
      locateTranscript("ghost", {
        // watchdogMs omitted → defaults to FILE_DISCOVERY_WATCHDOG_MS (2000).
        pollIntervalMs: 50,
        now: clock.now,
        sleep: clock.sleep,
        glob,
      }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(
        err.message.includes(transcriptGlob("ghost")),
        `not-found message must name the glob pattern; got: ${err.message}`,
      );
      assert.ok(
        err.message.includes(String(FILE_DISCOVERY_WATCHDOG_MS)),
        `not-found message must cite the ${FILE_DISCOVERY_WATCHDOG_MS}ms watchdog; got: ${err.message}`,
      );
      return true;
    },
  );

  assert.ok(clock.now() >= FILE_DISCOVERY_WATCHDOG_MS, "default watchdog window was crossed");
  assert.ok(polls >= 2, "kept retrying before the not-found fault");
});

test("locate: more than one match still throws the loud multi-match fault (regression)", async () => {
  const a = "/home/u/.claude/projects/dir-a/dup.jsonl";
  const b = "/home/u/.claude/projects/dir-b/dup.jsonl";

  await assert.rejects(
    () => locateTranscript("dup", { glob: () => [a, b], ...makeFakeClock() }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes(a) && err.message.includes(b), "lists both matched paths");
      assert.ok(/multiple/i.test(err.message), "reads as an ambiguity fault");
      return true;
    },
  );
});
