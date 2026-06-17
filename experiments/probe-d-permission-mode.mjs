#!/usr/bin/env node
// experiments/probe-d-permission-mode.mjs — Story 046 follow-up (permission-mode gap).
//
// FINDING under test: the live permission-mode selector has no effect because the fork's billing/
// permission gate (a PreToolUse type:http hook, story 032/033) intercepts EVERY tool call and forwards
// the decision to Zed via requestPermission (gate-wiring.ts:276 decide()), NEVER consulting the selected
// mode — even though claude's hook payload carries `permission_mode` (hook-server.ts:129). So changing
// the mode re-spawns claude with --permission-mode but the gate still asks Zed → the user always sees a
// prompt, in every mode (incl. bypassPermissions).
//
// To FIX (make the decider honor the mode: bypass→allow-all, acceptEdits→allow-edits, default→ask), the
// decider needs a reliable `permission_mode` per call. This probe confirms, headless, with a stand-in
// PreToolUse hook (type:command, logs the payload + returns allow so it never hangs):
//   (1) the PreToolUse hook FIRES for a file-write tool in each mode — including bypassPermissions;
//   (2) the payload's `permission_mode` field reflects the spawned mode (default/acceptEdits/bypass).
//
// Run: cd fork && node experiments/probe-d-permission-mode.mjs   (needs an authenticated `claude`)
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, statSync } from "node:fs";

const require = createRequire(import.meta.url);
const pty = require("node-pty");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (s) =>
  s.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b[()][0-9A-B]/g, "").replace(/\x1b[=>]/g, "");

const TMP = "/tmp/probe-d-permmode";
mkdirSync(TMP, { recursive: true });
const LOG = `${TMP}/hook.log`;
const HOOK = `${TMP}/hook.sh`;
const SETTINGS = `${TMP}/settings.json`;

// Stand-in PreToolUse hook: append the raw payload to LOG, then RETURN allow so claude proceeds without a
// TUI prompt (the probe never hangs). This mirrors what the fork's hook receives — same claude payload.
writeFileSync(HOOK, `#!/bin/bash\npayload=$(cat)\nprintf '%s\\n' "$payload" >> "${LOG}"\nprintf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"probe-d"}}'\nexit 0\n`);
chmodSync(HOOK, 0o755);
writeFileSync(SETTINGS, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "", hooks: [{ type: "command", command: HOOK }] }] } }, null, 2));
writeFileSync(LOG, "");

function logSize() {
  try { return statSync(LOG).size; } catch { return 0; }
}
function newLogSince(offset) {
  if (!existsSync(LOG)) return "";
  const buf = readFileSync(LOG, "utf8");
  return buf.slice(offset);
}
function permModesIn(text) {
  return [...text.matchAll(/"permission_mode"\s*:\s*"([^"]*)"/g)].map((m) => m[1]);
}
function toolNamesIn(text) {
  return [...text.matchAll(/"tool_name"\s*:\s*"([^"]*)"/g)].map((m) => m[1]);
}

async function runMode(mode, idx) {
  const sid = randomUUID();
  const file = `deleteme-${mode}.txt`;
  const flag = mode === "default" ? "" : `--permission-mode ${mode}`;
  const cmd = `claude --session-id ${sid} ${flag} --settings "${SETTINGS}"`.replace(/\s+/g, " ").trim();
  const offset = logSize();
  const p = pty.spawn("bash", ["-lc", cmd], { name: "xterm-256color", cols: 120, rows: 40, cwd: TMP, env: process.env });
  let buf = "";
  p.onData((d) => { buf += d; });
  const r = { mode, flagPassed: flag || "(none — default)", hookFired: false, payloadPermissionMode: null, toolNames: [], fileCreated: false, tuiPrompted: null };
  try {
    // wait for the TUI to be ready
    for (let i = 0; i < 40 && !/for shortcuts/i.test(strip(buf)); i++) await delay(300);
    // ask for a file write (triggers the Write tool → PreToolUse hook)
    p.write("\x15"); await delay(60);
    p.write(`crie um arquivo chamado ${file} com exatamente o texto: oi`); await delay(60);
    p.write("\r");
    // wait for the hook to fire (LOG grows with a permission_mode) OR the file to appear, up to 30s
    for (let i = 0; i < 60; i++) {
      const fresh = newLogSince(offset);
      const pm = permModesIn(fresh);
      if (pm.length) { r.hookFired = true; r.payloadPermissionMode = pm[pm.length - 1]; r.toolNames = [...new Set(toolNamesIn(fresh))]; break; }
      if (existsSync(`${TMP}/${file}`)) { r.fileCreated = true; }
      await delay(500);
    }
    r.fileCreated = existsSync(`${TMP}/${file}`);
    // did the TUI show a native permission prompt? (it should NOT, since the hook returned allow)
    r.tuiPrompted = /Do you want to proceed|❯ 1\. Yes|allow this|permission/i.test(strip(buf));
  } finally {
    try { p.kill(); } catch {}
  }
  return r;
}

const hardStop = setTimeout(() => { console.log(JSON.stringify({ verdict: "GLOBAL-TIMEOUT" })); process.exit(2); }, 300000);
const results = [];
const MODES = ["default", "acceptEdits", "bypassPermissions"];
for (let i = 0; i < MODES.length; i++) results.push(await runMode(MODES[i], i));
clearTimeout(hardStop);

const allFired = results.every((r) => r.hookFired);
const modeMatches = results.every((r) => r.mode === "default" ? true : r.payloadPermissionMode === r.mode);
let interpretation;
if (allFired && modeMatches)
  interpretation = "CONFIRMED: the PreToolUse hook fires in EVERY mode (incl. bypass) and the payload's permission_mode matches the spawned mode → the decider can branch on call.permissionMode to honor the selector.";
else if (allFired && !modeMatches)
  interpretation = "Hook fires in all modes but permission_mode in the payload does NOT match — branch on session.modes.currentModeId instead of the payload.";
else
  interpretation = "Hook did NOT fire in some mode — inspect per-mode hookFired (if bypass skips the hook, the fix differs).";

console.log(JSON.stringify({ probe: "D — permission-mode hook payload", hookLog: LOG, results, interpretation }, null, 2));
process.exit(0);
