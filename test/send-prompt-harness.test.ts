// Story 029 / Task 4.1 — Submission harness: short single-line + long multi-line both appear
// as `user` events in the JSONL; the multi-line one is exactly ONE turn (R3.1, R3.2, R5.1, R5.2).
//
// This is the end-to-end validation harness covering R3 (reliable submission) and R5 (harness
// assertions). Two sessions: (a) a short single-line prompt, (b) a long multi-line bracketed-paste
// prompt. Both must produce `user` events; the multi-line one must be ONE turn.
//
// INTEGRATION test — gated behind RUN_INTEGRATION_TESTS=true. Spawns the REAL `claude` TUI.
// Requires `claude` on PATH. NOT run in CI (skipped without the env flag).
//
// node:test runner (build first):
//   RUN_INTEGRATION_TESTS=true npm run build && \
//   RUN_INTEGRATION_TESTS=true node --experimental-strip-types --test test/send-prompt-harness.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultStartEngine } from "../dist/acp-agent.js";
import { sendPrompt } from "../dist/engine-pty.js";

const RUN = process.env.RUN_INTEGRATION_TESTS === "true";

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const transcriptGlob = (id: string): string =>
  join(homedir(), ".claude", "projects", "**", `${id}.jsonl`);

/** Poll until an `assistant` event with `stop_reason` appears or timeout. */
async function waitForTurnEnd(sessionId: string, timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await delay(500);
    const paths = globSync(transcriptGlob(sessionId));
    if (paths.length === 0) continue;
    try {
      const lines = readFileSync(paths[0], "utf8").split("\n").filter((l) => l.trim());
      for (const line of lines) {
        try {
          const e = JSON.parse(line) as { type?: string; message?: { stop_reason?: string } };
          if (e.type === "assistant" && e.message?.stop_reason) return paths[0];
        } catch { /* skip */ }
      }
    } catch { /* not readable yet */ }
  }
  return null;
}

/** Parse all `user` events from a transcript file. */
function readUserEvents(path: string): string[] {
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim());
  return lines.filter((l) => {
    try { return (JSON.parse(l) as { type?: string }).type === "user"; }
    catch { return false; }
  });
}

const BOOT_MS = 5000;
const TURN_TIMEOUT_MS = 90_000;

test(
  "harness: a SHORT single-line prompt appears as a user event in the JSONL (R3.1, R5.1)",
  {
    skip: RUN
      ? false
      : "integration: set RUN_INTEGRATION_TESTS=true to run (spawns real claude TUI)",
    timeout: BOOT_MS + TURN_TIMEOUT_MS + 10_000,
  },
  async (t) => {
    const started = await defaultStartEngine({ cwd: process.cwd() });
    try {
      t.diagnostic(`session: ${started.sessionId}`);
      await delay(BOOT_MS);

      const prompt = "Reply with exactly: ok";
      sendPrompt(started.pty, prompt);

      const path = await waitForTurnEnd(started.sessionId, TURN_TIMEOUT_MS);
      assert.ok(path, `turn did not complete within ${TURN_TIMEOUT_MS}ms`);
      t.diagnostic(`transcript: ${path}`);

      const userEvents = readUserEvents(path!);
      t.diagnostic(`user events: ${userEvents.length}`);
      assert.equal(userEvents.length, 1, "exactly ONE user event for ONE single-line prompt (R5.1)");

      // Verify the submitted text is present in the user event
      const body = JSON.parse(userEvents[0]) as { message?: { content?: unknown } };
      const content = body.message?.content;
      const text = Array.isArray(content)
        ? content.map((b: unknown) => (b as { text?: string }).text ?? "").join("")
        : String(content ?? "");
      assert.ok(text.includes("ok"), `submitted text found in the user event: "${text.slice(0, 80)}"`);
    } finally {
      started.engine?.cleanup();
      try { started.pty.kill(); } catch { /* already gone */ }
    }
  },
);

test(
  "harness: a LONG multi-line bracketed-paste prompt appears as ONE user event and ONE turn (R3.1, R3.2, R5.1, R5.2)",
  {
    skip: RUN
      ? false
      : "integration: set RUN_INTEGRATION_TESTS=true to run (spawns real claude TUI)",
    timeout: BOOT_MS + TURN_TIMEOUT_MS + 10_000,
  },
  async (t) => {
    const started = await defaultStartEngine({ cwd: process.cwd() });
    try {
      t.diagnostic(`session: ${started.sessionId}`);
      await delay(BOOT_MS);

      // Long multi-line prompt: 5 lines, simulates a pasted code block (R3.2 — long input)
      const longPrompt = [
        "Reply with the word: done",
        "This is line 2 of the prompt.",
        "This is line 3 — a longer paragraph to exercise the bracketed-paste path with more bytes.",
        "This is line 4 with some extra content.",
        "Final line — end of the multi-line block.",
      ].join("\n");

      sendPrompt(started.pty, longPrompt);

      // Assert the delayed \r submits reliably for long inputs (R3.2: \r not absorbed into the body)
      const path = await waitForTurnEnd(started.sessionId, TURN_TIMEOUT_MS);
      assert.ok(path, `turn did not complete within ${TURN_TIMEOUT_MS}ms — possible \r absorption (R3.2)`);
      t.diagnostic(`transcript: ${path}`);

      const userEvents = readUserEvents(path!);
      t.diagnostic(`user events found: ${userEvents.length}`);

      // ONE user event = whole block treated as single submission (R5.2)
      assert.equal(
        userEvents.length,
        1,
        `expected ONE user event for the multi-line bracketed-paste; got ${userEvents.length} — TUI may have split on newlines (R5.2)`,
      );
    } finally {
      started.engine?.cleanup();
      try { started.pty.kill(); } catch { /* already gone */ }
    }
  },
);
