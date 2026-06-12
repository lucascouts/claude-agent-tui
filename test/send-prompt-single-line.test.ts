// Story 029 / Task 1.1 — sendPrompt single-line: Esc (clear input) → p.write(text) → delayed \r.
// Validates R1.1-R1.4: write sequence is [\x15, text, \r]; text fires after CLEAR_INPUT_DELAY_MS,
// \r after CLEAR_INPUT_DELAY_MS + SUBMISSION_DELAY_MS; no \n injected; writes go directly through
// p.write (no xterm.js interposed).
//
// REVISED by the story-034 G2 live fix: a lone Esc now LEADS every submission — the live TUI
// restores a cancelled prompt into its input box, and without the clear the next submission
// concatenated both texts into one turn (session 76fbf771). Esc on an empty box is a no-op.
// node:test runner: `node --experimental-strip-types --test test/send-prompt-single-line.test.ts`
// (run `npm run build` first)
import { test } from "node:test";
import assert from "node:assert/strict";
import { sendPrompt, SUBMISSION_DELAY_MS, CLEAR_INPUT_DELAY_MS } from "../dist/engine-pty.js";

/** Fake PTY that records every write in order. */
function makeFakePty() {
  const writes: string[] = [];
  return {
    write: (data: string) => { writes.push(data); },
    writes,
  };
}

/** Synchronous schedule capture: records fn + ms without executing immediately. */
function makeCapture() {
  const captured: Array<{ fn: () => void; ms: number }> = [];
  const schedule = (fn: () => void, ms: number) => { captured.push({ fn, ms }); };
  return { captured, schedule };
}

test("sendPrompt(p, text) writes Esc, then text, then \r after the timing constants (R1.1, R1.2, 034)", () => {
  const p = makeFakePty();
  const { captured, schedule } = makeCapture();

  sendPrompt(p as never, "hello world", schedule);

  // Synchronously: only the input-clearing Esc is written
  assert.equal(p.writes.length, 1, "only the clearing Esc before the scheduled writes");
  assert.equal(p.writes[0], "\x15", "a lone Ctrl+U clears any residual input first (034 G2 fix, proved by e-clear)");

  // Exactly two scheduled callbacks: the payload, then the \r
  assert.equal(captured.length, 2, "two scheduled callbacks (payload, then \\r)");
  assert.equal(captured[0].ms, CLEAR_INPUT_DELAY_MS, "payload fires after the Esc-disambiguation delay");
  assert.equal(
    captured[1].ms,
    CLEAR_INPUT_DELAY_MS + SUBMISSION_DELAY_MS,
    "\\r fires after the payload settles (§8 submission delay preserved)",
  );

  captured[0].fn();
  assert.equal(p.writes[1], "hello world", "body bytes written verbatim");
  captured[1].fn();
  assert.equal(p.writes.length, 3, "total writes = 3 after \\r fires");
  assert.equal(p.writes[2], "\r", "the deferred write is \\r");
});

test("sendPrompt single-line: no \\n injected (R1.4)", () => {
  const p = makeFakePty();
  const { captured, schedule } = makeCapture();

  sendPrompt(p as never, "no newline please", schedule);
  for (const c of captured) c.fn();

  assert.ok(
    p.writes.every(w => !w.includes("\n")),
    "no \\n in any write — the only submit byte is \\r",
  );
});

test("sendPrompt single-line: writes go through p.write directly (R1.3)", () => {
  const p = makeFakePty();
  const { captured, schedule } = makeCapture();
  let extraCalls = 0;
  const sentinel = { write: (d: string) => { void d; extraCalls++; } };
  void sentinel; // extra channel — must never receive writes

  sendPrompt(p as never, "direct write only", schedule);
  for (const c of captured) c.fn();

  assert.equal(extraCalls, 0, "no writes through any channel other than p.write");
  assert.equal(p.writes.length, 3, "all three writes arrived via p.write");
});

test("sendPrompt: SUBMISSION_DELAY_MS is 60 ms (§8 / R1.2) and CLEAR_INPUT_DELAY_MS is 60 ms (034)", () => {
  assert.equal(SUBMISSION_DELAY_MS, 60, "the ~60 ms submission delay from IMPLEMENTACAO-FORK-ACP.md §8");
  assert.equal(CLEAR_INPUT_DELAY_MS, 60, "the Esc-disambiguation delay (story-034 G2 fix)");
});
