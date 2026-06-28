// Story 056 / Task 3.4 (R3.3, R3.4) — selecting a main-thread agent persona re-spawns the session in
// place carrying `--agent "<name>"`, and a mode/effort re-spawn PRESERVES the currently selected agent
// (and vice-versa). This is a FAITHFUL MIRROR of effort-apply.test.ts: `--agent` is a spawn flag with
// no live mid-session path (like `--effort`), so an agent change re-spawns through the startEngine seam
// reusing the sessionId, idle-guarded, with the pre-first-interaction guard (R3.4).
//
// The `agent` configOption only surfaces when ≥1 persona is discovered (the upstream #794 gate), so the
// harness injects the `discoverAgents` deps seam (config-options-agent.test.ts precedent) returning a
// persona — hermetic, never touching the real ~/.claude/agents.
//
// AGENT INTEGRATION over the startEngine seam (effort-apply / mode-respawn precedent). The captured
// startEngine args are load-bearing: scenario 3 fails unless respawnSession threads `agent` through.
// node:test (build first):
//   node --experimental-strip-types --test test/agent-respawn.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeAcpAgent } from "../dist/acp-agent.js";

function makeFakePty() {
  const pty = {
    onExit: () => ({ dispose() {} }),
    onData: () => ({ dispose() {} }),
    resize: () => {},
    write: () => {},
    kill: () => {},
  };
  return pty as never;
}

function makeClient() {
  return {
    sessionUpdate: async () => {},
    requestPermission: async () => ({ outcome: { outcome: "selected", optionId: "allow" } }),
    readTextFile: async () => ({ content: "" }),
    writeTextFile: async () => ({}),
  } as never;
}

/** Captured startEngine args. call 1 is the createSession spawn; a later call is the agent (or effort)
 *  re-spawn. A model switch is an inject, NOT a startEngine call. We record the fields the re-spawn
 *  threads so the preserve assertions (scenario 3) are load-bearing. */
type Captured = {
  sessionId?: string;
  resume?: boolean;
  inPlaceRespawn?: boolean;
  permissionMode?: string;
  effortLevel?: string;
  agent?: string;
};

