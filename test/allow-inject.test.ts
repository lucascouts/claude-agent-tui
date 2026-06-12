// Story 033 / Task 3.1 — hybrid allow keystroke injection (#52822): allow + non-suppressed prompt
// injects '1\r'; a refusal types 'No'; an injection timeout yields a STUCK warning, not an approval
// (R3.1, R3.2).
//
// OFFLINE: a FAKE PTY writer captures the keystrokes; `isPromptShown` models the TUI state. An
// injectable synchronous schedule drives the poll loop deterministically.
//
// node:test: build first, then
//   node --experimental-strip-types --test test/allow-inject.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clearNativePrompt,
  keystrokeFor,
  KEYSTROKE_NO,
  KEYSTROKE_YES,
  type PtyWriter,
} from "../dist/permissions/allow-inject.js";

/** A fake PTY writer recording every keystroke written. */
function fakePty(): PtyWriter & { writes: string[] } {
  const writes: string[] = [];
  return {
    writes,
    write(data: string) {
      writes.push(data);
    },
  };
}

/** A synchronous schedule that runs the callback immediately (drives the poll loop without timers). */
const immediate = (fn: () => void) => {
  fn();
};

test("3.1 keystrokeFor: allow → '1\\r' (Yes), deny → 'No' (refusal)", () => {
  assert.equal(keystrokeFor("allow"), "1\r");
  assert.equal(keystrokeFor("deny"), "No");
  assert.equal(KEYSTROKE_YES, "1\r");
  assert.equal(KEYSTROKE_NO, "No");
});

test("3.1 allow + a non-suppressed prompt injects '1\\r' and reports cleared", async () => {
  const pty = fakePty();
  // Prompt is shown initially, then clears after the keystroke is written.
  let shown = true;
  const result = await clearNativePrompt({
    pty,
    decision: "allow",
    isPromptShown: () => shown,
    schedule: (fn) => {
      shown = false; // the keystroke cleared the prompt before the first poll
      fn();
    },
  });
  assert.equal(result.status, "cleared");
  assert.deepEqual(pty.writes, ["1\r"], "the Yes keystroke was injected exactly once");
});

test("3.1 a refusal (deny) types 'No' to clear the prompt", async () => {
  const pty = fakePty();
  let shown = true;
  const result = await clearNativePrompt({
    pty,
    decision: "deny",
    isPromptShown: () => shown,
    schedule: (fn) => {
      shown = false;
      fn();
    },
  });
  assert.equal(result.status, "cleared");
  assert.deepEqual(pty.writes, ["No"], "the refusal keystroke is 'No', never a spoofed Yes");
});

test("3.1 a SUPPRESSED prompt injects nothing (the 2.1.161 case) — never type into a missing prompt", async () => {
  const pty = fakePty();
  const result = await clearNativePrompt({
    pty,
    decision: "allow",
    isPromptShown: () => false, // already suppressed
    schedule: immediate,
  });
  assert.equal(result.status, "suppressed");
  assert.equal(pty.writes.length, 0, "no keystroke is typed when the prompt is already gone");
});

test("3.1 an injection TIMEOUT yields a stuck-prompt warning and does NOT approve (R3.2)", async () => {
  const pty = fakePty();
  let warned = "";
  // The prompt stays shown forever; the poll loop must time out and warn.
  const result = await clearNativePrompt({
    pty,
    decision: "allow",
    isPromptShown: () => true, // never clears
    timeoutMs: 100,
    pollMs: 50,
    schedule: immediate, // each poll advances elapsed by pollMs synchronously
    onWarn: (m) => (warned = m),
  });
  assert.equal(result.status, "stuck", "a never-clearing prompt is STUCK, not approved");
  assert.deepEqual(pty.writes, ["1\r"], "the keystroke was attempted once");
  assert.match(warned, /STUCK PROMPT/);
  assert.match(warned, /NOT approving silently/);
  assert.match(warned, /#52822/);
});

test("3.1 the stuck result is distinct from cleared — the caller must not treat stuck as allow", async () => {
  const pty = fakePty();
  const stuck = await clearNativePrompt({
    pty,
    decision: "allow",
    isPromptShown: () => true,
    timeoutMs: 50,
    pollMs: 50,
    schedule: immediate,
  });
  assert.notEqual(stuck.status, "cleared");
  assert.notEqual(stuck.status, "suppressed");
  assert.equal(stuck.status, "stuck");
});

test("3.1 the prompt clears after a few polls (not on the first) → cleared, single keystroke", async () => {
  const pty = fakePty();
  let pollsLeft = 3;
  const result = await clearNativePrompt({
    pty,
    decision: "allow",
    isPromptShown: () => pollsLeft > 0,
    timeoutMs: 1000,
    pollMs: 50,
    schedule: (fn) => {
      pollsLeft -= 1;
      fn();
    },
  });
  assert.equal(result.status, "cleared");
  assert.deepEqual(pty.writes, ["1\r"], "the keystroke is written ONCE, not re-spammed each poll");
});
