#!/usr/bin/env node
// experiments/smoke-live.mjs — Story 049 / Task 5.1 (R3.1, R3.2, R3.3) — LOCAL pre-release smoke test.
//
// EXPERIMENT, NOT IN CI (C3). The live mode spawns the REAL subscription `claude` binary; CI has no
// subscription binary, so this script is deliberately NOT wired into `test:run`/`test:fork`. It lives
// under experiments/ (NOT test/*.test.ts, which `test:fork` globs into CI) and is run by hand before a
// release via `npm run smoke:live`.
//
// WHAT IT DOES (live mode): spawn the real `claude` via the production engine, drive ONE prompt turn,
// capture the produced JSONL transcript, then run the SAME four pure binary-drift checks (drift-checks.ts,
// Task 2) the OFFLINE detector (Task 3) uses — but against the LIVE output. It prints a per-surface
// PASS/FAIL table and `process.exit(1)` on ANY surface failing, so a binary bump that drifted a surface
// the bridge reads (stop_reason taxonomy, raw JSONL shape, SDK content-block coverage, allow keystroke)
// blocks the release. Resolving the path also logs the detected `claude` version + provenance drift
// (the Task-4 side effect) so the smoke surfaces the live version it ran against.
//
// LIVE MODE NEEDS: (a) the subscription `claude` binary on PATH, and (b) a CLEAN env — see the scrub
// below. Running this from inside a Claude Code session leaks CLAUDE_CODE_*/CLAUDECODE vars that make the
// spawned `claude` a NESTED session (writes NO live transcript → the pump/end-of-turn never fire and the
// turn never resolves). The script scrubs its OWN process.env of every CLAUDE_CODE*/CLAUDECODE* key at
// startup (the child inherits process.env via the engine's baseEnv default), but you should STILL prefer
// to run it from a shell where those are unset. Note the engine's buildSanitizedEnv only strips the four
// exact FORBIDDEN_BILLING_VARS (CLAUDECODE, CLAUDE_CODE_ENTRYPOINT, CLAUDE_AGENT_SDK_*) — it does NOT
// strip every CLAUDE_CODE_* prefix (e.g. CLAUDE_CODE_SESSION_ID), which is exactly why this script does.
//
// SELF-CHECK (offline negative control): `node experiments/smoke-live.mjs --self-check` spawns NO binary.
// It feeds each of the four checks one FORCED drift and asserts each returns ok:false — proving the
// FAIL→exit-1 machinery actually fires. Exit 0 ONLY if all four forced drifts were caught; else exit 1.
// This mode imports ONLY ../dist/drift-checks.js (no engine, no binary) so it runs deterministically in
// any environment — it is the offline proof for this experiment.
//
// USAGE:
//   node experiments/smoke-live.mjs               # live: spawn real claude, drive one turn, check JSONL
//   node experiments/smoke-live.mjs --self-check  # offline negative control (no binary) — proves FAIL→exit-1
//   node experiments/smoke-live.mjs --help        # this usage
//
// Reuse (imports from the BUILT ../dist/, like the other probes — run `npm run build` first):
//   resolveClaudePath ......................................... ../dist/claude-path.js
//   checkStopReasons / checkJsonlShape / checkContentBlockCoverage / checkAllowKeystroke ../dist/drift-checks.js
//   KEYSTROKE_YES ............................................. ../dist/permissions/allow-inject.js
//   defaultStartEngine ....................................... ../dist/acp-agent.js

