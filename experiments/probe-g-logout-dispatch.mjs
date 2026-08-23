#!/usr/bin/env node
// experiments/probe-g-logout-dispatch.mjs — Story 062 live ACP harness.
//
// PROVES WHAT THE HERMETIC SUITE CANNOT. test/logout.test.ts calls `agent.logout()` DIRECTLY and can
// only SIMULATE the SDK bind (node_modules/@agentclientprotocol/sdk/dist/acp.js:999), so it never
// exercises the wire. The risk Task 2.1 recorded — "the name must be exactly `logout` for SDK
// dispatch" — therefore stayed open: a renamed or unbound handler would leave every unit test green
// while the real client silently got a no-op.
//
// The story's original live-proof gate did NOT close it either. It asserted "the auth screen
// re-appears after logout", which passes whether or not logout ever runs: `gatewayAuthRequest` is
// write-only (acp-agent.ts 1374/1711/1728/1941, zero reads in src/) and `authMethods` is built solely
// from the initialize request's clientCapabilities (acp-agent.ts:1626). A guaranteed green.
//
// THIS PROBE drives the BUILT fork over the real ACP stdio transport (like Zed): initialize → logout,
// with FORK_AUTH_PROBE=1 so the handler announces itself on stderr.
//
// DECISIVE SIGNALS (both required):
//   - the wire returns a result for id=2 → the SDK registered and dispatched the method by name;
//   - stderr carries "[auth-probe] logout dispatched by the client" → OUR handler body ran, not a
//     default/no-op. Without the probe line, a `result: {}` alone would be indistinguishable from the
//     SDK answering for an unimplemented method.
//
// Costs nothing: no PTY, no session, no prompt, no tokens, and it does NOT end the auth session
// (the handler only drops in-memory state — R2/R3).
//
// Run: cd fork && npm run build && node experiments/probe-g-logout-dispatch.mjs
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ENTRY = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");
const PROBE_LINE = "[auth-probe] logout dispatched by the client";

const child = spawn("node", [ENTRY], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, FORK_AUTH_PROBE: "1" },
});

let stderr = "";
child.stderr.on("data", (d) => {
  stderr += d.toString();
});

let buf = "";
const inbound = [];
child.stdout.on("data", (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    try {
      inbound.push(JSON.parse(line));
    } catch {
      // non-JSON on stdout would itself be a bug (stdout is the wire) — surfaced in the dump below
    }
  }
});

const send = (msg) => child.stdin.write(JSON.stringify(msg) + "\n");

send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: 1, clientCapabilities: { fs: {}, terminal: true } },
});

setTimeout(() => send({ jsonrpc: "2.0", id: 2, method: "logout", params: {} }), 1500);

setTimeout(() => {
  child.kill("SIGTERM");

  const logoutReply = inbound.find((m) => m.id === 2);
  const dispatched = Boolean(logoutReply) && !logoutReply.error;
  const handlerRan = stderr.includes(PROBE_LINE);

  console.log("=== wire reply to id=2 (logout) ===");
  console.log(logoutReply ? JSON.stringify(logoutReply) : "NONE — the method was never answered");
  console.log("\n=== agent stderr ===");
  console.log(stderr.trim() || "(empty)");
  console.log("\n=== VERDICT ===");
  console.log(`  wire dispatched by name : ${dispatched ? "YES" : "NO"}`);
  console.log(`  our handler body ran    : ${handlerRan ? "YES" : "NO"}`);
  console.log(
    dispatched && handlerRan
      ? "\nPROVEN — the client reaches ClaudeAcpAgent.logout over the real ACP transport."
      : "\nNOT PROVEN — see the dump above.",
  );

  process.exit(dispatched && handlerRan ? 0 : 1);
}, 3500);
