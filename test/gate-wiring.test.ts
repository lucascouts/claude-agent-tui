// Story 034 (§9 / R3.3) — runtime wiring of the HYBRID permission gate into createSession.
//
// gate-integration.test.ts (story 033) proved the STANDALONE units (hook server + correlator +
// request-permission + allow-inject) compose; THIS file proves the story-034 RUNTIME WIRING: a
// directly-constructed agent with `gate: true` (the bootstrap-resolved AgentDeps flag) makes
// createSession start a REAL loopback hook server, write the per-session SCRATCH settings file the
// spawn consumes via `--settings "<file>"`, bind the AUTHORITATIVE session id, enforce deny
// end-to-end over the real wire, and tear everything down (teardownSession AND spawn failure)
// leaking no port, server, or scratch file. Gate OFF (the default seam / `FORK_GATE=off`) is
// byte-for-byte the pre-034 ungated path: no server, no scratch, no `--settings`.
//
// OFFLINE (story-033 discipline): a fake ACP client + a fake startEngine/PTY are the ONLY fakes —
// the hook server, the settings writer, the correlator, and the decision chain are the REAL units.
// No `claude` is spawned, nothing bills, the http server binds 127.0.0.1 only, and every server is
// closed in the test's own teardown so the runner never hangs.
//
// node:test runner: `node --experimental-strip-types --test test/gate-wiring.test.ts`
// (run `npm run build` first — behavioral imports resolve against ../dist).
import { test } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import * as fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeAcpAgent } from "../dist/acp-agent.js";
import { SCRATCH_SETTINGS_PREFIX, type SessionGate } from "../dist/permissions/gate-wiring.js";
import {
  ALLOW_OPTION_ID,
  DENY_OPTION_ID,
  type RequestPermissionParams,
} from "../dist/permissions/request-permission.js";
import { FORK_HOOK_MARKER_PATH } from "../dist/gate/settings-writer.js";
import { findFreePort } from "../dist/gate/port.js";
import { buildClaudeCmd } from "../dist/engine-pty.js";
import { createSessionEngine } from "../dist/engine-lifecycle.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const INDEX_SRC = path.join(here, "..", "src", "index.ts");
const ACP_AGENT_SRC = path.join(here, "..", "src", "acp-agent.ts");

/** Short, hang-proof gate timing knobs for every test (production defaults are seconds-scale). */
const SHORT_KNOBS = {
  correlationWaitMs: 250,
  correlationPollMs: 10,
  promptAppearMs: 50,
  promptPollMs: 5,
  injectTimeoutMs: 200,
  closeTimeoutMs: 1000,
};

/** POST a body to the loopback hook server, resolving the decision JSON (how claude calls it). */
function post(port: number, body: string, token?: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: token ? `${FORK_HOOK_MARKER_PATH}/${token}` : FORK_HOOK_MARKER_PATH,
        method: "POST",
        headers: { "content-type": "application/json" },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, json: data ? JSON.parse(data) : null });
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

/** A fixture PreToolUse payload (GATE_FINDINGS keystone 1.3 shape). The `session_id` is the TUI's
 *  own id, DELIBERATELY different from the ACP session id — the bound (authoritative) id must win. */
function fixturePayload(
  toolUseId: string,
  toolName = "Bash",
  toolInput: unknown = { command: "rm -rf /" },
  permissionMode = "default",
): string {
  return JSON.stringify({
    session_id: "tui-side-session-id",
    transcript_path: "/tmp/x.jsonl",
    cwd: "/tmp",
    permission_mode: permissionMode,
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: toolUseId,
  });
}

/** Minimal ACP client stub: records each session/request_permission and answers via `decide`. */
function makeClient(decide: () => string) {
  const calls: RequestPermissionParams[] = [];
  const client = {
    sessionUpdate: async () => {},
    requestPermission: async (params: RequestPermissionParams) => {
      calls.push(params);
      return { outcome: { outcome: "selected", optionId: decide() } };
    },
    readTextFile: async () => ({ content: "" }),
    writeTextFile: async () => ({}),
  } as never;
  return { client, calls };
}

/** A fake PTY satisfying the agent's handle shape; records the onExit callbacks the agent wires. */
function makeFakePty() {
  const exitCallbacks: Array<() => void> = [];
  const pty = {
    onExit: (cb: () => void) => {
      exitCallbacks.push(cb);
      return { dispose() {} };
    },
    onData: () => ({ dispose() {} }),
    resize: () => {},
    write: () => {},
    kill: () => {},
  };
  return { pty: pty as never, exitCallbacks };
}

