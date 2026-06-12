// Story 014 / Task 6.1 — integration teardown/leak test for the spawn→kill lifecycle
// (R1.2, R1.3, R5.1). Exercises the full lifecycle built across Tasks 1–5 over many cycles and
// proves cleanup runs exactly once per session leaving no residual handles. This is a test-after
// Integration sub-task: it characterises the assembled lifecycle rather than driving new code.
// node:test runner: `node --experimental-strip-types --test test/engine-teardown.test.ts`
// (run `npm run build` first — behavioral imports resolve against ../dist).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSessionEngine, SessionEngine } from "../dist/engine-lifecycle.js";
import { makeFakePty, makeFakeSpawn, makeFakeTimers } from "./lifecycle-fakes.ts";

test("teardown: N spawn/kill cycles — cleanup once per session, map back to empty (R1.2, R5.1)", () => {
  const sessions = new Map<string, SessionEngine>();
  const N = 8;
  let totalCleanups = 0;

  for (let i = 0; i < N; i++) {
    const fp = makeFakePty();
    const { spawn } = makeFakeSpawn(fp.pty);
    let watcherStops = 0;
    let bodyRuns = 0;

    const eng = createSessionEngine({
      cwd: "/work",
      baseEnv: { SHELL: "/bin/bash" },
      spawn,
      sessions,
      startWatcher: () => ({
        stop() {
          watcherStops++;
        },
      }),
      onCleanup: () => {
        bodyRuns++;
        totalCleanups++;
      },
    });

    // While running: exactly one live session, one onExit handler, no state-driving onData.
    assert.equal(sessions.size, 1, `cycle ${i}: exactly one live session while running`);
    assert.equal(fp.calls.onExitCount, 1, `cycle ${i}: exactly one onExit handler registered`);
    assert.equal(fp.calls.onDataCount, 0, `cycle ${i}: no onData handler (tail-as-truth, §2)`);

    // Explicit kill THEN the subsequent process onExit — both route to the same idempotent cleanup.
    eng.kill();
    assert.equal(fp.calls.kill, 1, `cycle ${i}: kill issued exactly once`);
    fp.fireExit({ exitCode: 0, signal: 9 });

    assert.equal(bodyRuns, 1, `cycle ${i}: cleanup body ran exactly once despite kill + onExit`);
    assert.equal(watcherStops, 1, `cycle ${i}: the one watcher was stopped exactly once`);
    assert.equal(eng.isDisposed, true, `cycle ${i}: engine reports disposed`);
    assert.equal(sessions.size, 0, `cycle ${i}: session map returned to empty (no residual entry)`);
  }

  assert.equal(totalCleanups, N, "exactly one cleanup per session across all cycles");
  assert.equal(
    sessions.size,
    0,
    "no monotonic growth — the shared session map is empty at the end",
  );
});

test("teardown: an armed resize timer returns to baseline after each kill→onExit cycle (R1.3)", () => {
  const timers = makeFakeTimers();
  const sessions = new Map<string, SessionEngine>();

  for (let i = 0; i < 5; i++) {
    const fp = makeFakePty();
    const { spawn } = makeFakeSpawn(fp.pty);

    const eng = createSessionEngine({
      cwd: "/work",
      baseEnv: {},
      spawn,
      sessions,
      startWatcher: () => ({ stop() {} }),
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    eng.requestResize(100, 30); // arm a debounce timer mid-session
    assert.equal(timers.pendingCount(), 1, `cycle ${i}: one resize timer armed`);

    eng.kill();
    fp.fireExit({ exitCode: 0, signal: 9 });

    assert.equal(timers.pendingCount(), 0, `cycle ${i}: resize timer cleared on teardown`);
    assert.equal(sessions.size, 0, `cycle ${i}: session map empty after teardown`);
  }

  assert.equal(
    timers.pendingCount(),
    0,
    "no resize timer leaked across cycles (handle count baseline)",
  );
});

test("teardown: cleanup is single-shot even when onExit fires twice in a cycle (R1.2)", () => {
  const sessions = new Map<string, SessionEngine>();
  const fp = makeFakePty();
  const { spawn } = makeFakeSpawn(fp.pty);
  let bodyRuns = 0;

  const eng = createSessionEngine({
    cwd: "/work",
    baseEnv: {},
    spawn,
    sessions,
    startWatcher: () => ({ stop() {} }),
    onCleanup: () => {
      bodyRuns++;
    },
  });

  fp.fireExit({ exitCode: 0, signal: 0 });
  fp.fireExit({ exitCode: 0, signal: 0 }); // a duplicate exit signal must not re-run cleanup

  assert.equal(bodyRuns, 1, "cleanup body runs once even across duplicate onExit firings");
  assert.equal(sessions.size, 0);
  assert.equal(eng.isDisposed, true);
});
