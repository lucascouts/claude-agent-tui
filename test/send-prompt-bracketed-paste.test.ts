// Story 029 / Task 2.1 — sendPrompt multi-line: bracketed-paste envelope (R2.1-R2.4).
// Validates that multi-line text is wrapped in \x1b[200~…\x1b[201~, embedded newlines
// are preserved verbatim, no per-line splitting occurs, \r is deferred OUTSIDE the
// envelope, and all writes go directly through p.write (§5 Input / R2.1-R2.4).
//
// REVISED by the story-034 G2 live fix: a lone input-clearing Esc now LEADS every submission
// (the TUI restores a cancelled prompt into its input box — session 76fbf771), so the write
// sequence is [\x15, envelope, \r] and both trailing writes are scheduled.
// node:test runner: `node --experimental-strip-types --test test/send-prompt-bracketed-paste.test.ts`
// (run `npm run build` first)
import { test } from "node:test";
import assert from "node:assert/strict";
import { sendPrompt, SUBMISSION_DELAY_MS, CLEAR_INPUT_DELAY_MS } from "../dist/engine-pty.js";

function makeFakePty() {
  const writes: string[] = [];
  return { write: (d: string) => { writes.push(d); }, writes };
}

function makeCapture() {
  const captured: Array<{ fn: () => void; ms: number }> = [];
  const schedule = (fn: () => void, ms: number) => { captured.push({ fn, ms }); };
  return { captured, schedule };
}

/** Run the scheduled payload write so the envelope is observable (the Esc is write[0]). */
function firePayload(captured: Array<{ fn: () => void; ms: number }>): void {
  captured[0].fn();
}

const MULTI = "line one\nline two\nline three";

test("sendPrompt multi-line: body is wrapped in \\x1b[200~ … \\x1b[201~ (R2.1)", () => {
  const p = makeFakePty();
  const { captured, schedule } = makeCapture();

  sendPrompt(p as never, MULTI, schedule);
  firePayload(captured);

  assert.equal(p.writes.length, 2, "clearing Esc + envelope before the scheduled \\r");
  assert.equal(p.writes[0], "\x15", "the input-clearing Ctrl+U leads (034 G2 fix, proved by e-clear)");
  assert.ok(p.writes[1].startsWith("\x1b[200~"), "envelope starts with bracketed-paste open");
  assert.ok(p.writes[1].endsWith("\x1b[201~"), "envelope ends with bracketed-paste close");
});

test("sendPrompt multi-line: embedded newlines are preserved verbatim inside the envelope (R2.2)", () => {
  const p = makeFakePty();
  const { captured, schedule } = makeCapture();

  sendPrompt(p as never, MULTI, schedule);
  firePayload(captured);

  const inner = p.writes[1].slice("\x1b[200~".length, -"\x1b[201~".length);
  assert.equal(inner, MULTI, "the body inside the envelope equals the original text verbatim");
  assert.ok(inner.includes("\n"), "embedded newlines survive inside the paste envelope");
});

test("sendPrompt multi-line: no per-line splitting — the whole envelope is ONE write (R2.2)", () => {
  const p = makeFakePty();
  const { captured, schedule } = makeCapture();

  sendPrompt(p as never, MULTI, schedule);
  firePayload(captured);

  // After the payload write, before \r: Esc + ONE envelope write (no per-line splitting)
  assert.equal(p.writes.length, 2, "exactly one payload write before \\r — no per-line splitting");
  captured[1].fn();
  assert.equal(p.writes.length, 3, "three writes total: Esc + envelope + \\r");
});

test("sendPrompt multi-line: \\r is deferred OUTSIDE the paste envelope (R2.1, §8)", () => {
  const p = makeFakePty();
  const { captured, schedule } = makeCapture();

  sendPrompt(p as never, MULTI, schedule);

  assert.equal(captured[0].ms, CLEAR_INPUT_DELAY_MS, "payload delay is the Esc-disambiguation window");
  assert.equal(
    captured[1].ms,
    CLEAR_INPUT_DELAY_MS + SUBMISSION_DELAY_MS,
    "\\r delay preserves the §8 submission window after the payload",
  );
  firePayload(captured);
  captured[1].fn();

  // The \r must be a separate write AFTER the envelope, not embedded inside it
  assert.equal(p.writes[2], "\r", "deferred write is \\r");
  assert.ok(
    !p.writes[1].includes("\r"),
    "\\r is NOT embedded inside the bracketed-paste body",
  );
});

test("sendPrompt multi-line: writes go through p.write directly, no xterm.js (R2.4)", () => {
  const p = makeFakePty();
  const { captured, schedule } = makeCapture();

  sendPrompt(p as never, MULTI, schedule);
  firePayload(captured);
  captured[1].fn();

  // The Esc, the envelope, and the \r all came through p.write
  assert.equal(p.writes.length, 3, "all three writes arrived via p.write");
});

test("sendPrompt single-line still works unchanged after multi-line branch is added (R1.1-R1.4)", () => {
  const p = makeFakePty();
  const { captured, schedule } = makeCapture();

  sendPrompt(p as never, "no newlines here", schedule);
  firePayload(captured);

  assert.equal(p.writes.length, 2);
  assert.equal(p.writes[1], "no newlines here", "single-line: body written verbatim (no brackets)");
  assert.ok(!p.writes[1].includes("\x1b[200~"), "single-line: no bracketed-paste markers");
  captured[1].fn();
  assert.equal(p.writes[2], "\r");
});