function makeStartEngine() {
  const calls: Captured[] = [];
  const startEngine = (args: {
    sessionId?: string;
    cwd: string;
    resume?: boolean;
    inPlaceRespawn?: boolean;
    permissionMode?: string;
    effortLevel?: string;
    agent?: string;
  }) => {
    calls.push({
      sessionId: args.sessionId,
      resume: args.resume,
      inPlaceRespawn: args.inPlaceRespawn,
      permissionMode: args.permissionMode,
      effortLevel: args.effortLevel,
      agent: args.agent,
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

const ONE_PERSONA = [{ value: "code-reviewer", displayName: "Code Reviewer" }];

async function newSession(
  t: Parameters<NonNullable<Parameters<typeof test>[0]>>[0],
  startEngine: unknown,
) {
  // Inject discoverAgents so the `agent` configOption surfaces (the #794 gate), hermetic.
  const agent = new ClaudeAcpAgent(makeClient(), undefined, undefined, {
    startEngine: startEngine as never,
    discoverAgents: () => ONE_PERSONA,
  } as never);
  t.after(() => agent.dispose());
  const response = await (
    agent as unknown as {
      createSession: (p: unknown) => Promise<{ sessionId: string }>;
    }
  ).createSession({ cwd: "/work/dir", mcpServers: [] });
  const sessions = (
    agent as unknown as {
      sessions: Record<
        string,
        {
          configOptions: Array<{ id: string; currentValue?: unknown }>;
          interacted?: boolean;
          engine?: unknown;
        }
      >;
    }
  ).sessions;
  return { agent, sessionId: response.sessionId, sessions };
}

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

const agentCurrentValue = (
  sessions: Record<string, { configOptions: Array<{ id: string; currentValue?: unknown }> }>,
  id: string,
) => sessions[id].configOptions.find((o) => o.id === "agent")?.currentValue;

test("3.4 idle + agent change → re-spawns the SAME sessionId carrying --agent (R3.3/R3.4)", async (t) => {
  const fake = makeStartEngine();
  const { agent, sessionId, sessions } = await newSession(t, fake.startEngine);
  sessions[sessionId].interacted = true; // R3.4 guard: a re-spawn is only allowed AFTER the first interaction
  const callsBefore = fake.calls.length;

  await setOption(agent, sessionId, "agent", "code-reviewer");

  assert.ok(
    fake.calls.length > callsBefore,
    `an agent change must trigger a re-spawn (a new startEngine call), got ${fake.calls.length} (was ${callsBefore})`,
  );
  const respawn = fake.calls[fake.calls.length - 1];
  assert.equal(
    respawn.sessionId,
    sessionId,
    "the agent re-spawn must reuse the SAME sessionId (transcript preserved)",
  );
  assert.equal(respawn.resume, true, "an in-place re-spawn resumes the session (resume:true)");
  assert.equal(respawn.inPlaceRespawn, true, "an in-place re-spawn sets inPlaceRespawn:true");
  assert.equal(
    respawn.agent,
    "code-reviewer",
    "the re-spawn must carry the selected persona into startEngine (→ --agent \"code-reviewer\")",
  );
});

test("v4 pre-interaction agent change does a FRESH re-spawn (resume:false) reusing the sessionId", async (t) => {
  const fake = makeStartEngine();
  const { agent, sessionId, sessions } = await newSession(t, fake.startEngine);
  // session.interacted is falsy at fresh create. v4: instead of throwing (the old R3.4 guard), the
  // re-spawn goes FRESH — there is no transcript to `--resume` yet, so it re-spawns reusing the same id
  // with `--agent`, which is what makes the agent selector apply BEFORE the first prompt (the live gap).
  const callsBefore = fake.calls.length;

  await setOption(agent, sessionId, "agent", "code-reviewer");

  assert.ok(
    fake.calls.length > callsBefore,
    "a pre-interaction agent change must still re-spawn (fresh), not silently no-op",
  );
  const respawn = fake.calls[fake.calls.length - 1];
  assert.equal(
    respawn.resume,
    false,
    "the pre-interaction re-spawn must be FRESH (resume:false — no transcript to resume)",
  );
  assert.equal(respawn.inPlaceRespawn, true, "it is still an in-place re-spawn");
  assert.equal(respawn.sessionId, sessionId, "the fresh re-spawn must REUSE the same sessionId");
  assert.equal(respawn.agent, "code-reviewer", "the fresh re-spawn must carry the selected persona");
  assert.equal(
    agentCurrentValue(sessions, sessionId),
    "code-reviewer",
    "the agent currentValue must reflect the applied persona (no longer reverts to default)",
  );
});

test("v4 a mode re-spawn (dontAsk) PRESERVES the selected agent (threads agent ?? currentAgent)", async (t) => {
  // effort no longer re-spawns (it is a live /effort inject), so the preserve-across-respawn property is
  // now exercised via a dontAsk MODE re-spawn — it must still carry the selected agent forward.
  const fake = makeStartEngine();
  const { agent, sessionId, sessions } = await newSession(t, fake.startEngine);
  sessions[sessionId].interacted = true; // reach the resume re-spawn path, not the fresh pre-interaction one

  // Select the agent persona (its first re-spawn) and commit its currentValue.
  await setOption(agent, sessionId, "agent", "code-reviewer");
  assert.equal(
    agentCurrentValue(sessions, sessionId),
    "code-reviewer",
    "precondition: the agent change committed its currentValue",
  );

  const callsBeforeMode = fake.calls.length;
  // Now switch to a re-spawn mode (dontAsk) — this re-spawn must PRESERVE the agent (change.agent
  // undefined → currentAgent).
  await setOption(agent, sessionId, "mode", "dontAsk");

  assert.ok(fake.calls.length > callsBeforeMode, "the dontAsk change must trigger its own re-spawn");
  const respawn = fake.calls[fake.calls.length - 1];
  assert.equal(respawn.permissionMode, "dontAsk", "the mode re-spawn must carry the new permission mode");
  assert.equal(
    respawn.agent,
    "code-reviewer",
    "the mode re-spawn must PRESERVE the selected agent (respawnSession threads agent ?? currentAgent)",
  );
});
