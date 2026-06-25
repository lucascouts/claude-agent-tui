// Story 054 / Task 6.1 — the native SUBAGENT permission prompt ("Tool use · from the <name> agent")
// must be recognized by the prompt-detection so the gate's allow-sweep can clear it, and the clear
// path must type the ALLOW key on allow and the DENY key on deny (R6 — both paths).
//
// Contract (design.md fix step 5): add the subagent prompt marker(s) so textShowsNativePrompt /
// isPromptShown recognize the "Tool use · from the … agent" box; clearNativePrompt types the allow
// key on allow and the deny key on deny. (Exact live keys confirmed in the deferred in-Zed proof; the
// keystroke VALUES are already owned by keystrokeFor — this task is the MARKER + both-paths drive.)
//
// Authored from the contract + the existing allow-inject.test.ts harness (no ToDo). OFFLINE: a fake
// PTY writer captures keystrokes; isPromptShown models the TUI. node:test (build first):
//   node --experimental-strip-types --test test/allow-inject-subagent.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { clearNativePrompt, keystrokeFor, type PtyWriter } from "../dist/permissions/allow-inject.js";
import { textShowsNativePrompt } from "../dist/permissions/gate-wiring.js";

function fakePty(): PtyWriter & { writes: string[] } {
  const writes: string[] = [];
  return {
    writes,
    write(data: string) {
      writes.push(data);
    },
  };
}

// The native subagent permission box as claude renders it (the "Tool use · from the … agent" header).
const SUBAGENT_PROMPT =
  "╭─ Tool use · from the general-purpose agent ─╮\n" +
  "│ Bash(ls -la)                               │\n" +
  "│ Do you want to proceed?                    │\n" +
  "╰─────────────────────────────────────────────╯";

// The SUBAGENT-SPECIFIC header alone, WITHOUT any main-chain marker line — this is the regression the
// fix targets: today's markers ("Do you want to proceed", "1. Yes", …) don't cover the subagent box
// header, so a subagent prompt that renders only its own header is invisible to the sweep.
const SUBAGENT_HEADER_ONLY = "Tool use · from the research-agent agent";

test("6.1 textShowsNativePrompt recognizes the subagent prompt box header (the R6 marker)", () => {
  assert.equal(
    textShowsNativePrompt(SUBAGENT_HEADER_ONLY),
    true,
    'the "Tool use · from the … agent" header must be a recognized native-prompt marker',
  );
});

test("6.1 the full subagent box is also recognized", () => {
  assert.equal(textShowsNativePrompt(SUBAGENT_PROMPT), true, "the rendered subagent box is detected");
});

test("6.1 plain subagent text WITHOUT the prompt header is NOT a false positive", () => {
  assert.equal(
    textShowsNativePrompt("the general-purpose agent finished its work"),
    false,
    "ordinary subagent narration must not be mistaken for a permission prompt",
  );
});

test("6.1 ALLOW path types the allow key to clear the subagent prompt", async () => {
  const pty = fakePty();
  let shown = true;
  const result = await clearNativePrompt({
    pty,
    decision: "allow",
    isPromptShown: () => shown,
    schedule: (fn) => {
      shown = false;
      fn();
    },
  });
  assert.equal(result.status, "cleared", "the subagent prompt clears on allow");
  assert.deepEqual(pty.writes, [keystrokeFor("allow")], "the ALLOW key was injected to clear the subagent box");
});

test("6.1 DENY path types the deny key to clear the subagent prompt (R6 — both paths drive the TUI)", async () => {
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
  assert.equal(result.status, "cleared", "the subagent prompt also clears on deny — never left hanging");
  assert.deepEqual(
    pty.writes,
    [keystrokeFor("deny")],
    "the DENY key (not a spoofed allow) was injected to clear the subagent box",
  );
});
