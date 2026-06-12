// Story 014 / Task 5.1 — bind PTY + JSONL watcher into one per-session owner; tail-as-truth (R5).
// node:test runner: `node --experimental-strip-types --test test/engine-single-process.test.ts`
// (run `npm run build` first — behavioral imports resolve against ../dist).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createSessionEngine, SessionEngine } from "../dist/engine-lifecycle.js";
import { makeFakePty, makeFakeSpawn } from "./lifecycle-fakes.ts";

test("createSessionEngine starts exactly ONE PTY and ONE watcher in this process (R5.1)", () => {
  const fp = makeFakePty();
  const { calls, spawn } = makeFakeSpawn(fp.pty);
  let watcherStarts = 0;

  const eng = createSessionEngine({
    cwd: "/work",
    baseEnv: { SHELL: "/bin/bash" },
    spawn,
    startWatcher: () => {
      watcherStarts++;
      return { stop() {} };
    },
  });

  assert.equal(calls.length, 1, "exactly one PTY spawned via the story 013 path");
  assert.equal(watcherStarts, 1, "exactly one watcher started for the session");
  assert.ok(eng instanceof SessionEngine, "returns the single per-session engine record");
  assert.equal(eng.pty, fp.pty, "the engine owns the spawned PTY handle");
});

test("the watcher factory receives the spawned session id and PTY (one owner) (R5.1)", () => {
  const fp = makeFakePty();
  const { spawn } = makeFakeSpawn(fp.pty);
  let seenSessionId: string | undefined;
  let seenPty: unknown;

  const eng = createSessionEngine({
    cwd: "/work",
    baseEnv: {},
    spawn,
    startWatcher: (sessionId, p) => {
      seenSessionId = sessionId;
      seenPty = p;
      return { stop() {} };
    },
  });

  assert.equal(seenSessionId, eng.sessionId, "watcher is bound to the spawned session id");
  assert.equal(seenPty, fp.pty, "watcher is bound to the same PTY the engine owns");
});

test("the engine subscribes NO state-driving onData — tail is the source of truth (R5.2)", () => {
  const fp = makeFakePty();
  const { spawn } = makeFakeSpawn(fp.pty);

  createSessionEngine({
    cwd: "/work",
    baseEnv: {},
    spawn,
    startWatcher: () => ({ stop() {} }),
  });

  assert.equal(
    fp.calls.onDataCount,
    0,
    "no onData handler is attached — session state derives solely from the JSONL tail (§2); " +
      "the cosmetic live mirror is story 034",
  );
});

test("tearing down the engine stops the single watcher exactly once (R5.1)", () => {
  const fp = makeFakePty();
  const { spawn } = makeFakeSpawn(fp.pty);
  let stops = 0;

  const eng = createSessionEngine({
    cwd: "/work",
    baseEnv: {},
    spawn,
    startWatcher: () => ({
      stop() {
        stops++;
      },
    }),
  });

  fp.fireExit({ exitCode: 0, signal: 0 });
  assert.equal(stops, 1, "the one watcher is stopped once when its one PTY exits");
  assert.equal(eng.isDisposed, true);
});

test("the lifecycle module spawns no second process — no child_process / cluster import (R5.1)", () => {
  const src = readFileSync(new URL("../dist/engine-lifecycle.js", import.meta.url), "utf8");
  // Match IMPORT/REQUIRE statements only: the doc-comment legitimately mentions
  // "child_process.fork" to assert it is NOT used, so a bare substring scan would false-positive.
  const importsProcessForker =
    /\bfrom\s+["'](?:node:)?child_process["']/.test(src) ||
    /\brequire\(\s*["'](?:node:)?child_process["']\s*\)/.test(src) ||
    /\bfrom\s+["'](?:node:)?cluster["']/.test(src);
  assert.equal(
    importsProcessForker,
    false,
    "the engine owns its PTY+watcher in-process — no child_process/cluster fork of a second process",
  );
});
