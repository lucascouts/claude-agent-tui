#!/usr/bin/env node
// experiments/probe-c-model-then-prompt.mjs — Story 046 follow-up (hang investigation).
//
// QUESTION: after a `/model <alias>` side-channel injection, does the NEXT prompt produce a turn,
// or does it hang? Live symptom (session 39a93bfc): the prompt after a /model switch produced ZERO
// transcript events → the fork's 120 s silence watchdog tripped.
//
// The fork's static state machine is provably clean after an idle /model (verified offline). The ONLY
// code-level differential exclusive to the /model path is the SYNCHRONOUS injection `(fn)=>fn()` in
// injectModelCommand (acp-agent.ts:1521): it emits \x15 + "/model <alias>" + \r back-to-back with NO
// 60 ms gaps, whereas the normal prompt path (which works) uses the timed schedule. Two arms isolate it:
//   ARM "sync"  — inject /model as prod does TODAY (synchronous), then a normal (timed) prompt.
//   ARM "timed" — inject /model with the SAME 60 ms timing as a normal prompt (the proposed fix).
//
// DETECTION: headless claude in a /tmp cwd does NOT flush a JSONL transcript live (observed), so we
// read the TUI itself (onData), NOT the transcript:
//   turn STARTED  → the buffer shows the working spinner ("esc to interrupt" / token counter).
//   turn DONE     → the idle input footer ("? for shortcuts") returns.
//   HANG          → no "started" signal within STARTED_TIMEOUT = the prompt was eaten (the bug).
//
// OUTCOMES: sync=HANG & timed=OK → sync injection is the cause, timing fix works.
//           sync=HANG & timed=HANG → not the timing; /model itself breaks the next prompt.
//           sync=OK & timed=OK → not reproducible headless → Zed-specific; needs in-Zed repro.
//
// SIDE EFFECT: `/model <alias>` saves the choice as the GLOBAL default. We read the original model from
// the boot banner and restore it at the end of each arm (best-effort), printing the final state.
//
// Run: cd fork && node experiments/probe-c-model-then-prompt.mjs   (needs an authenticated `claude`)
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";

const require = createRequire(import.meta.url);
const pty = require("node-pty");

const CLEAR_INPUT_KEY = "\x15";
const CLEAR_INPUT_DELAY_MS = 60;
const SUBMISSION_DELAY_MS = 60;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function sendTimed(p, text) {
  const payload = text.includes("\n") ? `\x1b[200~${text}\x1b[201~` : text;
  p.write(CLEAR_INPUT_KEY);
  await delay(CLEAR_INPUT_DELAY_MS);
  p.write(payload);
  await delay(SUBMISSION_DELAY_MS);
  p.write("\r");
}
function sendSync(p, text) {
  const payload = text.includes("\n") ? `\x1b[200~${text}\x1b[201~` : text;
  p.write(CLEAR_INPUT_KEY);
  p.write(payload); // schedule = (fn)=>fn() → same tick, no 60 ms (prod's injectModelCommand)
  p.write("\r");
}

const strip = (s) =>
  s
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[()][0-9A-B]/g, "")
    .replace(/\x1b[=>]/g, "");

const RE_WORKING = /esc to interrupt|to interrupt|↓\s*\d+\s*tokens|tokens\)|Brewed for|Coalescing|Beboppin|Bopping|Brewing/i;
const RE_IDLE = /for shortcuts/i;
const RE_MODELSET = /Set model to/i;
const RE_BANNER_MODEL = /(Opus|Sonnet|Haiku)\s*[\d.]/i;

async function poll(getSlice, re, timeoutMs, stepMs = 400) {
  const t0 = Date.now();
  for (;;) {
    if (re.test(strip(getSlice()))) return { ok: true, ms: Date.now() - t0 };
    if (Date.now() - t0 > timeoutMs) return { ok: false, ms: Date.now() - t0 };
    await delay(stepMs);
  }
}

const READY_TIMEOUT = 15000;
const STARTED_TIMEOUT = 14000; // a real submission shows the spinner well within this; eaten input never does
const DONE_TIMEOUT = 45000;
const MODEL_TIMEOUT = 8000;

async function detectTurn(p, getBufLen, getSlice, sendFn, label) {
  const mark = getBufLen();
  const sliceSince = () => getSlice(mark);
  await sendFn();
  const started = await poll(sliceSince, RE_WORKING, STARTED_TIMEOUT);
  if (!started.ok) return { label, started: false, done: false, note: `no working-spinner in ${started.ms}ms → input eaten (HANG)` };
  const done = await poll(sliceSince, RE_IDLE, DONE_TIMEOUT);
  return { label, started: true, done: done.ok, note: done.ok ? `started+done in ${done.ms}ms` : `started but no idle-footer in ${done.ms}ms` };
}