import { readFileSync, globSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// --- env scrub (FIRST, before any import that might spawn) ---------------------------------------
// Strip every CLAUDE_CODE*/CLAUDECODE* key from THIS process so the child `claude` (which inherits
// process.env via the engine's baseEnv default) is not a nested session. Belt-and-suspenders over the
// engine's buildSanitizedEnv, which only deletes the four exact FORBIDDEN_BILLING_VARS.
const scrubbedEnvKeys = [];
for (const key of Object.keys(process.env)) {
  if (key.startsWith("CLAUDE_CODE") || key.startsWith("CLAUDECODE")) {
    delete process.env[key];
    scrubbedEnvKeys.push(key);
  }
}

// --- args ----------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const wantHelp = argv.includes("--help") || argv.includes("-h");
const selfCheck = argv.includes("--self-check");

const USAGE = `smoke-live.mjs — Story 049 LOCAL pre-release smoke test (R3.1, R3.2, R3.3)

  node experiments/smoke-live.mjs               live: spawn the real claude, drive one turn, run the
                                                four drift checks vs the LIVE JSONL; exit 1 on any FAIL
  node experiments/smoke-live.mjs --self-check  offline negative control (no binary): force one drift per
                                                surface, assert each is caught; exit 0 only if all caught
  node experiments/smoke-live.mjs --help        this message

  Live mode needs the subscription claude binary on PATH and a CLEAN env (no CLAUDE_CODE_*); the script
  scrubs its own env at startup. NOT in CI (C3) — not wired into test:run/test:fork.`;

// --- shared: pretty-print a per-surface verdict table --------------------------------------------
/** @param {Array<{surface:string, ok:boolean, detail:string}>} results */
function printTable(results) {
  const surfaceWidth = Math.max(7, ...results.map((r) => r.surface.length));
  const header = `${"SURFACE".padEnd(surfaceWidth)}  ${"STATUS".padEnd(6)}  DETAIL`;
  console.log(header);
  console.log("-".repeat(header.length));
  for (const r of results) {
    const status = r.ok ? "OK" : "FAIL";
    console.log(`${r.surface.padEnd(surfaceWidth)}  ${status.padEnd(6)}  ${r.detail}`);
  }
}

// --- content-block coverage helpers --------------------------------------------------------------
const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * The handled `switch (chunk.type)` cases of the LAST such switch in src/acp-agent.ts (the
 * toAcpNotifications dispatcher, the one guarded by `unreachable(chunk, …)`). Read from SOURCE so the
 * smoke checks live block types against the cases the source actually handles today (not a stale copy).
 * @returns {string[]} the `case "X":` labels of the dispatcher.
 */
function readHandledChunkCases() {
  const src = readFileSync(join(__dirname, "..", "src", "acp-agent.ts"), "utf8");
  // Anchor on the dispatcher that ends in `unreachable(chunk` — slice from the LAST `switch (chunk.type)`
  // BEFORE that marker, to the marker. This isolates the one exhaustive switch (there is an earlier
  // narrowing `switch (chunk.type)` that is NOT the dispatcher).
  const unreachableIdx = src.lastIndexOf("unreachable(chunk");
  if (unreachableIdx === -1) {
    throw new Error("smoke-live: could not find `unreachable(chunk` in src/acp-agent.ts");
  }
  const switchIdx = src.lastIndexOf("switch (chunk.type)", unreachableIdx);
  if (switchIdx === -1) {
    throw new Error("smoke-live: could not find `switch (chunk.type)` before `unreachable(chunk`");
  }
  const slice = src.slice(switchIdx, unreachableIdx);
  const cases = [];
  const re = /case\s+"([^"]+)":/g;
  let m;
  while ((m = re.exec(slice)) !== null) {
    if (!cases.includes(m[1])) cases.push(m[1]);
  }
  return cases;
}

/**
 * Extract the distinct `message.content[].type` block types present across the parsed live JSONL lines.
 * Each assistant/user message line carries `message.content` as an array of typed blocks.
 * @param {Array<Record<string, unknown>>} lines
 * @returns {string[]}
 */
function liveBlockTypes(lines) {
  const types = new Set();
  for (const line of lines) {
    const message = line && typeof line === "object" ? line.message : undefined;
    const content = message && typeof message === "object" ? message.content : undefined;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block && typeof block === "object" && typeof block.type === "string") {
        types.add(block.type);
      }
    }
  }
  return [...types];
}

