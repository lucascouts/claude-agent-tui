// Story 028 / Sub-task 4.1 — the RESUME path is UNCHANGED (R2). The fresh-path deferral (2.1) must
// not regress resume: a resumed session keeps the SYNCHRONOUS discovery with the DEFAULT 2000ms FATAL
// file-discovery watchdog. So:
//   R2.2 — resume against an EXISTING transcript discovers it and arms the watcher synchronously.
//   R2.1 — resume against a MISSING transcript still fails FAST with the not-found diagnostic naming
//          the 2000ms watchdog (NOT the fresh path's unbounded Infinity poll).
//
// These are REGRESSION GUARDS: the resume branch is unchanged by 028 (it only threads the new
// locateOptions/spawn seams), so both already pass on the post-2.1/3.1 code — this locks that in.
// node:test runner: `node --experimental-strip-types --test test/resume-discovery-unchanged.test.ts`
// (run `npm run build` first — behavioral imports resolve against ../dist).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultStartEngine } from "../dist/acp-agent.js";
import { transcriptGlob, FILE_DISCOVERY_WATCHDOG_MS } from "../dist/jsonl.js";

/** A fake PTY handle — mirrors the createSession integration tests. */
function makeFakePty() {
  return {
    onExit: () => ({ dispose() {} }),
    onData: () => ({ dispose() {} }),
    resize: () => {},
    write: () => {},
    kill: () => {},
  } as never;
}

/** A fake node-pty spawn so spawnResumePty launches NO real `claude`. */
function makeFakeSpawn() {
  return (() => makeFakePty()) as never;
}

/** Deterministic fake clock + sleep so the not-found case crosses 2000ms WITHOUT a real wait. */
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

/** Write a real tmp transcript carrying a `.cwd`-bearing JSONL line (an already-existing resume target). */
function makeFixtureTranscript(sessionId: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "resume-unchanged-"));
  const path = join(dir, `${sessionId}.jsonl`);
  const line = JSON.stringify({
    type: "assistant",
    uuid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    cwd: "/runtime/cwd/from/inside",
    message: { role: "assistant", content: [{ type: "text", text: "resumed transcript" }] },
  });
  writeFileSync(path, line + "\n");
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("resume with an EXISTING transcript discovers it and arms the watcher synchronously (R2.2)", async () => {
  const sessionId = "55555555-5555-4555-8555-555555555555";
  const fixture = makeFixtureTranscript(sessionId);
  try {
    const started = await defaultStartEngine({
      resume: true,
      sessionId,
      cwd: "/host/work/dir",
      spawn: makeFakeSpawn(),
      locateOptions: { glob: () => [fixture.path] }, // first poll already matches → synchronous
    });

    assert.equal(started.sessionId, sessionId, "resume keeps the requested sessionId");
    assert.ok(started.watcher, "resume arms the watcher SYNCHRONOUSLY on the create path (not deferred)");
    assert.equal(
      started.cwd,
      "/runtime/cwd/from/inside",
      "resume reads the runtime cwd from INSIDE the existing transcript",
    );

    started.engine?.cleanup();
  } finally {
    fixture.cleanup();
  }
});

test("resume with NO transcript still fails fast via the 2000ms not-found watchdog (R2.1)", async () => {
  const sessionId = "66666666-6666-4666-8666-666666666666";
  const clock = makeFakeClock();

  // Resume threads locateOptions but NOT watchdogMs:Infinity (that is fresh-only) — so a never-matching
  // glob still throws the DEFAULT 2000ms not-found fault, on the create path (blocking, as before 028).
  await assert.rejects(
    () =>
      defaultStartEngine({
        resume: true,
        sessionId,
        cwd: "/host/work/dir",
        spawn: makeFakeSpawn(),
        locateOptions: { glob: () => [], now: clock.now, sleep: clock.sleep },
      }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(
        err.message.includes(transcriptGlob(sessionId)),
        `resume not-found must name the glob pattern; got: ${err.message}`,
      );
      assert.ok(
        err.message.includes(String(FILE_DISCOVERY_WATCHDOG_MS)),
        `resume not-found must cite the ${FILE_DISCOVERY_WATCHDOG_MS}ms watchdog; got: ${err.message}`,
      );
      return true;
    },
  );

  assert.ok(
    clock.now() >= FILE_DISCOVERY_WATCHDOG_MS,
    "resume crossed the DEFAULT 2000ms fatal watchdog (not the fresh path's unbounded Infinity poll)",
  );
});
