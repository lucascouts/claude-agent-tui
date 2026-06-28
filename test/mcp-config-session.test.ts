// Story 057 / Task 2.3 — the MCP scratch-file lifecycle wired into acp-agent.ts: WRITE before the
// spawn when the session declares MCP servers, THREAD the path into startEngine (fresh + resume),
// STORE it on the session record, REMOVE it on teardown, and REGENERATE it on re-spawn (R2.4).
//
// Integration over the SAME injected-startEngine seam createSession-spawn.test.ts / agent-respawn.test.ts
// use: a fake `startEngine` (via the AgentDeps constructor seam) CAPTURES `args.mcpConfigFile`, so the
// assertions verify (a) the path reaches the spawn and (b) the REAL production writeMcpScratch/
// removeMcpScratch ran (the fake engine writes nothing — every on-disk file here was written by the
// production lifecycle through the public surface). The re-spawn case reuses agent-respawn.test.ts's
// exact respawn driver (an `agent` configOption change on an interacted session), with discoverAgents
// injected so the `agent` option surfaces (the #794 gate). All real scratch files are cleaned up in a
// `finally` so a failed assertion never orphans a 0600 temp.
//
// node:test (build first — behavioral imports resolve against ../dist):
//   node --experimental-strip-types --test test/mcp-config-session.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { statSync, existsSync, rmSync } from "node:fs";
import { ClaudeAcpAgent } from "../dist/acp-agent.js";

/** Minimal ACP client stub — every method the agent may call on construction/createSession. */
function makeClient() {
  return {
    sessionUpdate: async () => {},
    requestPermission: async () => ({ outcome: { outcome: "selected", optionId: "allow" } }),
    readTextFile: async () => ({ content: "" }),
    writeTextFile: async () => ({}),
  } as never;
}

/** A fake PTY: satisfies the handle shape; records nothing (the lifecycle under test is the scratch). */
function makeFakePty() {
  return {
    onExit: () => ({ dispose() {} }),
    onData: () => ({ dispose() {} }),
    resize: () => {},
    write: () => {},
    kill: () => {},
  } as never;
}

/** Captured startEngine args. call 1 is the createSession spawn; a later call is the respawn. We record
 *  `mcpConfigFile` (the field under test) plus the respawn identity fields. The fake engine writes NO
 *  files — so a captured path that exists on disk was written by the production lifecycle. */
type Captured = {
  sessionId?: string;
  resume?: boolean;
  inPlaceRespawn?: boolean;
  mcpConfigFile?: string;
  additionalDirectories?: string[];
};

function makeStartEngine() {
  const calls: Captured[] = [];
  const startEngine = (args: {
    sessionId?: string;
    cwd: string;
    resume?: boolean;
    inPlaceRespawn?: boolean;
    mcpConfigFile?: string;
    additionalDirectories?: string[];
  }) => {
    calls.push({
      sessionId: args.sessionId,
      resume: args.resume,
      inPlaceRespawn: args.inPlaceRespawn,
      mcpConfigFile: args.mcpConfigFile,
      additionalDirectories: args.additionalDirectories,
    });
    return {
      sessionId: args.sessionId ?? "11111111-1111-4111-8111-111111111111",
      pty: makeFakePty(),
      watcher: { stop: () => {}, notifyEndOfTurn: () => {} },
      cwd: args.cwd,
    };
  };
  return { startEngine, calls };
}

/** One stdio MCP server in the ACP `McpServer[]` shape (the bare stdio variant: no `type` tag). */
const ONE_STDIO_SERVER = [{ name: "fs", command: "mcp-fs", args: [], env: [] }];

/** Best-effort cleanup of every captured scratch path (idempotent; never throws). */
function cleanupCaptured(calls: Captured[]) {
  for (const c of calls) {
    if (c.mcpConfigFile) {
      try {
        rmSync(c.mcpConfigFile, { force: true });
      } catch {
        // ignore — best-effort
      }
    }
  }
}

const createSessionVia = (agent: ClaudeAcpAgent, params: unknown) =>
  (
    agent as unknown as {
      createSession: (p: unknown, o?: unknown) => Promise<{ sessionId: string }>;
    }
  ).createSession(params);