// --- JSONL read ----------------------------------------------------------------------------------
/** Parse a transcript file into the array of non-empty JSON lines. @returns {Array<Record<string, unknown>>} */
function parseTranscript(filePath) {
  const raw = readFileSync(filePath, "utf8");
  const lines = [];
  for (const lineText of raw.split("\n")) {
    const trimmed = lineText.trim();
    if (trimmed.length === 0) continue;
    try {
      lines.push(JSON.parse(trimmed));
    } catch {
      // Skip an unparseable line rather than abort the whole smoke (a partial flush at read time).
    }
  }
  return lines;
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// =================================================================================================
// SELF-CHECK MODE — offline negative control (no binary, no engine; only ../dist/drift-checks.js)
// =================================================================================================
async function runSelfCheck() {
  const { checkStopReasons, checkJsonlShape, checkContentBlockCoverage, checkAllowKeystroke } =
    await import("../dist/drift-checks.js");

  // A single well-formed RAW JSONL line — the baseline each forced-drift case mutates one facet of.
  const goodLine = {
    uuid: "u1",
    type: "assistant",
    timestamp: "2026-06-23T00:00:00.000Z",
    sessionId: "s1",
    message: { stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] },
  };

  // Each forced-drift case crafts one input with exactly ONE injected drift on its surface; the check
  // MUST return ok:false. (A check returning ok:true here would mean the FAIL machinery is broken.)
  const cases = [
    {
      surface: "stop_reason",
      run: () =>
        // Forced: an unmapped, NEW terminal stop_reason ("pause_turn") — not handled, not known-non-terminal.
        checkStopReasons([
          { ...goodLine, message: { ...goodLine.message, stop_reason: "pause_turn" } },
        ]),
    },
    {
      surface: "jsonl_shape",
      run: () =>
        // Forced: a NEW/unexpected top-level key on an otherwise-valid raw line.
        checkJsonlShape([{ ...goodLine, brandNewField: "drift" }]),
    },
    {
      surface: "content_block",
      run: () =>
        // Forced: a live block type absent from a tiny handled set → uncovered drift.
        checkContentBlockCoverage(["text", "some_new_block"], ["text"]),
    },
    {
      surface: "allow_keystroke",
      run: () =>
        // Forced: the wrong keystroke (deny "2\r" instead of the canonical allow "1\r").
        checkAllowKeystroke("2\r"),
    },
  ];

  const results = cases.map(({ surface, run }) => {
    const r = run();
    // detail reports whether THIS negative-control surface correctly flagged drift (ok:false === caught).
    return {
      surface,
      ok: r.ok === false, // table "OK" means "drift correctly caught"
      detail:
        r.ok === false
          ? `drift caught — ${r.detail}`
          : `NOT CAUGHT (check returned ok:true): ${r.detail}`,
    };
  });

  console.log(
    "SELF-CHECK: negative control — each surface is fed one forced drift; it must be flagged.\n",
  );
  printTable(results);

  const allDetected = results.every((r) => r.ok);
  console.log("");
  if (allDetected) {
    console.log("SELF-CHECK: negative control — all four surfaces correctly flagged drift.");
  } else {
    const missed = results
      .filter((r) => !r.ok)
      .map((r) => r.surface)
      .join(", ");
    console.error(`SELF-CHECK FAILED: these surfaces did NOT flag the forced drift: ${missed}`);
  }
  // INVERTED for the harness: exit 0 ONLY if every forced drift was caught.
  process.exit(allDetected ? 0 : 1);
}