/** An injected startEngine seam recording its args (incl. story-034 `settingsFile`). */
function makeFakeStartEngine(opts?: { fail?: Error }) {
  const calls: Array<{ settingsFile?: string; cwd: string }> = [];
  const fakePty = makeFakePty();
  const startEngine = (args: { sessionId?: string; cwd: string; settingsFile?: string }) => {
    calls.push({ settingsFile: args.settingsFile, cwd: args.cwd });
    if (opts?.fail) throw opts.fail;
    return {
      sessionId: args.sessionId ?? "11111111-1111-4111-8111-111111111111",
      pty: fakePty.pty,
      watcher: { stop: () => {}, notifyEndOfTurn: () => {} },
      cwd: args.cwd,
    };
  };
  return { startEngine, calls, exitCallbacks: fakePty.exitCallbacks };
}

/** Build a gate-ON agent over fakes + a tmp scratch dir, create one session, hand back the parts. */
async function setupGatedAgent(
  t: Parameters<NonNullable<Parameters<typeof test>[0]>>[0],
  decide: () => string,
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gate-wiring-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const { client, calls } = makeClient(decide);
  const fake = makeFakeStartEngine();
  const agent = new ClaudeAcpAgent(client, undefined, undefined, {
    startEngine: fake.startEngine as never,
    gate: true,
    gateOptions: { settingsDir: dir, ...SHORT_KNOBS },
  });
  t.after(() => agent.dispose()); // closes the hook server + removes the scratch — the runner never hangs

  const response = await (agent as unknown as {
    createSession: (p: unknown, o?: unknown) => Promise<{ sessionId: string }>;
  }).createSession({ cwd: "/work/dir", mcpServers: [] });

  const session = (agent as unknown as { sessions: Record<string, { gate?: SessionGate }> }).sessions[
    response.sessionId
  ];
  assert.ok(session?.gate, "a gate-ON fresh session must carry the SessionGate runtime handle");
  return { agent, calls, fake, dir, sessionId: response.sessionId, gate: session.gate! };
}

// === (a) gate ON: createSession starts a REAL loopback server + writes the scratch the spawn consumes

