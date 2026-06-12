// Story 014 / Task 3.1 — expose Ctrl+C / Esc / kill primitives, inert after exit (R3.1-R3.4).
// node:test runner: `node --experimental-strip-types --test test/engine-cancel-primitives.test.ts`
// (run `npm run build` first — behavioral imports resolve against ../dist).
//
// These are the RAW byte/kill mechanics only — they are EXPOSED but NOT wired to any ACP
// session/cancel handler (Degrau-1 read-only; that wiring is story 030).
import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionEngine } from "../dist/engine-lifecycle.js";
import { makeFakePty, makeFakeWatcher } from "./lifecycle-fakes.ts";

function engine() {
  const fp = makeFakePty();
  const { watcher } = makeFakeWatcher();
  const eng = new SessionEngine({ handle: { sessionId: "S1", pty: fp.pty }, watcher });
  return { eng, calls: fp.calls, fireExit: fp.fireExit };
}

test("interrupt writes the Ctrl+C byte \\x03 to the PTY (R3.1)", () => {
  const { eng, calls } = engine();
  eng.interrupt();
  assert.deepEqual(calls.write, ["\x03"]);
});

test("escape writes the Esc byte \\x1b to the PTY (R3.2)", () => {
  const { eng, calls } = engine();
  eng.escape();
  assert.deepEqual(calls.write, ["\x1b"]);
});

test("kill calls p.kill() exactly once (R3.3)", () => {
  const { eng, calls } = engine();
  eng.kill();
  assert.equal(calls.kill, 1);
});

test("all three primitives reach the PTY in one session (R3.1-R3.3)", () => {
  const { eng, calls } = engine();
  eng.interrupt();
  eng.escape();
  eng.kill();
  assert.deepEqual(calls.write, ["\x03", "\x1b"], "two writes: Ctrl+C then Esc");
  assert.equal(calls.kill, 1, "one kill");
});

test("primitives are inert after the PTY has exited: no write/kill, no throw (R3.4)", () => {
  const { eng, calls, fireExit } = engine();
  fireExit({ exitCode: 0, signal: 0 }); // PTY exits → cleanup → disposed

  assert.doesNotThrow(() => {
    eng.interrupt();
    eng.escape();
    eng.kill();
  }, "a cancel primitive after exit must not write to a dead handle");

  assert.equal(calls.write.length, 0, "no bytes written after exit");
  assert.equal(calls.kill, 0, "no kill issued after exit");
});

test("primitives are inert after an explicit cleanup (R3.4)", () => {
  const { eng, calls } = engine();
  eng.cleanup();
  assert.doesNotThrow(() => {
    eng.interrupt();
    eng.escape();
    eng.kill();
  });
  assert.equal(calls.write.length, 0);
  assert.equal(calls.kill, 0);
});
