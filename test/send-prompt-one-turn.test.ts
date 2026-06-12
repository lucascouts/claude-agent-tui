// Story 029 / Task 2.2 — Integration: bracketed-paste multi-line submits as EXACTLY ONE turn.
// Validates R2.3: the TUI treats the whole pasted block as ONE turn (one `user` event), not
// one turn per embedded newline — confirming the previously-UNTESTED bracketed-paste path
// (IMPLEMENTACAO-FORK-ACP.md §5 / §14 Degrau 2 input).
//
// INTEGRATION test — gated behind RUN_INTEGRATION_TESTS=true. Spawns the REAL `claude` TUI.
// Requires `claude` on PATH. NOT run in CI (skipped without the env flag).
//
// node:test runner (build first):
//   RUN_INTEGRATION_TESTS=true npm run build && \
//   RUN_INTEGRATION_TESTS=true node --experimental-strip-types --test test/send-prompt-one-turn.test.ts
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

/** Tail-poll the transcript until an `assistant` event with `stop_reason` appears, or timeout.
 *  The story-024 E3 detector signals turn completion this way (no `result` event on all builds). */
async function waitForTurnEnd(sessionId: string, timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await delay(500);
    const paths = globSync(transcriptGlob(sessionId));
    if (paths.length === 0) continue;
    try {
      const lines = readFileSync(paths[0], "utf8")
        .split("\n")
        .filter((l) => l.trim());
      for (const line of lines) {
        try {
          const e = JSON.parse(line) as { type?: string; message?: { stop_reason?: string } };
          if (e.type === "assistant" && e.message?.stop_reason) return paths[0];
        } catch { /* malformed line — skip */ }
      }
    } catch { /* file not readable yet */ }
  }
  return null;
}

const BOOT_MS = 5000;   // let the TUI boot and settle before submitting
const TURN_TIMEOUT_MS = 90_000; // maximum time to wait for the turn result

test(
  "live: a 3-line bracketed-paste prompt submits as exactly ONE turn — validating the UNTESTED path (R2.3)",
  {
    skip: RUN
      ? false
      : "integration: set RUN_INTEGRATION_TESTS=true to run (spawns the real claude TUI, uses subscription)",
    timeout: BOOT_MS + TURN_TIMEOUT_MS + 10_000,
  },
  async (t) => {
    const started = await defaultStartEngine({ cwd: process.cwd() });

    try {
      // 1. Let the TUI boot; it writes no transcript until the first interaction (story 028 behaviour).
      t.diagnostic(`session: ${started.sessionId}`);
      await delay(BOOT_MS);

      // 2. Submit a 3-line multi-line prompt via sendPrompt (bracketed-paste path).
      //    If the TUI splits on each \n, we get 3 `user` events; ONE turn means ONE `user` event.
      const multiLinePrompt = "Reply with exactly:\nok\n(nothing else)";
      sendPrompt(started.pty, multiLinePrompt);

      // 3. Wait for an `assistant` event with stop_reason (turn completion signal, E3 / story 024).
      const transcriptPath = await waitForTurnEnd(started.sessionId, TURN_TIMEOUT_MS);
      assert.ok(
        transcriptPath,
        `turn did not complete within ${TURN_TIMEOUT_MS}ms — transcript: ${transcriptGlob(started.sessionId)}`,
      );
      t.diagnostic(`transcript: ${transcriptPath}`);

      // 4. Count `user` events in the transcript.
      //    ONE event = bracketed-paste kept the block as a single submission.
      //    MULTIPLE events = the TUI split on the embedded newlines (UNTESTED path failed).
      const lines = readFileSync(transcriptPath!, "utf8")
        .split("\n")
        .filter((l) => l.trim());
      const userEvents = lines.filter((l) => {
        try { return (JSON.parse(l) as { type?: string }).type === "user"; }
        catch { return false; }
      });

      t.diagnostic(`user events found: ${userEvents.length}`);
      assert.equal(
        userEvents.length,
        1,
        `expected exactly ONE user event for ONE bracketed-paste submission; got ${userEvents.length} — the TUI may have split the multi-line block`,
      );
    } finally {
      started.engine?.cleanup();
      try { started.pty.kill(); } catch { /* already gone */ }
    }
  },
);