test("wiring (a): gate ON — createSession starts a REAL loopback hook server and writes the scratch settings whose URL points at it", async (t) => {
  const { fake, dir, gate } = await setupGatedAgent(t, () => DENY_OPTION_ID);

  // The scratch settings path flowed through the startEngine seam (→ spawn `--settings "<file>"`).
  assert.equal(fake.calls.length, 1, "the engine was started exactly once");
  const settingsFile = fake.calls[0].settingsFile;
  assert.ok(settingsFile, "createSession must hand the gate's scratch settings path to the spawn seam");
  assert.equal(path.dirname(settingsFile), dir, "the scratch lives in the configured settingsDir");
  assert.ok(
    path.basename(settingsFile).startsWith(SCRATCH_SETTINGS_PREFIX),
    `the scratch file is diagnosable by prefix (${SCRATCH_SETTINGS_PREFIX}*)`,
  );
  assert.equal(settingsFile, gate.settingsPath, "the seam receives the gate's OWN settingsPath");

  // The scratch ON DISK carries the PreToolUse type:http hook pointing at the gate's bound port.
  const written = JSON.parse(await fs.readFile(settingsFile, "utf8"));
  const group = written.hooks.PreToolUse[0];
  assert.equal(group.matcher, "*", "the hook gates every tool (story-032 matcher)");
  assert.equal(group.hooks[0].type, "http", "the hook is the type:http loopback transport (blocker b)");
  assert.equal(
    group.hooks[0].url,
    `http://127.0.0.1:${gate.port}${FORK_HOOK_MARKER_PATH}/${gate.token}`,
    "the hook URL carries the LIVE server's loopback port + the fork-owned marker path + the R1.3 token",
  );

  // The server at that URL is REAL and FAIL-CLOSED: a malformed body draws a deny, not a hang/500.
  const { status, json } = await post(gate.port, "this is not json", gate.token);
  assert.equal(status, 200, "the hook server answers (it is really listening on the scratch URL's port)");
  assert.equal(json.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(json.hookSpecificOutput.permissionDecision, "deny", "a malformed payload fails closed");

  // And the spawn cmd embeds that exact path (the engine-pty story-034 surface).
  const cmd = buildClaudeCmd("33333333-3333-4333-8333-333333333333", undefined, settingsFile);
  assert.ok(
    cmd.includes(`--settings "${settingsFile}"`),
    `the spawn cmd must carry --settings with the scratch path, got: ${cmd}`,
  );
});

test("wiring (a2): the engine chain embeds --settings into the REAL spawn argv (createSessionEngine → spawnClaudePty)", () => {
  const spawnCalls: Array<{ file: string; args: readonly string[] }> = [];
  const { pty } = makeFakePty();
  const spawn = ((file: string, args: readonly string[]) => {
    spawnCalls.push({ file, args });
    return pty;
  }) as never;

  const engine = createSessionEngine({
    cwd: "/work",
    baseEnv: { SHELL: "/bin/bash" } as NodeJS.ProcessEnv,
    spawn,
    settingsFile: "/tmp/fork-acp-gate-settings-test.json",
  });
  engine.kill();

  assert.equal(spawnCalls.length, 1);
  assert.deepEqual(
    spawnCalls[0].args,
    [
      "-lc",
      `claude --session-id ${engine.sessionId} --settings "/tmp/fork-acp-gate-settings-test.json"`,
    ],
    "the -lc spawn argv carries --settings with the quoted scratch path",
  );

  // Lock the remaining link of the chain: defaultStartEngine forwards args.settingsFile into
  // createSessionEngine (exercising the real defaultStartEngine offline needs a transcript watchdog,
  // so the pass-through is source-guarded instead).
  const src = readFileSync(ACP_AGENT_SRC, "utf8");
  assert.ok(
    /settingsFile:\s*args\.settingsFile/.test(src),
    "defaultStartEngine must forward args.settingsFile to createSessionEngine",
  );
});

// === (b) deny END-TO-END over the real wire blocks the tool (fail-closed posture) ==================

test("wiring (b): DENY end-to-end — PreToolUse → REAL server → bound ACP session prompt → permissionDecision 'deny'", async (t) => {
  const { calls, sessionId, gate } = await setupGatedAgent(t, () => DENY_OPTION_ID);

  // Simulate the live pump having observed this tool_use id in the JSONL (registerGateToolUses).
  gate.correlator.register("toolu_wired_deny");

  const { status, json } = await post(gate.port, fixturePayload("toolu_wired_deny"), gate.token);

  assert.equal(status, 200);
  assert.equal(
    json.hookSpecificOutput.permissionDecision,
    "deny",
    "the user's deny intercepts the tool BEFORE it runs (the load-bearing capability)",
  );
  assert.equal(calls.length, 1, "exactly one session/request_permission was raised in Zed");
  assert.equal(
    calls[0].sessionId,
    sessionId,
    "the prompt carries the AUTHORITATIVE ACP session id (bindSession), not the TUI payload's id",
  );
  assert.equal(calls[0].toolCall.toolCallId, "toolu_wired_deny", "correlated by tool_use.id");
  assert.deepEqual(
    calls[0].options.map((o) => o.optionId),
    [ALLOW_OPTION_ID, DENY_OPTION_ID],
    "the gate offers [allow, deny]",
  );
});

test("wiring (b2): a tool_use.id absent from the JSONL is seeded from the HOOK payload and relayed to Zed (FIX gate-deadlock)", async (t) => {
  // DESIGN CHANGE 2026-06-25 (proven live): the claude flushes the `tool_use` line to the JSONL only
  // AFTER the hook decision, so the old "absent from JSONL → deny" rule DEADLOCKED every gated tool
  // (Bash/Agent/ToolSearch all timed out → denied; the permission dialog never appeared). The
  // PreToolUse hook payload IS the authoritative tool_use.id, so the gate now seeds the correlator
  // from it (`ensureRegistered`) and relays the dialog to Zed — the decision follows the user's choice
  // (here Zed allows). The JSONL-forgery defense is deliberately relaxed (the hook is loopback-local
  // from the real claude). STILL fail-closed: an unparseable/id-less payload (separate test) and a
  // DUPLICATE / re-entrant id (correlator.decide — `ensureRegistered` only seeds when count==0).
  const { calls, gate } = await setupGatedAgent(t, () => ALLOW_OPTION_ID);

  const { json } = await post(gate.port, fixturePayload("toolu_ghost"), gate.token);

  assert.equal(json.hookSpecificOutput.permissionDecision, "allow", "hook-sourced id is relayed; follows Zed's allow");
  assert.equal(calls.length, 1, "exactly one session/request_permission is raised for the hook-sourced tool");
});

// === (b3) Story 046 (R3) — the decider HONORS the live permission mode before relaying to Zed ======
// Without these branches the gate raises session/request_permission for EVERY tool, overriding the
// panel's mode selector (the user saw a Zed prompt in every mode, even bypass). probe-d confirmed the
// hook payload's `permission_mode` matches the selected mode.

test("wiring (b3): bypassPermissions auto-allows ANY tool WITHOUT raising a Zed prompt (story 046 R3)", async (t) => {
  const { calls, gate } = await setupGatedAgent(t, () => DENY_OPTION_ID);
  // A dangerous Bash, and DELIBERATELY uncorrelated — the bypass short-circuit precedes both the
  // correlation wait and the Zed relay, so it allows regardless (the explicit user choice is honored).
  const { json } = await post(
    gate.port,
    fixturePayload("toolu_bypass", "Bash", { command: "rm -rf /" }, "bypassPermissions"),
    gate.token,
  );
  assert.equal(json.hookSpecificOutput.permissionDecision, "allow", "bypassPermissions auto-allows");
  assert.equal(calls.length, 0, "bypass never raises session/request_permission (selector honored, not overridden)");
});

test("wiring (b4): acceptEdits auto-allows an EDIT-class tool WITHOUT a Zed prompt (story 046 R3)", async (t) => {
  const { calls, gate } = await setupGatedAgent(t, () => DENY_OPTION_ID);
  const { json } = await post(
    gate.port,
    fixturePayload("toolu_edit", "Write", { file_path: "/tmp/x", content: "hi" }, "acceptEdits"),
    gate.token,
  );
  assert.equal(json.hookSpecificOutput.permissionDecision, "allow", "acceptEdits auto-allows edit-class tools");
  assert.equal(calls.length, 0, "an auto-allowed edit never prompts Zed");
});

test("wiring (b5): acceptEdits does NOT auto-allow a NON-edit tool — it still asks Zed (story 046 R3)", async (t) => {
  const { calls, gate } = await setupGatedAgent(t, () => ALLOW_OPTION_ID);
  gate.correlator.register("toolu_accept_bash"); // the fall-through (ask-Zed) path needs correlation
  const { json } = await post(
    gate.port,
    fixturePayload("toolu_accept_bash", "Bash", { command: "ls" }, "acceptEdits"),
    gate.token,
  );
  assert.equal(calls.length, 1, "a non-edit tool under acceptEdits still raises a Zed prompt (only edits auto-allow)");
  assert.equal(json.hookSpecificOutput.permissionDecision, "allow", "and Zed's decision is enforced on the fall-through");
});

// === (c) teardown closes the server and removes the scratch — no leak ==============================

test("wiring (c): teardownSession closes the hook server AND removes the scratch settings (no port/file leak)", async (t) => {
  const { agent, gate, fake, sessionId } = await setupGatedAgent(t, () => DENY_OPTION_ID);
  const settingsFile = fake.calls[0].settingsFile!;
  const port = gate.port;

  await agent.closeSession({ sessionId } as never);

  assert.equal(gate.isTorndown, true, "the session gate is torn down with the session");
  await assert.rejects(
    fs.access(settingsFile),
    /ENOENT/,
    "the scratch settings file is deleted on teardown (no residue)",
  );
  await assert.rejects(
    post(port, fixturePayload("toolu_after_teardown")),
    (err: NodeJS.ErrnoException) => err.code === "ECONNREFUSED",
    "the hook server's port is closed on teardown (no listener leak)",
  );
});

test("wiring (c2): PTY exit also tears the gate down (idempotent with teardownSession)", async (t) => {
  const { agent, gate, fake, sessionId } = await setupGatedAgent(t, () => DENY_OPTION_ID);

  // The agent wired `started.pty.onExit(() => gate.teardown())` — fire the recorded exit callback
  // (a crashed TUI). teardown() flips isTorndown synchronously; the async close/delete follows.
  assert.ok(fake.exitCallbacks.length >= 1, "createSession subscribed the gate teardown to PTY exit");
  for (const cb of fake.exitCallbacks) cb();
  assert.equal(gate.isTorndown, true, "PTY exit tears the gate down");

  // The scratch deletion completes asynchronously — bounded poll, never an unbounded wait.
  const settingsFile = fake.calls[0].settingsFile!;
  let gone = false;
  for (let i = 0; i < 100 && !gone; i++) {
    gone = await fs.access(settingsFile).then(
      () => false,
      () => true,
    );
    if (!gone) await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(gone, "the scratch settings file is removed after the PTY-exit teardown");

  // teardownSession on the already-torn-down gate is a no-op (idempotent) — no double-restore error.
  await agent.closeSession({ sessionId } as never);
  assert.equal(gate.isTorndown, true);
});

// === (d) gate OFF: ZERO side-effects — the ungated spawn is byte-for-byte pre-034 ==================

test("wiring (d): gate OFF (default seam / FORK_GATE=off) — no server, no scratch, no --settings", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gate-wiring-off-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const { client, calls } = makeClient(() => ALLOW_OPTION_ID);
  const fake = makeFakeStartEngine();
  // `gate` NOT set: the constructor seam defaults OFF (the story-038 two-layer pattern) — exactly
  // what the bootstrap passes when FORK_GATE=off.
  const agent = new ClaudeAcpAgent(client, undefined, undefined, {
    startEngine: fake.startEngine as never,
    gateOptions: { settingsDir: dir, ...SHORT_KNOBS },
  });
  t.after(() => agent.dispose());

  const response = await (agent as unknown as {
    createSession: (p: unknown, o?: unknown) => Promise<{ sessionId: string }>;
  }).createSession({ cwd: "/work/dir", mcpServers: [] });

  assert.equal(fake.calls[0].settingsFile, undefined, "no --settings reaches the spawn seam");
  const session = (agent as unknown as { sessions: Record<string, { gate?: unknown }> }).sessions[
    response.sessionId
  ];
  assert.equal(session.gate, undefined, "no SessionGate is constructed (no server was ever started)");
  assert.deepEqual(await fs.readdir(dir), [], "no scratch settings file is written");
  assert.equal(calls.length, 0, "no session/request_permission is ever raised");

  // Byte-for-byte pre-034 spawn cmd: without settingsFile the cmd has NO --settings token at all.
  const cmd = buildClaudeCmd(response.sessionId);
  assert.equal(cmd, `claude --session-id ${response.sessionId}`, "the ungated spawn cmd is pre-034");
});

test("wiring (d2): the production bootstrap resolves FORK_GATE — ON by default, 'off' is the escape hatch", () => {
  // index.ts is the process-env boundary (story-038 USAGE_UPDATE precedent: wire tests proved that
  // env over stdio; the gate's wire-level proof is story 034's live half). Source-guard the contract:
  // default ON (`!== "off"` — any other value, even "0", stays gated: the conservative direction for
  // a safety gate), threaded through runAcp into AgentDeps.
  const src = readFileSync(INDEX_SRC, "utf8");
  assert.ok(
    /const gate = process\.env\.FORK_GATE !== "off";/.test(src),
    'index.ts must resolve the gate as ON unless FORK_GATE === "off"',
  );
  // Story 043 made this guard tolerant to ADDITIONAL threaded flags: `liveDiff` joined the runAcp
  // AgentDeps object after `usageUpdate`/`gate`, so the prior exact-set regex (`{ usageUpdate, gate }`)
  // false-Red'd. Assert only the contract this test owns — `gate` IS threaded through the runAcp object
  // — regardless of the other flags listed alongside it, so a future flag won't break the gate guard.
  assert.ok(
    /runAcp\(\{[^}]*\bgate\b[^}]*\}\)/.test(src),
    "index.ts must thread the resolved gate flag through runAcp's AgentDeps",
  );
});