const closeSessionVia = (agent: ClaudeAcpAgent, sessionId: string) =>
  (
    agent as unknown as { closeSession: (p: { sessionId: string }) => Promise<unknown> }
  ).closeSession({ sessionId });

test("createSession with a non-empty mcpServers writes a 0600 scratch and threads its path to the spawn", async (t) => {
  const fake = makeStartEngine();
  const agent = new ClaudeAcpAgent(makeClient(), undefined, undefined, {
    startEngine: fake.startEngine,
  });
  t.after(() => agent.dispose());
  t.after(() => cleanupCaptured(fake.calls));

  await createSessionVia(agent, { cwd: "/work/dir", mcpServers: ONE_STDIO_SERVER });

  assert.equal(fake.calls.length, 1, "the spawn ran exactly once");
  const spawn = fake.calls[0];
  assert.ok(
    typeof spawn.mcpConfigFile === "string" && spawn.mcpConfigFile.length > 0,
    "the spawn must receive a concrete MCP scratch path (the path reaches startEngine)",
  );
  const scratch = spawn.mcpConfigFile as string;
  assert.ok(existsSync(scratch), "the scratch file must exist on disk (written BEFORE the spawn)");
  // R2.3: the scratch may carry MCP auth headers/env — its mode must be owner-only (0600).
  const mode = statSync(scratch).mode & 0o777;
  assert.equal(mode, 0o600, `the scratch must be mode 0600 (owner-only), got 0${mode.toString(8)}`);
});

test("createSession with empty/absent mcpServers threads NO path and writes NO scratch", async (t) => {
  const fake = makeStartEngine();
  const agent = new ClaudeAcpAgent(makeClient(), undefined, undefined, {
    startEngine: fake.startEngine,
  });
  t.after(() => agent.dispose());
  t.after(() => cleanupCaptured(fake.calls));

  // empty array
  await createSessionVia(agent, { cwd: "/work/a", mcpServers: [] });
  // absent entirely
  await createSessionVia(agent, { cwd: "/work/b" });

  assert.equal(fake.calls.length, 2, "two spawns ran");
  for (const c of fake.calls) {
    assert.equal(
      c.mcpConfigFile,
      undefined,
      "no MCP servers declared → mcpConfigFile must be undefined (no --mcp-config, byte-for-byte pre-057)",
    );
  }
});

test("teardown (closeSession) REMOVES the MCP scratch — no orphaned secret-bearing file", async (t) => {
  const fake = makeStartEngine();
  const agent = new ClaudeAcpAgent(makeClient(), undefined, undefined, {
    startEngine: fake.startEngine,
  });
  t.after(() => cleanupCaptured(fake.calls)); // belt-and-suspenders even if the assertion below fails

  const { sessionId } = await createSessionVia(agent, {
    cwd: "/work/dir",
    mcpServers: ONE_STDIO_SERVER,
  });
  const scratch = fake.calls[0].mcpConfigFile as string;
  assert.ok(scratch && existsSync(scratch), "precondition: the scratch was written on create");

  await closeSessionVia(agent, sessionId);

  assert.ok(!existsSync(scratch), "closeSession must REMOVE the scratch (R2.3 — no orphan)");
});

test("dispose() also removes the MCP scratch on connection close", async (t) => {
  const fake = makeStartEngine();
  const agent = new ClaudeAcpAgent(makeClient(), undefined, undefined, {
    startEngine: fake.startEngine,
  });
  t.after(() => cleanupCaptured(fake.calls));

  await createSessionVia(agent, { cwd: "/work/dir", mcpServers: ONE_STDIO_SERVER });
  const scratch = fake.calls[0].mcpConfigFile as string;
  assert.ok(scratch && existsSync(scratch), "precondition: the scratch was written on create");

  await agent.dispose();

  assert.ok(!existsSync(scratch), "dispose() must remove the scratch for every torn-down session");
});

const ONE_PERSONA = [{ value: "code-reviewer", displayName: "Code Reviewer" }];

