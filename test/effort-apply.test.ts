// Story 046 / Task 3.2 — apply a reasoning-effort change (R2.2). AUTHORED IN RUN MODE: the apply
// mechanism was fixed by Probe B (1.2), whose verdict is RE-SPAWN — `claude --effort <level>` is a
// spawn flag with no live mid-session path. So this mirrors mode-respawn.test.ts (the dontAsk/bypass
// re-spawn) INCLUDING the R3.7 failure path (Reviewer N1): a failed effort re-spawn surfaces the error,
// leaves the prior effort currentValue unchanged, and does not tear the session down.
//
// The effort configOption only surfaces for an effort-capable model, so each test selects `sonnet`
// first (a live /model inject — NOT a re-spawn), then changes effort (the re-spawn under test).
// AGENT INTEGRATION over the startEngine seam (mode-respawn precedent). node:test (build first):
//   node --experimental-strip-types --test test/effort-apply.test.ts
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

/** startEngine seam: call 1 is the createSession spawn; a later call is the effort re-spawn. A variant
 *  FAILS (R3.7) on the Nth call. A model switch is an inject, NOT a startEngine call. */
function makeStartEngine(opts?: { failOnCall?: number }) {
  const calls: Array<{ sessionId?: string; resume?: boolean }> = [];
  const startEngine = (args: { sessionId?: string; cwd: string; resume?: boolean }) => {
    calls.push({ sessionId: args.sessionId, resume: args.resume });
    if (opts?.failOnCall && calls.length === opts.failOnCall) {
      throw new Error("effort re-spawn exploded");
    }
    return {
      sessionId: args.sessionId ?? "11111111-1111-4111-8111-111111111111",
      pty: makeFakePty(),
      watcher: { stop: () => {}, notifyEndOfTurn: () => {} },
      cwd: args.cwd,
    };
  };
  return { startEngine, calls };
}

async function newSession(
  t: Parameters<NonNullable<Parameters<typeof test>[0]>>[0],
  startEngine: unknown,
) {
  const agent = new ClaudeAcpAgent(makeClient(), undefined, undefined, { startEngine: startEngine as never });
  t.after(() => agent.dispose());
  const response = await (agent as unknown as {
    createSession: (p: unknown) => Promise<{ sessionId: string }>;
  }).createSession({ cwd: "/work/dir", mcpServers: [] });
  const sessions = (agent as unknown as {
    sessions: Record<string, { configOptions: Array<{ id: string; currentValue?: unknown }>; interacted?: boolean }>;
  }).sessions;
  return { agent, sessionId: response.sessionId, sessions };
}

const setOption = (agent: ClaudeAcpAgent, sessionId: string, configId: string, value: string) =>
  (agent as unknown as {
    setSessionConfigOption: (p: { sessionId: string; configId: string; value: string }) => Promise<unknown>;
  }).setSessionConfigOption({ sessionId, configId, value });

const effortCurrentValue = (
  sessions: Record<string, { configOptions: Array<{ id: string; currentValue?: unknown }> }>,
  id: string,
) => sessions[id].configOptions.find((o) => o.id === "effort")?.currentValue;

test("3.2 idle + effort change → re-spawns the SAME sessionId (R2.2, Probe-B re-spawn path)", async (t) => {
  const fake = makeStartEngine();
  const { agent, sessionId, sessions } = await newSession(t, fake.startEngine);
  sessions[sessionId].interacted = true; // R3.4 guard: a re-spawn is only allowed AFTER the first interaction
  // Surface the effort option by selecting an effort-capable model (a /model inject, NOT a re-spawn).
  await setOption(agent, sessionId, "model", "sonnet");
  const callsBeforeEffort = fake.calls.length;
  await setOption(agent, sessionId, "effort", "high");
  assert.ok(
    fake.calls.length > callsBeforeEffort,
    `an effort change must trigger a re-spawn (a new startEngine call), got ${fake.calls.length} (was ${callsBeforeEffort})`,
  );
  assert.equal(
    fake.calls[fake.calls.length - 1].sessionId,
    sessionId,
    "the effort re-spawn must reuse the SAME sessionId (transcript preserved)",
  );
});

test("3.2 an effort re-spawn FAILURE surfaces the error and leaves the prior currentValue unchanged (R3.7)", async (t) => {
  // call 1 = createSession spawn; the model switch is an inject (no startEngine call); the effort
  // re-spawn is call 2 → fail it.
  const fake = makeStartEngine({ failOnCall: 2 });
  const { agent, sessionId, sessions } = await newSession(t, fake.startEngine);
  sessions[sessionId].interacted = true; // R3.4 guard: reach the re-spawn (the failure under test), not the guard
  await setOption(agent, sessionId, "model", "sonnet");
  const before = effortCurrentValue(sessions, sessionId);
  await assert.rejects(
    setOption(agent, sessionId, "effort", "high"),
    "a failed effort re-spawn must surface to the client (R3.7)",
  );
  assert.equal(
    effortCurrentValue(sessions, sessionId),
    before,
    "a failed effort re-spawn must leave the prior effort currentValue unchanged (R3.7)",
  );
  assert.ok(
    sessions[sessionId],
    "a failed effort re-spawn must not leave the session torn-down-without-replacement (R3.7)",
  );
});

test("3.2 an effort no-op (same level) triggers no re-spawn (Unchanged Behavior 4)", async (t) => {
  const fake = makeStartEngine();
  const { agent, sessionId, sessions } = await newSession(t, fake.startEngine);
  await setOption(agent, sessionId, "model", "sonnet");
  const current = effortCurrentValue(sessions, sessionId);
  const callsBefore = fake.calls.length;
  await setOption(agent, sessionId, "effort", String(current));
  assert.equal(fake.calls.length, callsBefore, "selecting the current effort must NOT re-spawn (no-op)");
});
