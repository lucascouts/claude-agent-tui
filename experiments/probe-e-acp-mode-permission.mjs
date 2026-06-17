#!/usr/bin/env node
// experiments/probe-e-acp-mode-permission.mjs — Story 046 follow-up (live ACP harness).
//
// THE "PLAYWRIGHT FOR THE FORK": drives the BUILT fork over the REAL ACP stdio transport exactly as
// Zed does — spawns `node dist/index.js`, connects with the SDK's ClientSideConnection, and sends
// initialize → newSession → set_config_option(configId:"mode") → prompt, while implementing the
// CLIENT's requestPermission so it can COUNT how many times the gate asks per mode. The fork spawns
// the REAL claude internally (this costs tokens + needs an authenticated claude).
//
// It verifies the WHOLE permission-mode chain end-to-end, automatically, with NO GUI:
//   - Bug A fix: set_config_option(configId:"mode") now DRIVES claude (was a read-only no-op).
//   - Gate fix:  the decider honors the live mode (bypass→allow-all, acceptEdits→allow-edits).
//
// DECISIVE SIGNAL — `bypassPermissions`:
//   FIXED → permissionRequests === 0 AND the file is created (claude's mode changed + gate auto-allowed).
//   BROKEN (pre-fix) → the gate asks (permissionRequests > 0) because the mode never reached claude.
//
// Run: cd fork && npm run build && node experiments/probe-e-acp-mode-permission.mjs
import { spawn } from "node:child_process";
import { mkdirSync, existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { ClientSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { nodeToWebReadable, nodeToWebWritable } from "../dist/utils.js";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
// HOME-based cwd: claude writes its JSONL transcript LIVE here (a /tmp cwd does NOT — probe-c finding),
// and the fork's pump + gate correlation + end-of-turn detector all depend on that live transcript.
const SESSION_CWD = `${homedir()}/Desktop/probe-e-acp`;
rmSync(SESSION_CWD, { recursive: true, force: true });
mkdirSync(SESSION_CWD, { recursive: true });

function withTimeout(p, ms, label) {
  let t;
  const to = new Promise(
    (_, rej) => (t = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)),
  );
  return Promise.race([p, to]).finally(() => clearTimeout(t));
}

// --- spawn the built fork with a CLEAN env (allow-list). CRITICAL: this harness runs inside Claude
// Code, whose env (CLAUDECODE, CLAUDE_CODE_SESSION_ID, CLAUDE_CODE_CHILD_SESSION, …) would otherwise
// leak to the spawned claude and make it behave as a NESTED session (no live transcript → the fork's
// pump/end-of-turn/gate never fire). The fork strips only the 4 billing vars; we strip everything
// Claude/Anthropic here, keeping just what a fresh terminal needs (incl. HOME for ~/.claude auth).
const CLEAN_ENV = {};
for (const k of [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  "SHELL",
  "TMPDIR",
  "XDG_RUNTIME_DIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "WAYLAND_DISPLAY",
  "DISPLAY",
]) {
  if (process.env[k] !== undefined) CLEAN_ENV[k] = process.env[k];
}
const child = spawn(process.execPath, ["dist/index.js"], {
  cwd: process.cwd(),
  stdio: ["pipe", "pipe", "pipe"],
  env: CLEAN_ENV, // FORK_GATE unset → gate ON (default); no CLAUDE_CODE_* leakage
});
let stderr = "";
child.stderr.on("data", (d) => (stderr += d.toString()));

let permissionRequests = [];
const sessionUpdates = [];
const toolNameOf = (params) => {
  const tc = params?.toolCall ?? {};
  return tc.title || tc.kind || tc.toolCallId || JSON.stringify(tc).slice(0, 40);
};
const client = {
  async sessionUpdate(params) {
    sessionUpdates.push(params);
  },
  async requestPermission(params) {
    permissionRequests.push(params);
    return { outcome: { outcome: "selected", optionId: "allow" } }; // approve so the turn completes
  },
  async readTextFile() {
    return { content: "" };
  },
  async writeTextFile() {
    return {};
  },
};

const stream = ndJsonStream(nodeToWebWritable(child.stdin), nodeToWebReadable(child.stdout));
const agent = new ClientSideConnection(() => client, stream);

// Pull tool_call events out of the captured session/update notifications (status = the outcome).
function toolsSince(startIdx) {
  const out = [];
  for (const p of sessionUpdates.slice(startIdx)) {
    const u = p?.update ?? p;
    if (u?.sessionUpdate === "tool_call" || u?.sessionUpdate === "tool_call_update") {
      out.push({ name: u.title || u.kind || u.toolCallId, status: u.status });
    }
  }
  return out;
}

const results = [];
try {
  await withTimeout(
    agent.initialize({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    }),
    15000,
    "initialize",
  );
  const ns = await withTimeout(
    agent.newSession({ cwd: SESSION_CWD, mcpServers: [] }),
    20000,
    "newSession",
  );
  const sessionId = ns.sessionId;
  await delay(6000); // let the freshly-spawned claude TUI settle (first turn needs it ready)

  // Warm-up: a no-tool prompt materialises the transcript + proves the turn loop completes at all.
  const warm = await withTimeout(
    agent.prompt({ sessionId, prompt: [{ type: "text", text: "responda apenas: pronto" }] }),
    60000,
    "warmup",
  ).catch((e) => ({ error: String(e.message || e) }));
  results.push({
    mode: "(warmup)",
    stopReason: warm?.stopReason ?? null,
    error: warm?.error ?? null,
  });

  for (const mode of ["default", "acceptEdits", "bypassPermissions"]) {
    try {
      await withTimeout(
        agent.setSessionConfigOption({ sessionId, configId: "mode", value: mode }),
        30000,
        `set_mode(${mode})`,
      );
    } catch (e) {
      results.push({ mode, setModeError: String(e.message || e) });
      continue;
    }
    await delay(3000); // settle (re-spawn for bypass/dontAsk)

    permissionRequests = [];
    const startIdx = sessionUpdates.length;
    const stderrMark = stderr.length;
    const file = `del-${mode}.txt`;
    let stopReason = null,
      error = null;
    try {
      // Write-only prompt: bypass/acceptEdits should auto-allow (0 prompts); default should ask. (Bash
      // is omitted — it hits the separate gate-correlation Bug B, which would mask the mode signal.)
      const res = await withTimeout(
        agent.prompt({
          sessionId,
          prompt: [
            {
              type: "text",
              text: `Crie o arquivo ${file} com o conteúdo exato: oi (apenas o arquivo, nada mais).`,
            },
          ],
        }),
        70000,
        `prompt(${mode})`,
      );
      stopReason = res?.stopReason ?? null;
    } catch (e) {
      error = String(e.message || e);
      try {
        await agent.cancel({ sessionId });
      } catch {
        /* SDK may lack cancel; the watchdog settles it */
      }
      await delay(3000); // let the cancelled turn settle so the next set_config_option finds idle
    }

    results.push({
      mode,
      stopReason,
      error,
      permissionRequests: permissionRequests.length,
      permissionTools: permissionRequests.map(toolNameOf),
      tools: toolsSince(startIdx),
      fileCreated: existsSync(`${SESSION_CWD}/${file}`),
      gateLog: (stderr.slice(stderrMark).match(/\[gate §9\][^\n]*/g) || []).slice(0, 4),
    });
  }
} catch (e) {
  results.push({ fatal: String(e.message || e), stderrTail: stderr.slice(-600) });
} finally {
  try {
    child.kill();
  } catch {}
}

const bypass = results.find((r) => r.mode === "bypassPermissions");
const verdict =
  bypass && bypass.permissionRequests === 0 && bypass.fileCreated
    ? "FIXED: bypassPermissions reached claude AND the gate auto-allowed (0 prompts, file created)."
    : bypass
      ? `STILL BROKEN: bypass asked ${bypass.permissionRequests}x / fileCreated=${bypass.fileCreated} — the mode did not take effect.`
      : "INCONCLUSIVE — see results/fatal.";

console.log(
  JSON.stringify({ probe: "E — ACP-wire mode/permission (live)", verdict, results }, null, 2),
);
process.exit(0);
