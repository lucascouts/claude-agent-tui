// Story 046 / Task 4.4 — re-spawn in-place for dontAsk/bypassPermissions (R3.4, R3.7, R3.8).
//
// CONTRACT (story.md R3.4 / R3.7 / R3.8 + design.md §6c):
//   - Selecting `dontAsk` (a non-cyclable mode) WHILE idle re-spawns the SAME sessionId with a
//     flag-carrying resume argv, preserving the transcript — the session key is unchanged after the
//     switch (R3.4). (The flag-carrying resume argv ITSELF is pinned by permission-mode-spawn-flag.ts.)
//   - On a re-spawn FAILURE (no live PTY) the failure surfaces to the client, the prior `mode`
//     currentValue is left unchanged, and the session is not torn-down-without-replacement (R3.7).
//   - WHILE no injectable live PTY exists (re-spawn in progress / replay-only) selector changes are
//     deferred or rejected rather than written to a dead PTY (R3.8).
//
// AGENT INTEGRATION over fakes (gate-wiring precedent). The re-spawn mechanism is injected through the
// SAME `startEngine` seam createSession uses: a re-spawn calls startEngine again; a failing variant
// throws. node:test (build first): node --experimental-strip-types --test test/mode-respawn.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeAcpAgent } from "../dist/acp-agent.js";

function makeFakePty() {
  const writes: string[] = [];
  const exitCallbacks: Array<() => void> = [];
  const pty = {
    onExit: (cb: () => void) => {
      exitCallbacks.push(cb);
      return { dispose() {} };
    },
    onData: () => ({ dispose() {} }),
    resize: () => {},
    write: (s: string) => writes.push(s),
    kill: () => {},
  };
  return { pty: pty as never, writes, exitCallbacks };
}

function makeClient() {
  const client = {
    sessionUpdate: async () => {},
    requestPermission: async () => ({ outcome: { outcome: "selected", optionId: "allow" } }),
    readTextFile: async () => ({ content: "" }),
    writeTextFile: async () => ({}),
  } as never;
  return { client };
}

/** startEngine seam: the FIRST call is the createSession spawn; later calls are re-spawns. A re-spawn
 *  variant can be made to FAIL (R3.7) on the Nth call. Each call records the requested sessionId. */
function makeStartEngine(opts?: { failOnCall?: number }) {
  const calls: Array<{ sessionId?: string; resume?: boolean }> = [];
  const startEngine = (args: { sessionId?: string; cwd: string; resume?: boolean }) => {
    calls.push({ sessionId: args.sessionId, resume: args.resume });
    if (opts?.failOnCall && calls.length === opts.failOnCall) {
      throw new Error("re-spawn exploded");
    }
    return {
      sessionId: args.sessionId ?? "11111111-1111-4111-8111-111111111111",
      pty: makeFakePty().pty,
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
  const { client } = makeClient();
  const agent = new ClaudeAcpAgent(client, undefined, undefined, { startEngine: startEngine as never });
  t.after(() => agent.dispose());
  const response = await (agent as unknown as {
    createSession: (p: unknown) => Promise<{ sessionId: string }>;
  }).createSession({ cwd: "/work/dir", mcpServers: [] });
  const sessions = (agent as unknown as {
    sessions: Record<string, { configOptions: Array<{ id: string; currentValue?: unknown }>; modes: { currentModeId: string } }>;
  }).sessions;
  return { agent, sessionId: response.sessionId, sessions };
}

const setMode = (agent: ClaudeAcpAgent, sessionId: string, modeId: string) =>
  (agent as unknown as { setSessionMode: (p: { sessionId: string; modeId: string }) => Promise<unknown> })
    .setSessionMode({ sessionId, modeId });

const setOptionMode = (agent: ClaudeAcpAgent, sessionId: string, value: string) =>
  (agent as unknown as {
    setSessionConfigOption: (p: { sessionId: string; configId: string; value: string }) => Promise<unknown>;
  }).setSessionConfigOption({ sessionId, configId: "mode", value });

const modeCurrentValue = (
  sessions: Record<string, { configOptions: Array<{ id: string; currentValue?: unknown }> }>,
  id: string,
) => sessions[id].configOptions.find((o) => o.id === "mode")?.currentValue;

test("4.4 idle + dontAsk → re-spawns the SAME sessionId (key unchanged, transcript preserved) (R3.4)", async (t) => {
  const fake = makeStartEngine();
  const { agent, sessionId, sessions } = await newSession(t, fake.startEngine);
  await setMode(agent, sessionId, "dontAsk");
  assert.ok(sessions[sessionId], "the session must still be keyed under the SAME sessionId after re-spawn (R3.4)");
  assert.ok(
    fake.calls.length >= 2,
    `selecting dontAsk must trigger a re-spawn (a 2nd startEngine call), got ${fake.calls.length} calls`,
  );
  assert.equal(
    fake.calls[fake.calls.length - 1].sessionId,
    sessionId,
    "the re-spawn must reuse the SAME sessionId (R3.4)",
  );
});

test("Bug A: set_config_option(mode='dontAsk') re-spawns too — the path Zed uses must drive, not no-op", async (t) => {
  const fake = makeStartEngine();
  const { agent, sessionId } = await newSession(t, fake.startEngine);
  // Zed sends mode changes via set_config_option(configId:"mode"); this path was read-only (Bug A).
  await setOptionMode(agent, sessionId, "dontAsk");
  assert.ok(
    fake.calls.length >= 2,
    `set_config_option(mode='dontAsk') must trigger a re-spawn like setSessionMode (Bug A), got ${fake.calls.length} calls`,
  );
});

test("4.4 a re-spawn FAILURE surfaces the error and leaves the prior mode currentValue unchanged (R3.7)", async (t) => {
  // Fail on the 2nd startEngine call (the re-spawn). The createSession spawn (call 1) succeeds.
  const fake = makeStartEngine({ failOnCall: 2 });
  const { agent, sessionId, sessions } = await newSession(t, fake.startEngine);
  const before = modeCurrentValue(sessions, sessionId);
  await assert.rejects(
    setMode(agent, sessionId, "dontAsk"),
    "a re-spawn failure must surface to the client (R3.7)",
  );
  assert.equal(
    modeCurrentValue(sessions, sessionId),
    before,
    "a failed re-spawn must leave the prior mode currentValue unchanged (R3.7)",
  );
  assert.ok(
    sessions[sessionId],
    "a failed re-spawn must not leave the session torn-down-without-replacement (R3.7)",
  );
});
