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
    effortLevel?: string;
    agent?: string;
  }) => {
    calls.push({
      sessionId: args.sessionId,
      resume: args.resume,
      inPlaceRespawn: args.inPlaceRespawn,
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

test("3.4 pre-interaction agent change THROWS and does NOT swap the engine (R3.4 guard)", async (t) => {
  const fake = makeStartEngine();
  const { agent, sessionId, sessions } = await newSession(t, fake.startEngine);
  // session.interacted is falsy at fresh create — the re-spawn guard must refuse.
  const engineBefore = sessions[sessionId].engine;
  const callsBefore = fake.calls.length;

  await assert.rejects(
    setOption(agent, sessionId, "agent", "code-reviewer"),
    /before the first interaction/,
    "an agent change before the first interaction must throw the no-transcript-to-resume error",
  );
  assert.equal(
    fake.calls.length,
    callsBefore,
    "a refused re-spawn must NOT call startEngine (no new spawn)",
  );
  assert.equal(
    sessions[sessionId].engine,
    engineBefore,
    "a refused re-spawn must NOT swap the engine (session left intact)",
  );
});

test("3.4 an effort re-spawn PRESERVES the selected agent (and threads both flags) (R3.3/R3.4)", async (t) => {
  const fake = makeStartEngine();
  const { agent, sessionId, sessions } = await newSession(t, fake.startEngine);
  sessions[sessionId].interacted = true; // reach the re-spawn path, not the pre-interaction guard

  // Surface the effort option by selecting an effort-capable model (a /model inject, NOT a re-spawn).
  await setOption(agent, sessionId, "model", "sonnet");
  // Select the agent persona (its first re-spawn) and commit its currentValue.
  await setOption(agent, sessionId, "agent", "code-reviewer");
  assert.equal(
    agentCurrentValue(sessions, sessionId),
    "code-reviewer",
    "precondition: the agent change committed its currentValue",
  );

  const callsBeforeEffort = fake.calls.length;
  // Now change effort — this re-spawn must PRESERVE the agent (change.agent undefined → currentAgent).
  await setOption(agent, sessionId, "effort", "high");

  assert.ok(
    fake.calls.length > callsBeforeEffort,
    "the effort change must trigger its own re-spawn",
  );
  const respawn = fake.calls[fake.calls.length - 1];
  assert.equal(
    respawn.effortLevel,
    "high",
    "the effort re-spawn must carry the new effort level",
  );
  assert.equal(
    respawn.agent,
    "code-reviewer",
    "the effort re-spawn must PRESERVE the selected agent (respawnSession threads agent ?? currentAgent)",
  );
});
