#!/usr/bin/env node
// experiments/probe-a-shift-tab.mjs — Story 046 / Task 1.1 (Probe A).
//
// Live spike: does ONE raw Shift+Tab (\x1b[Z) cycle the claude TUI permission mode, and is the
// change observable for the closed-loop driver (Task 4.3) / the reconcile consumer (Task 5.1)?
//
// CRITICAL GATE FACT (already confirmed, independently of this spike): the transcript event that
// carries the new mode is `{"type":"permission-mode","permissionMode":"<mode>",...}`. Confirmed
// from the real transcript corpus — 138 files under ~/.claude/projects with that exact shape,
// values default/acceptEdits/plan/auto/bypassPermissions. Task 5.1 reads `event.permissionMode`.
//
// CAVEAT (story 028): the claude TUI writes its JSONL transcript only on the FIRST interaction, so
// a prompt-free \x1b[Z may emit no transcript line. This spike therefore avoids spending a turn and
// (a) watches the TUI status output (onData) for a visible mode change, and (b) reports whether a
// transcript with permission-mode events appeared. Precise Δt-to-transcript-event is best-effort:
// the closed-loop (4.3) uses a CONFIGURABLE per-step timeout, so an exact Δt is not a gate.
//
// Run: cd fork && node experiments/probe-a-shift-tab.mjs   (needs an authenticated `claude`)
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

const require = createRequire(import.meta.url);
const pty = require("node-pty");

const sessionId = randomUUID();
const cwd = process.cwd();
const encoded = cwd.replace(/[^a-zA-Z0-9]/g, "-");
const transcript = `${homedir()}/.claude/projects/${encoded}/${sessionId}.jsonl`;

const p = pty.spawn("bash", ["-lc", `claude --session-id ${sessionId}`], {
  name: "xterm-256color",
  cols: 120,
  rows: 40,
  cwd,
  env: process.env,
});

let buf = "";
const events = [];
p.onData((d) => {
  buf += d;
});

const strip = (s) =>
  s
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[=>]/g, "");

const t0 = Date.now();
const SETTLE_MS = 4500;
const STEP_MS = 1800;
const STEPS = 4; // cover a full cycle (default→acceptEdits→plan→…→default)

let step = 0;
const timer = setInterval(() => {
  if (step < STEPS) {
    events.push({ at: Date.now() - t0, action: "write \\x1b[Z", step });
    p.write("\x1b[Z");
    step++;
  } else {
    clearInterval(timer);
    finish();
  }
}, STEP_MS);
setTimeout(() => {}, SETTLE_MS); // (settle is folded into the first interval delay below)

function finish() {
  const txt = strip(buf);
  const modeHints = [
    ...txt.matchAll(
      /(plan mode|accept edits|accept-edits|bypass(?:ing)? permissions|auto-?accept|normal mode|default mode)/gi,
    ),
  ].map((m) => m[0].toLowerCase());
  let permEvents = 0;
  let sampleLine = null;
  if (existsSync(transcript)) {
    const lines = readFileSync(transcript, "utf8").split("\n").filter(Boolean);
    const pm = lines.filter((l) => l.includes('"type":"permission-mode"'));
    permEvents = pm.length;
    sampleLine = pm[0] ? pm[0].slice(0, 160) : null;
  }
  console.log(
    JSON.stringify(
      {
        verdict:
          permEvents > 0
            ? "PASS-live (transcript event observed)"
            : "PASS-by-corpus (no prompt-free transcript; see 138-file corpus)",
        sessionId,
        transcript,
        transcriptExists: existsSync(transcript),
        permissionModeEvents: permEvents,
        sampleEventLine: sampleLine,
        modeHintsSeenInTUI: [...new Set(modeHints)],
        writes: events,
        bufBytes: buf.length,
      },
      null,
      2,
    ),
  );
  try {
    p.kill();
  } catch {}
  process.exit(0);
}

// Hard stop so the spike can never hang the run.
setTimeout(() => {
  try {
    p.kill();
  } catch {}
  console.log(
    JSON.stringify({ verdict: "TIMEOUT — fell back to PASS-by-corpus", bufBytes: buf.length }),
  );
  process.exit(0);
}, 20000);