const setOption = (agent: ClaudeAcpAgent, sessionId: string, configId: string, value: string) =>
  (
    agent as unknown as {
      setSessionConfigOption: (p: {
        sessionId: string;
        configId: string;
        value: string;
      }) => Promise<unknown>;
    }
  ).setSessionConfigOption({ sessionId, configId, value });

test("re-spawn REGENERATES the scratch: a different path on the re-spawn AND the old file is removed (R2.4)", async (t) => {
  // Drive a REAL re-spawn the way agent-respawn.test.ts does: inject discoverAgents so the `agent`
  // configOption surfaces (the #794 gate), mark the session interacted (the R3.4 resume-respawn guard),
  // then change the `agent` option. respawnSession must regenerate the MCP scratch (write-new-then-
  // remove-old) and thread the NEW path into the re-spawn's startEngine call.
  const fake = makeStartEngine();
  const agent = new ClaudeAcpAgent(makeClient(), undefined, undefined, {
    startEngine: fake.startEngine,
    discoverAgents: () => ONE_PERSONA,
  } as never);
  t.after(() => agent.dispose());
  t.after(() => cleanupCaptured(fake.calls));

  const { sessionId } = await createSessionVia(agent, {
    cwd: "/work/dir",
    mcpServers: ONE_STDIO_SERVER,
  });
  const firstScratch = fake.calls[0].mcpConfigFile as string;
  assert.ok(firstScratch && existsSync(firstScratch), "precondition: the create scratch exists");

  // Reach the resume re-spawn path (not the fresh pre-interaction one), mirroring agent-respawn.test.ts.
  const sessions = (
    agent as unknown as { sessions: Record<string, { interacted?: boolean }> }
  ).sessions;
  sessions[sessionId].interacted = true;

  const callsBefore = fake.calls.length;
  await setOption(agent, sessionId, "agent", "code-reviewer");

  assert.ok(fake.calls.length > callsBefore, "the agent change must trigger a re-spawn (new startEngine call)");
  const respawn = fake.calls[fake.calls.length - 1];
  assert.equal(respawn.inPlaceRespawn, true, "precondition: it is an in-place re-spawn");
  const secondScratch = respawn.mcpConfigFile as string;

  assert.ok(
    typeof secondScratch === "string" && secondScratch.length > 0,
    "the re-spawn must carry a regenerated MCP scratch path (R2.4)",
  );
  assert.notEqual(
    secondScratch,
    firstScratch,
    "the re-spawn's scratch must be a DIFFERENT (regenerated) path",
  );
  assert.ok(existsSync(secondScratch), "the regenerated scratch must exist on disk for the re-spawn");
  assert.ok(
    !existsSync(firstScratch),
    "the PRIOR scratch must be removed once the new one is written (write-new-then-remove-old, no leak)",
  );
});

test("a re-spawn on a session with NO MCP servers regenerates nothing (mcpConfigFile stays undefined)", async (t) => {
  // The regeneration is gated on "mcpServers non-empty" — a no-MCP session must not start emitting a
  // scratch on re-spawn (byte-for-byte the pre-057 re-spawn argv for that session).
  const fake = makeStartEngine();
  const agent = new ClaudeAcpAgent(makeClient(), undefined, undefined, {
    startEngine: fake.startEngine,
    discoverAgents: () => ONE_PERSONA,
  } as never);
  t.after(() => agent.dispose());
  t.after(() => cleanupCaptured(fake.calls));

  const { sessionId } = await createSessionVia(agent, { cwd: "/work/dir", mcpServers: [] });
  assert.equal(fake.calls[0].mcpConfigFile, undefined, "precondition: no scratch on create (no MCP)");

  const sessions = (
    agent as unknown as { sessions: Record<string, { interacted?: boolean }> }
  ).sessions;
  sessions[sessionId].interacted = true;

  await setOption(agent, sessionId, "agent", "code-reviewer");

  const respawn = fake.calls[fake.calls.length - 1];
  assert.equal(respawn.inPlaceRespawn, true, "precondition: a re-spawn happened");
  assert.equal(
    respawn.mcpConfigFile,
    undefined,
    "a no-MCP session must NOT acquire a scratch on re-spawn (regeneration is gated on non-empty mcpServers)",
  );
});