async function runArm(injectMode, cwd) {
  const sessionId = randomUUID();
  const p = pty.spawn("bash", ["-lc", `claude --session-id ${sessionId}`], {
    name: "xterm-256color", cols: 120, rows: 40, cwd, env: process.env,
  });
  let buf = "";
  p.onData((d) => { buf += d; });
  const getLen = () => buf.length;
  const sliceFrom = (m = 0) => buf.slice(m);

  const r = { arm: injectMode, sessionId, originalAlias: null, testAlias: null, turn1: null, modelApplied: null, turn2: null, verdict: null, restoredTo: null };
  try {
    const ready = await poll(() => sliceFrom(0), RE_IDLE, READY_TIMEOUT);
    if (!ready.ok) { r.verdict = `VOID (TUI never reached idle footer in ${ready.ms}ms)`; return r; }

    const bm = strip(buf).match(RE_BANNER_MODEL);
    r.originalAlias = bm ? bm[1].toLowerCase() : "opus";
    r.testAlias = r.originalAlias === "haiku" ? "sonnet" : "haiku";

    // (1) baseline turn — must submit + complete, else the arm is void
    const t1 = await detectTurn(p, getLen, sliceFrom, () => sendTimed(p, "responda apenas com a palavra: pronto"), "turn1");
    r.turn1 = t1.note;
    if (!t1.started) { r.verdict = "VOID (baseline turn1 input eaten — harness issue, not the bug)"; return r; }

    // (2) inject /model (sync = prod today / timed = proposed fix)
    const mm = getLen();
    if (injectMode === "sync") sendSync(p, `/model ${r.testAlias}`);
    else await sendTimed(p, `/model ${r.testAlias}`);
    const ma = await poll(() => sliceFrom(mm), RE_MODELSET, MODEL_TIMEOUT);
    r.modelApplied = ma.ok ? `applied in ${ma.ms}ms` : `no 'Set model to' in ${ma.ms}ms`;

    // (3) THE TEST: a normal (timed) prompt AFTER /model
    const t2 = await detectTurn(p, getLen, sliceFrom, () => sendTimed(p, "responda apenas com a palavra: dois"), "turn2");
    r.turn2 = t2.note;
    r.verdict = !t2.started ? "HANG" : t2.done ? "OK" : "RAN-NO-FINISH";

    // (4) restore original default model (best-effort)
    const rm = getLen();
    await sendTimed(p, `/model ${r.originalAlias}`);
    const rr = await poll(() => sliceFrom(rm), RE_MODELSET, MODEL_TIMEOUT);
    r.restoredTo = rr.ok ? r.originalAlias : `attempted ${r.originalAlias} (unconfirmed — may need manual /model)`;
  } finally {
    try { p.kill(); } catch {}
  }
  return r;
}

const cwd = "/tmp/probe-c-model-hang";
mkdirSync(cwd, { recursive: true });
const hardStop = setTimeout(() => { console.log(JSON.stringify({ verdict: "GLOBAL-TIMEOUT" })); process.exit(2); }, 360000);

const sync = await runArm("sync", cwd);
const timed = await runArm("timed", cwd);
clearTimeout(hardStop);

let interpretation;
if (sync.verdict === "HANG" && timed.verdict === "OK") interpretation = "CONFIRMED: synchronous injection is the cause; the timed-injection fix works.";
else if (sync.verdict === "HANG" && timed.verdict === "HANG") interpretation = "NOT the timing: /model itself breaks the next prompt — needs transcript-fence / Esc-dismiss / version handling.";
else if (sync.verdict === "OK" && timed.verdict === "OK") interpretation = "Not reproducible headless — the hang is Zed-specific; needs an in-Zed instrumented repro.";
else interpretation = `Inconclusive (sync=${sync.verdict}, timed=${timed.verdict}) — check VOID/RAN-NO-FINISH and re-run.`;

console.log(JSON.stringify({
  probe: "C — /model-then-prompt hang (TUI-detected)",
  arms: { sync, timed },
  interpretation,
  configNote: `final default model left ≈ '${timed.restoredTo ?? sync.restoredTo ?? "unknown"}'. If unconfirmed, run /model <your-model> once.`,
}, null, 2));
process.exit(0);
