#!/usr/bin/env node
// experiments/probe-f-boot-mode-respawn.mjs — Story 046 (R3.4 LIVE FIX) live ACP harness.
//
// REPRODUCES THE BOOT-BYPASS STALL that probe-e MISSES. probe-e sends a warm-up prompt first (which
// materialises the transcript) and only THEN switches mode — so its re-spawn always has a transcript
// to --resume. The LIVE bug (Zed.log 2026-06-17) is the opposite ORDER: a `default_config_options.mode
// = bypassPermissions` makes Zed send set_config_option(configId:"mode") at BOOT, BEFORE the first
// interaction. The re-spawn's `claude --resume <id>` then has no transcript, falls back (buildResumeArgv
// `|| claude`) to a NEW untracked id, and the next turn stalls until the 120s turn watchdog.
//
// THIS PROBE drives the BUILT fork over the real ACP stdio transport (like Zed): initialize →
// newSession → set_config_option(mode:bypassPermissions) IMMEDIATELY (no warm-up) → prompt.
//
// DECISIVE SIGNALS:
//   - PRE-FIX (broken): the set_config_option throws "Transcript not found ... 2000ms" OR resolves but
//     the following prompt STALLS (turn watchdog) — and the live fresh PTY was killed.
//   - WITH THE GUARD (this fix): the set_config_option is REFUSED with "before the first interaction"
//     (the fork stays on the fresh spawn's mode, PTY intact) — NO stall, NO 2000ms watchdog. A prompt
//     sent AFTERWARDS still completes (proving the session survived), and switching mode AFTER it works.
//
// Run: cd fork && npm run build && node experiments/probe-f-boot-mode-respawn.mjs
import { spawn } from "node:child_process";
import { mkdirSync, existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { ClientSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { nodeToWebReadable, nodeToWebWritable } from "../dist/utils.js";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
// HOME-based cwd: claude writes its JSONL transcript LIVE here (a /tmp cwd does NOT — probe-c finding).
const SESSION_CWD = `${homedir()}/Desktop/probe-f-boot`;
rmSync(SESSION_CWD, { recursive: true, force: true });
mkdirSync(SESSION_CWD, { recursive: true });

function withTimeout(p, ms, label) {
  let t;
  const to = new Promise(
    (_, rej) => (t = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)),
  );
  return Promise.race([p, to]).finally(() => clearTimeout(t));
}

// CLEAN env allow-list — running inside Claude Code would otherwise leak CLAUDE_CODE_* and make the
// spawned claude a NESTED session (no live transcript → pump/end-of-turn never fire). See probe-e.
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
  env: CLEAN_ENV,
});
let stderr = "";
child.stderr.on("data", (d) => (stderr += d.toString()));

let permissionRequests = [];
const client = {
  async sessionUpdate() {},
  async requestPermission(params) {
    permissionRequests.push(params);
    return { outcome: { outcome: "selected", optionId: "allow" } };
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

const out = {};
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
  await delay(6000); // let the freshly-spawned claude TUI settle

  // BOOT SWITCH: set bypassPermissions IMMEDIATELY, BEFORE any prompt (the default_config_options path).
  out.bootSwitch = await withTimeout(
    agent.setSessionConfigOption({ sessionId, configId: "mode", value: "bypassPermissions" }),
    20000,
    "boot set_mode(bypass)",
  )
    .then(() => ({ accepted: true }))
    .catch((e) => ({ accepted: false, error: String(e.message || e) }));

  // SURVIVAL CHECK: the session must still complete a turn (the guard kept the fresh PTY alive). If the
  // boot switch had killed the PTY / stalled, this prompt would hit the turn watchdog and reject.
  await delay(2000);
  out.afterBootPrompt = await withTimeout(
    agent.prompt({ sessionId, prompt: [{ type: "text", text: "responda apenas: vivo" }] }),
    70000,
    "prompt after boot switch",
  )
    .then((r) => ({ stopReason: r?.stopReason ?? null }))
    .catch((e) => ({ error: String(e.message || e) }));

  // POST-INTERACTION SWITCH: now that the transcript exists, switching to bypass should WORK (case b).
  out.postSwitch = await withTimeout(
    agent.setSessionConfigOption({ sessionId, configId: "mode", value: "bypassPermissions" }),
    30000,
    "post set_mode(bypass)",
  )
    .then(() => ({ accepted: true }))
    .catch((e) => ({ accepted: false, error: String(e.message || e) }));

  await delay(3000);
  permissionRequests = [];
  const file = "del-boot.txt";
  out.bypassWrite = await withTimeout(
    agent.prompt({
      sessionId,
      prompt: [
        {
          type: "text",
          text: `Crie o arquivo ${file} com o conteúdo exato: oi (apenas o arquivo).`,
        },
      ],
    }),
    70000,
    "bypass write prompt",
  )
    .then((r) => ({
      stopReason: r?.stopReason ?? null,
      permissionRequests: permissionRequests.length,
      fileCreated: existsSync(`${SESSION_CWD}/${file}`),
    }))
    .catch((e) => ({ error: String(e.message || e) }));
} catch (e) {
  out.fatal = String(e.message || e);
} finally {
  try {
    child.kill();
  } catch {}
}

const guardRefused =
  out.bootSwitch &&
  out.bootSwitch.accepted === false &&
  /before the first interaction/i.test(out.bootSwitch.error || "");
const survived = out.afterBootPrompt && !out.afterBootPrompt.error;
const verdict =
  guardRefused && survived
    ? "FIXED (guard): boot bypass was refused (no --resume of a missing transcript), the fresh session SURVIVED, and a post-interaction switch works."
    : out.fatal || (out.afterBootPrompt && out.afterBootPrompt.error)
      ? "STILL BROKEN: the boot switch stalled/killed the session (see out) — the guard did not protect it."
      : "INCONCLUSIVE — inspect out.";

console.log(
  JSON.stringify(
    {
      probe: "F — boot-time mode re-spawn (live)",
      verdict,
      out,
      stderrTail:
        stderr
          .slice(-800)
          .match(
            /\[(gate|end-of-turn|acp-agent)[^\n]*|Transcript not found[^\n]*|before the first interaction[^\n]*/g,
          )
          ?.slice(0, 10) || [],
    },
    null,
    2,
  ),
);
process.exit(0);
