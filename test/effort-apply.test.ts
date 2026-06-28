// Story 046 / Task 3.2 + Story 056 v4 — apply a reasoning-effort change (R2.2).
//
// SUPERSEDED MECHANISM: the 046 Probe-B verdict was RE-SPAWN (`--effort` was a spawn flag with no live
// path). claude 2.1.195 DOES have a live `/effort <level>` local TUI command (LIVE-VERIFIED), so effort
// now mirrors the `/model` inject: a side-channel PTY write, NO re-spawn, NO turn — which means it also
// applies BEFORE the first interaction (the re-spawn's --resume idle-guard was why effort silently
// failed pre-first-prompt). This file now asserts the inject (not a startEngine re-spawn call).
//
// The effort configOption only surfaces for an effort-capable model, so each test selects `sonnet`
// first (a live /model inject), then changes effort (the /effort inject under test).
//   node --experimental-strip-types --test test/effort-apply.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeAcpAgent } from "../dist/acp-agent.js";

/** A fake PTY that CAPTURES every `write` into the shared `writes` array (so the inject is observable). */
function makeFakePty(writes: string[]) {
  const pty = {
    onExit: () => ({ dispose() {} }),
    onData: () => ({ dispose() {} }),
    resize: () => {},
    write: (d: string) => {
      writes.push(d);
    },
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

/** startEngine seam: call 1 is the createSession spawn. Effort no longer re-spawns, so any 2nd call
 *  would be a regression. All PTYs share one `writes` array so side-channel injects are observable. */
function makeStartEngine() {
  const calls: Array<{ sessionId?: string; resume?: boolean }> = [];
  const writes: string[] = [];
  const startEngine = (args: { sessionId?: string; cwd: string; resume?: boolean }) => {
    calls.push({ sessionId: args.sessionId, resume: args.resume });
    return {
      sessionId: args.sessionId ?? "11111111-1111-4111-8111-111111111111",
      pty: makeFakePty(writes),
      watcher: { stop: () => {}, notifyEndOfTurn: () => {} },
      cwd: args.cwd,
    };
  };
  return { startEngine, calls, writes };
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

test("v4 effort change INJECTS `/effort <level>` live — no re-spawn, works BEFORE the first interaction", async (t) => {
  const fake = makeStartEngine();
  const { agent, sessionId, sessions } = await newSession(t, fake.startEngine);
  // NOTE: `interacted` is deliberately NOT set — this is the pre-first-prompt case that used to fail
  // silently under the re-spawn idle-guard (the live bug the user hit).
  await setOption(agent, sessionId, "model", "sonnet"); // surface the effort option (a /model inject)
  // The effort is seeded from the machine's real settings, so pick a level GUARANTEED to differ from it
  // (else the no-op short-circuit fires and nothing injects — a test-hermeticity, not a code, issue).
  const start = String(effortCurrentValue(sessions, sessionId));
  const target = start === "low" ? "high" : "low";
  const callsBeforeEffort = fake.calls.length;
  fake.writes.length = 0; // drop the /model write — assert only the effort inject below

  await setOption(agent, sessionId, "effort", target);

  assert.equal(
    fake.calls.length,
    callsBeforeEffort,
    "an effort change must NOT re-spawn (no new startEngine call) — it is a live /effort inject",
  );
  assert.match(
    fake.writes.join(""),
    new RegExp(`/effort ${target}`),
    `expected a live /effort ${target} inject in the PTY writes, got: ${JSON.stringify(fake.writes.join(""))}`,
  );
  assert.equal(
    effortCurrentValue(sessions, sessionId),
    target,
    "the effort currentValue must reflect the new level (optimistic, like /model)",
  );
});

test("v4 an effort no-op (same level) injects NO `/effort` command (Unchanged Behavior)", async (t) => {
  const fake = makeStartEngine();
  const { agent, sessionId, sessions } = await newSession(t, fake.startEngine);
  await setOption(agent, sessionId, "model", "sonnet");
  const current = String(effortCurrentValue(sessions, sessionId));
  fake.writes.length = 0;

  await setOption(agent, sessionId, "effort", current);

  assert.ok(
    !fake.writes.join("").includes("/effort"),
    `selecting the already-current effort must inject nothing (no-op), got: ${JSON.stringify(fake.writes.join(""))}`,
  );
});

test("v4 the `/effort` inject does not introduce any -p/--print/stream-json (billing seam intact)", async (t) => {
  const fake = makeStartEngine();
  const { agent, sessionId, sessions } = await newSession(t, fake.startEngine);
  await setOption(agent, sessionId, "model", "sonnet");
  const start = String(effortCurrentValue(sessions, sessionId));
  const target = start === "max" ? "low" : "max"; // a level guaranteed to differ → a real inject
  fake.writes.length = 0;
  await setOption(agent, sessionId, "effort", target);
  const all = fake.writes.join("");
  assert.ok(!/--print|stream-json|(^|\s)-p(\s|$)/.test(all), `effort inject must carry no credit token: ${JSON.stringify(all)}`);
});
