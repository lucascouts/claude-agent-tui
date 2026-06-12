// Story 013 / Task 6.1 — smoke-run proof of the organic `cli` entrypoint (R5.1/R5.2).
//
// INTEGRATION test — gated behind RUN_INTEGRATION_TESTS=true. It spawns the REAL
// `claude` 2.1.159 TUI through the fork engine, drives ONE tiny prompt (a harness
// action, NOT an ACP input surface — the Degrau-1 read-only contract holds), locates
// the <sessionId>.jsonl transcript by glob (E2), polls it to end-of-turn, and asserts
// the distinct message-event `entrypoint` set is exactly {cli}, failing loudly on any
// of sdk-ts/sdk-py/sdk-cli/print. Ports the E1-validated recipe (experiments/e1.ts).
//
// ⚠️ Running it spawns the real TUI and completes one assistant turn (subscription).
// node:test runner: `RUN_INTEGRATION_TESTS=true npm run build && \
//   RUN_INTEGRATION_TESTS=true node --experimental-strip-types --test test/engine-smoke-entrypoint.test.ts`
import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { globSync, readFileSync } from "node:fs";
import { spawnClaudePty } from "../dist/engine-pty.js";

const RUN = process.env.RUN_INTEGRATION_TESTS === "true";

// Minimal deterministic prompt — keep the real assistant turn as small as possible.
const PROMPT = "Reply with exactly: ok";
const SUBMIT_DELAY_MS = 60; // write the text, then a delayed \r submits it (§5 Input)
const TUI_INIT_MS = 4000; // let the TUI initialize before typing (fixed delay is robust)
const POLL_INTERVAL_MS = 1000;
const LOCATE_RETRY_MS = 4000; // bounded window to glob the transcript after submit (E2: <2s typical)
const TURN_TIMEOUT_MS = 90_000; // hard ceiling for the assistant turn
// The four CREDIT-billing entrypoint labels (§10): any presence = billed off subscription.
const CREDIT_ENTRYPOINTS = ["sdk-ts", "sdk-py", "sdk-cli", "print"] as const;

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** `~/.claude/projects/**​/<sessionId>.jsonl` — basename == sessionId (§6), cwd-encoding-independent. */
const transcriptGlob = (sessionId: string): string =>
  join(homedir(), ".claude", "projects", "**", `${sessionId}.jsonl`);

/** Tolerant NDJSON read: parse complete lines, skip any unparsable/partial line. */
function readRecords(path: string): unknown[] {
  const out: unknown[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      /* tolerant: a partial trailing line mid-write is skipped, not fatal */
    }
  }
  return out;
}

/** §10 selector: distinct `.entrypoint` over MESSAGE events only (type assistant|user). */
function extractEntrypoints(records: readonly unknown[]): Set<string> {
  const set = new Set<string>();
  for (const r of records) {
    if (!isRecord(r)) continue;
    if (r.type !== "assistant" && r.type !== "user") continue;
    if (typeof r.entrypoint === "string") set.add(r.entrypoint);
  }
  return set;
}

/** End-of-turn: >= 1 assistant record carries a non-null nested message.stop_reason. */
function turnEnded(records: readonly unknown[]): boolean {
  for (const r of records) {
    if (!isRecord(r) || r.type !== "assistant") continue;
    const msg = r.message;
    if (isRecord(msg) && typeof msg.stop_reason === "string") return true;
  }
  return false;
}

test(
  "smoke: a clean-env spawn drives one turn whose distinct message-event entrypoint set is exactly {cli}",
  {
    skip: RUN
      ? false
      : "integration: set RUN_INTEGRATION_TESTS=true to run (spawns the real claude TUI, uses subscription)",
    timeout: TURN_TIMEOUT_MS + 30_000,
  },
  async (t) => {
    const cwd = process.cwd();
    const { sessionId, pty } = spawnClaudePty({ cwd });

    let ptyTail = "";
    pty.onData((chunk) => {
      ptyTail = (ptyTail + chunk).slice(-4000); // bounded tail for diagnostics
    });
    let killedByUs = false;
    let earlyExit: { exitCode: number; signal: number | undefined } | null = null;
    pty.onExit((e) => {
      if (!killedByUs) earlyExit = e;
    });

    try {
      // 1. Let the TUI boot, then drive the prompt (text, then a delayed \r to submit).
      await delay(TUI_INIT_MS);
      assert.equal(
        earlyExit,
        null,
        `claude TUI exited before the prompt was driven. PTY tail:\n${ptyTail}`,
      );
      pty.write(PROMPT);
      setTimeout(() => pty.write("\r"), SUBMIT_DELAY_MS);

      // 2. Locate the transcript by glob (E2) — bounded retry; basename must equal sessionId.
      let transcriptPath: string | undefined;
      const locateDeadline = Date.now() + LOCATE_RETRY_MS + 2000;
      while (Date.now() < locateDeadline) {
        const matches = globSync(transcriptGlob(sessionId));
        if (matches.length > 1)
          assert.fail(`ambiguous transcript matches for ${sessionId}:\n${matches.join("\n")}`);
        if (matches.length === 1) {
          transcriptPath = matches[0];
          break;
        }
        await delay(200);
      }
      assert.ok(transcriptPath, `transcript not located via glob ${transcriptGlob(sessionId)}`);
      assert.equal(
        basename(transcriptPath),
        `${sessionId}.jsonl`,
        "located transcript basename must equal the sessionId",
      );

      // 3. Poll the located transcript until end-of-turn (or the hard timeout).
      const turnDeadline = Date.now() + TURN_TIMEOUT_MS;
      let records: unknown[] = [];
      let ended = false;
      while (Date.now() < turnDeadline) {
        await delay(POLL_INTERVAL_MS);
        if (earlyExit)
          assert.fail(`claude TUI exited on its own before end-of-turn. PTY tail:\n${ptyTail}`);
        records = readRecords(transcriptPath);
        if (turnEnded(records)) {
          ended = true;
          break;
        }
      }
      assert.ok(
        ended,
        `assistant turn did not complete within ${TURN_TIMEOUT_MS} ms. PTY tail:\n${ptyTail}`,
      );

      // 4. Audit the distinct message-event entrypoint set (§10 / E1 method).
      const entrypoints = extractEntrypoints(records);
      const sorted = [...entrypoints].sort();
      t.diagnostic(`transcript: ${transcriptPath}`);
      t.diagnostic(`distinct message-event entrypoints: ${JSON.stringify(sorted)}`);
      assert.ok(
        entrypoints.size > 0,
        "no message-event entrypoint found — the run produced no auditable turn (R5.1)",
      );
      for (const credit of CREDIT_ENTRYPOINTS) {
        assert.ok(
          !entrypoints.has(credit),
          `CREDIT entrypoint '${credit}' present — run billed as credit, not subscription (R5.2)`,
        );
      }
      assert.deepEqual(
        sorted,
        ["cli"],
        "the distinct message-event entrypoint set must be exactly {cli} (R5.1)",
      );
    } finally {
      killedByUs = true;
      try {
        pty.kill();
      } catch {
        /* already gone */
      }
    }
  },
);