// =================================================================================================
// LIVE MODE — spawn the real claude, drive one turn, run the four checks vs the produced JSONL
// =================================================================================================
async function runLive() {
  if (scrubbedEnvKeys.length > 0) {
    console.error(
      `[smoke-live] scrubbed ${scrubbedEnvKeys.length} CLAUDE_CODE*/CLAUDECODE* env key(s) so the ` +
        `spawned claude is not nested: ${scrubbedEnvKeys.join(", ")}`,
    );
  }

  const { resolveClaudePath } = await import("../dist/claude-path.js");
  const { defaultStartEngine } = await import("../dist/acp-agent.js");
  const { KEYSTROKE_YES } = await import("../dist/permissions/allow-inject.js");

  // 1. Resolve the binary — ALSO logs the detected version + provenance drift (desirable here: surface it).
  let claudePath;
  try {
    claudePath = resolveClaudePath();
    console.error(`[smoke-live] using claude at ${claudePath}`);
  } catch (err) {
    console.error(
      `[smoke-live] FATAL: could not resolve the claude binary — ${err?.message ?? err}`,
    );
    console.error(
      "[smoke-live] live mode needs the subscription `claude` on PATH. Run --self-check for the offline proof.",
    );
    process.exit(1);
    return;
  }

  // HOME-based cwd: claude writes its JSONL transcript LIVE here (a /tmp cwd does NOT — probe-c finding).
  const SESSION_CWD = join(homedir(), "Desktop", "smoke-live-049");
  const { mkdirSync, rmSync } = await import("node:fs");
  rmSync(SESSION_CWD, { recursive: true, force: true });
  mkdirSync(SESSION_CWD, { recursive: true });

  // `~/.claude/projects/**​/<sessionId>.jsonl` — basename == sessionId (cwd-encoding-independent).
  const transcriptGlob = (sessionId) =>
    join(homedir(), ".claude", "projects", "**", `${sessionId}.jsonl`);

  const BOOT_SETTLE_MS = 3000; // let the TUI boot (it writes NO transcript at boot)
  const SUBMIT_DELAY_MS = 60; // text, then a delayed \r submits it (§5 Input)
  const ARM_TIMEOUT_MS = 90_000; // bounded wait for the deferred discovery to arm after the interaction
  const TURN_SETTLE_MS = 8000; // after onEvent, let the assistant end_turn line be written to the JSONL

  // onEvent resolves the moment the deferred background discovery arms the watcher and fires the pump.
  let resolveArmed;
  const armed = new Promise((res) => {
    resolveArmed = res;
  });

  let started;
  try {
    started = await defaultStartEngine({
      cwd: SESSION_CWD,
      onEvent: () => resolveArmed(),
      // baseEnv defaults to process.env (already scrubbed above) → the spawn's buildSanitizedEnv runs on it.
    });
  } catch (err) {
    console.error(`[smoke-live] FATAL: defaultStartEngine failed — ${err?.message ?? err}`);
    process.exit(1);
    return;
  }

  started.pty.onExit(() => {
    /* the TUI may exit after we kill it; nothing to do here */
  });

  let exitCode = 1; // default to FAIL — only a fully-passing run flips it to 0
  try {
    if (!started.sessionId) {
      throw new Error("defaultStartEngine returned without a sessionId");
    }
    console.error(`[smoke-live] session ${started.sessionId} — driving one prompt turn…`);

    // Let the TUI settle, then type a tiny prompt and submit it with a delayed \r.
    await delay(BOOT_SETTLE_MS);
    started.pty.write("Reply with exactly: ok");
    setTimeout(() => started.pty.write("\r"), SUBMIT_DELAY_MS);

    // Bounded wait for the deferred discovery to arm the watcher (fire onEvent). A clearable timer so a
    // fast pass cancels the timeout instead of keeping the process alive for the full window.
    let armTimer;
    const armedInTime = await Promise.race([
      armed.then(() => true),
      new Promise((res) => {
        armTimer = setTimeout(() => res(false), ARM_TIMEOUT_MS);
      }),
    ]);
    if (armTimer) clearTimeout(armTimer);
    if (!armedInTime) {
      throw new Error(
        `the transcript discovery did not arm within ${ARM_TIMEOUT_MS}ms — the spawned claude likely ` +
          `wrote no live transcript (nested session? run from a shell with CLAUDE_CODE_* unset).`,
      );
    }

    // Let the assistant's end_turn line land in the JSONL before we read it.
    await delay(TURN_SETTLE_MS);

    const matches = globSync(transcriptGlob(started.sessionId));
    if (matches.length !== 1) {
      throw new Error(
        `expected exactly one transcript for ${started.sessionId}, found ${matches.length}: ${matches.join(", ")}`,
      );
    }
    const transcriptPath = matches[0];
    console.error(
      `[smoke-live] transcript: ${transcriptPath} (basename ${basename(transcriptPath)})`,
    );

    const liveLines = parseTranscript(transcriptPath);
    if (liveLines.length === 0) {
      throw new Error(`the transcript ${transcriptPath} parsed to ZERO JSONL lines`);
    }
    console.error(`[smoke-live] parsed ${liveLines.length} JSONL line(s)`);

    // 2. Run the four pure drift checks against the LIVE output.
    const { checkStopReasons, checkJsonlShape, checkContentBlockCoverage, checkAllowKeystroke } =
      await import("../dist/drift-checks.js");

    const handledCases = readHandledChunkCases();
    const blockTypes = liveBlockTypes(liveLines);
    console.error(`[smoke-live] live content-block types: [${blockTypes.join(", ")}]`);
    console.error(`[smoke-live] handled switch cases: ${handledCases.length}`);

    const results = [
      checkStopReasons(liveLines),
      checkJsonlShape(liveLines),
      checkContentBlockCoverage(blockTypes, handledCases),
      checkAllowKeystroke(KEYSTROKE_YES),
    ];

    console.log("");
    console.log(
      `SMOKE-LIVE: drift checks vs the live ${basename(transcriptPath)} (${liveLines.length} lines)\n`,
    );
    printTable(results);

    const anyFail = results.some((r) => !r.ok);
    console.log("");
    if (anyFail) {
      const failed = results
        .filter((r) => !r.ok)
        .map((r) => r.surface)
        .join(", ");
      console.error(
        `SMOKE-LIVE: FAIL — binary drift on: ${failed}. Do NOT release until reconciled.`,
      );
      exitCode = 1;
    } else {
      console.log(
        "SMOKE-LIVE: PASS — all four surfaces match the bridge's expectations against the live binary.",
      );
      exitCode = 0;
    }
  } catch (err) {
    console.error(`[smoke-live] ERROR: ${err?.message ?? err}`);
    exitCode = 1;
  } finally {
    // ALWAYS tear down the engine + PTY.
    try {
      started.engine?.cleanup();
    } catch {
      /* best-effort */
    }
    try {
      started.pty.kill();
    } catch {
      /* already gone */
    }
  }

  process.exit(exitCode);
}

// --- main ----------------------------------------------------------------------------------------
async function main() {
  if (wantHelp) {
    console.log(USAGE);
    process.exit(0);
  }
  if (selfCheck) {
    await runSelfCheck();
    return;
  }
  await runLive();
}

main().catch((err) => {
  // Last-resort guard: never leave an unhandled rejection — surface it and fail.
  console.error(`[smoke-live] UNHANDLED: ${err?.stack ?? err}`);
  process.exit(1);
});