// === (e) spawn failure: the gate never leaks (server closed + scratch removed) =====================

test("wiring (e): a spawn failure tears the gate down — server closed, scratch removed, original error surfaced", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gate-wiring-fail-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const { client } = makeClient(() => ALLOW_OPTION_ID);
  const fake = makeFakeStartEngine({ fail: new Error("spawn exploded") });
  let capturedPort = 0;
  const agent = new ClaudeAcpAgent(client, undefined, undefined, {
    startEngine: fake.startEngine as never,
    gate: true,
    gateOptions: {
      settingsDir: dir,
      ...SHORT_KNOBS,
      findPort: async () => {
        capturedPort = await findFreePort();
        return capturedPort;
      },
    },
  });
  t.after(() => agent.dispose());

  await assert.rejects(
    (agent as unknown as {
      createSession: (p: unknown, o?: unknown) => Promise<unknown>;
    }).createSession({ cwd: "/work/dir", mcpServers: [] }),
    /spawn exploded/,
    "the ORIGINAL spawn error surfaces (teardown does not mask it)",
  );

  assert.ok(capturedPort > 0, "the gate had allocated a port before the spawn failed");
  assert.deepEqual(
    await fs.readdir(dir),
    [],
    "the scratch settings file is removed when the spawn fails (no residue)",
  );
  await assert.rejects(
    post(capturedPort, fixturePayload("toolu_after_spawn_fail")),
    (err: NodeJS.ErrnoException) => err.code === "ECONNREFUSED",
    "the hook server is closed when the spawn fails (no listener leak)",
  );
});
