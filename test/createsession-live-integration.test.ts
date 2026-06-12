// Story 028 / Sub-task 4.2 — OPTIONAL live integration: the deferred fresh-path discovery resolves
// end-to-end against the REAL `claude`, reproducing the ORIGINAL bug condition (a fresh boot writes no
// transcript) and proving the FIX (createSession resolves anyway; the first interaction makes the
// transcript appear → the background discovery arms the watcher).
//
// INTEGRATION test — gated behind RUN_INTEGRATION_TESTS=true. It drives the REAL defaultStartEngine,
// which spawns the real `claude` TUI (`bash -lc 'claude --session-id <id>'`) and completes one tiny
// assistant turn (subscription). Requires `claude` on PATH; NOT run in CI (skipped without the flag).
// node:test runner:
//   RUN_INTEGRATION_TESTS=true npm run build && \
//   RUN_INTEGRATION_TESTS=true node --experimental-strip-types --test test/createsession-live-integration.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { globSync } from "node:fs";
import { defaultStartEngine } from "../dist/acp-agent.js";

const RUN = process.env.RUN_INTEGRATION_TESTS === "true";

/** `~/.claude/projects/**​/<sessionId>.jsonl` — basename == sessionId (§6), cwd-encoding-independent. */
const transcriptGlob = (sessionId: string): string =>
  join(homedir(), ".claude", "projects", "**", `${sessionId}.jsonl`);

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const BOOT_SETTLE_MS = 3000; // let the TUI boot; it writes NO transcript at boot (the bug)
const SUBMIT_DELAY_MS = 60; // text, then a delayed \r submits it (§5 Input)
const ARM_TIMEOUT_MS = 90_000; // bounded wait for the deferred discovery to arm after the interaction

test(
  "live: a fresh createSession resolves BEFORE the transcript exists; the first interaction arms the watcher (R1.1, R1.3)",
  {
    skip: RUN
      ? false
      : "integration: set RUN_INTEGRATION_TESTS=true to run (spawns the real claude TUI, uses subscription)",
    timeout: ARM_TIMEOUT_MS + 30_000,
  },
  async (t) => {
    // onEvent resolves the moment the deferred background discovery arms the watcher and fires the pump.
    let armedSessionId: string | undefined;
    let resolveArmed!: () => void;
    const armed = new Promise<void>((res) => {
      resolveArmed = res;
    });

    // Drive the REAL defaultStartEngine: no injected spawn → real `claude`; no injected glob → real
    // transcript discovery. This exercises the exact production fresh path end-to-end.
    const started = await defaultStartEngine({
      cwd: process.cwd(),
      onEvent: (sid) => {
        armedSessionId = sid;
        resolveArmed();
      },
    });

    let killedByUs = false;
    started.pty.onExit(() => {
      /* the TUI may exit after we kill it; nothing to assert here */
    });

    try {
      // 1. createSession RESOLVED without waiting for the transcript (the pre-fix code aborted here).
      assert.ok(started.sessionId, "createSession resolved with a spawn-generated sessionId");
      assert.equal(started.watcher, undefined, "fresh createSession returned WITHOUT a watcher (deferred)");

      // 2. THE BUG CONDITION: shortly after boot, before any interaction, the TUI has written NO transcript.
      await delay(BOOT_SETTLE_MS);
      const beforeMatches = globSync(transcriptGlob(started.sessionId));
      assert.equal(
        beforeMatches.length,
        0,
        "no transcript exists at boot (pre-interaction) — the ORIGINAL bug condition the fix tolerates",
      );

      // 3. First interaction: type a tiny prompt + submit. The TUI now writes <sessionId>.jsonl.
      started.pty.write("Reply with exactly: ok");
      setTimeout(() => started.pty.write("\r"), SUBMIT_DELAY_MS);

      // 4. The deferred background discovery must now find the transcript and arm the watcher (fire onEvent).
      // Use a CLEARABLE timeout so winning the race (armed first) cancels the timer — otherwise a dangling
      // ARM_TIMEOUT_MS setTimeout would keep the node process alive for the full window after a fast pass.
      let armTimer: ReturnType<typeof setTimeout> | undefined;
      const armedInTime = await Promise.race([
        armed.then(() => true),
        new Promise<boolean>((res) => {
          armTimer = setTimeout(() => res(false), ARM_TIMEOUT_MS);
        }),
      ]);
      if (armTimer) clearTimeout(armTimer);
      assert.ok(armedInTime, `the deferred discovery did not arm the watcher within ${ARM_TIMEOUT_MS}ms`);
      assert.equal(armedSessionId, started.sessionId, "onEvent fired with the engine's sessionId");

      // 5. The transcript appeared under the EXACT pre-generated sessionId, and the watcher is armed.
      const afterMatches = globSync(transcriptGlob(started.sessionId));
      assert.equal(afterMatches.length, 1, "exactly one transcript appeared under the pre-generated sessionId");
      assert.equal(
        basename(afterMatches[0]),
        `${started.sessionId}.jsonl`,
        "the transcript basename equals the pre-generated --session-id",
      );
      assert.ok(started.engine?.watcher, "the watcher is now armed against the discovered transcript");
      t.diagnostic(`transcript: ${afterMatches[0]}`);
    } finally {
      killedByUs = true;
      void killedByUs;
      started.engine?.cleanup(); // aborts any still-pending discovery (3.1) + stops the watcher
      try {
        started.pty.kill();
      } catch {
        /* already gone */
      }
    }
  },
);
