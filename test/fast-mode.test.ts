// Story 073 — Fast Mode Toggle.
//
// A `fast` configOption (Off/On) is advertised AFTER the model selector, GATED on an Opus alias
// (`default`/`opus`) AND detected availability (the injectable FastModeProbe seam — production default
// fails closed). Setting it injects `/fast on|off` LIVE (mirroring the `/effort` seam — no re-spawn),
// and a switch to a non-Opus model turns it off + hides it.
//
// The real availability signal is characterized by the story-073 live spike (Task 1); these tests
// inject a fake probe to exercise the advertise/apply/reconcile paths hermetically.
//   node --experimental-strip-types --test test/fast-mode.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeAcpAgent, defaultFastModeProbe } from "../dist/acp-agent.js";
import { isFastModeCapableModel, FAST_MODE_MODELS } from "../dist/model-catalog.js";

// ---- Task 2 (R5.1) pure predicate --------------------------------------------------------------

test("R5.1 isFastModeCapableModel: true for default/opus, false for fable5/sonnet/haiku", () => {
  for (const v of ["default", "opus"]) {
    assert.ok(isFastModeCapableModel(v), `${v} must be fast-mode capable (Opus)`);
  }
  for (const v of ["fable5", "sonnet", "haiku"]) {
    assert.ok(!isFastModeCapableModel(v), `${v} must NOT be fast-mode capable (not Opus)`);
  }
  assert.deepEqual([...FAST_MODE_MODELS].sort(), ["default", "opus"], "the set is exactly {default,opus}");
});

test("R1.2 defaultFastModeProbe fails closed (returns false)", async () => {
  assert.equal(await defaultFastModeProbe({ pty: {} as never, cwd: "/x" }), false);
});

// ---- Harness (effort-apply precedent + injected fastModeProbe) ----------------------------------

function makeFakePty(writes: string[]) {
  return {
    onExit: () => ({ dispose() {} }),
    onData: () => ({ dispose() {} }),
    resize: () => {},
    write: (d: string) => {
      writes.push(d);
    },
    kill: () => {},
  } as never;
}

function makeClient() {
  return {
    sessionUpdate: async () => {},
    requestPermission: async () => ({ outcome: { outcome: "selected", optionId: "allow" } }),
    readTextFile: async () => ({ content: "" }),
    writeTextFile: async () => ({}),
  } as never;
}

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

/** Let the fire-and-forget refreshFastMode (createSession + model-switch reconcile) settle. */
const tick = () => new Promise((r) => setTimeout(r, 0));

type SessionShape = {
  configOptions: Array<{ id: string; currentValue?: unknown; options?: Array<{ value: string }> }>;
  fastModeOn?: boolean;
  fastModeAvailable?: boolean;
};

async function newSession(
  t: Parameters<NonNullable<Parameters<typeof test>[0]>>[0],
  startEngine: unknown,
  fastModeProbe: () => boolean | Promise<boolean>,
) {
  const agent = new ClaudeAcpAgent(makeClient(), undefined, undefined, {
    startEngine: startEngine as never,
    fastModeProbe: fastModeProbe as never,
  });
  t.after(() => agent.dispose());
  const response = await (
    agent as unknown as { createSession: (p: unknown) => Promise<{ sessionId: string }> }
  ).createSession({ cwd: "/work/dir", mcpServers: [] });
  await tick(); // the seed model is Opus → let the initial fast probe/advertise settle
  const sessions = (agent as unknown as { sessions: Record<string, SessionShape> }).sessions;
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

const fastOption = (sessions: Record<string, SessionShape>, id: string) =>
  sessions[id].configOptions.find((o) => o.id === "fast");

// ---- Task 4 (R2) advertisement + gating --------------------------------------------------------

test("R2.1 fast toggle surfaces (Off/On) AFTER the model selector on an Opus model when available", async (t) => {
  const fake = makeStartEngine();
  const { sessionId, sessions } = await newSession(t, fake.startEngine, () => true);
  const opts = sessions[sessionId].configOptions;
  const fast = opts.find((o) => o.id === "fast");
  assert.ok(fast, "fast option present on the seeded Opus `default` model");
  assert.equal((fast as { type?: string }).type, "select");
  assert.deepEqual((fast!.options ?? []).map((o) => o.value), ["off", "on"], "Off/On options");
  assert.equal(fast!.currentValue, "off", "defaults to off");
  const modelIdx = opts.findIndex((o) => o.id === "model");
  const fastIdx = opts.findIndex((o) => o.id === "fast");
  assert.ok(fastIdx > modelIdx, "the fast toggle is positioned AFTER the model selector");
});

test("R1.2 fast toggle ABSENT when the probe fails closed", async (t) => {
  const fake = makeStartEngine();
  const { sessionId, sessions } = await newSession(t, fake.startEngine, () => false);
  assert.equal(fastOption(sessions, sessionId), undefined, "no toggle when unavailable");
});

test("R2.2 fast toggle ABSENT on a non-Opus model even when available", async (t) => {
  const fake = makeStartEngine();
  const { agent, sessionId, sessions } = await newSession(t, fake.startEngine, () => true);
  await setOption(agent, sessionId, "model", "sonnet");
  await tick();
  assert.equal(fastOption(sessions, sessionId), undefined, "Sonnet (non-Opus) omits the toggle");
});

// ---- Task 5 (R3) live inject -------------------------------------------------------------------

test("R3.1 setting fast On injects `/fast on` live and reflects currentValue", async (t) => {
  const fake = makeStartEngine();
  const { agent, sessionId, sessions } = await newSession(t, fake.startEngine, () => true);
  fake.writes.length = 0;
  await setOption(agent, sessionId, "fast", "on");
  assert.match(fake.writes.join(""), /\/fast on/, "expected a live /fast on inject");
  assert.equal(fastOption(sessions, sessionId)!.currentValue, "on", "currentValue reflects On");
});

test("R3.1 toggling fast back to Off injects `/fast off`", async (t) => {
  const fake = makeStartEngine();
  const { agent, sessionId, sessions } = await newSession(t, fake.startEngine, () => true);
  await setOption(agent, sessionId, "fast", "on");
  fake.writes.length = 0;
  await setOption(agent, sessionId, "fast", "off");
  assert.match(fake.writes.join(""), /\/fast off/, "expected a live /fast off inject");
  assert.equal(fastOption(sessions, sessionId)!.currentValue, "off");
});

test("R3.3 a fast change does NOT re-spawn (no new startEngine call)", async (t) => {
  const fake = makeStartEngine();
  const { agent, sessionId } = await newSession(t, fake.startEngine, () => true);
  const before = fake.calls.length;
  await setOption(agent, sessionId, "fast", "on");
  assert.equal(fake.calls.length, before, "a /fast inject must not re-spawn the engine");
});

test("R3 a no-op fast change (already off) injects nothing", async (t) => {
  const fake = makeStartEngine();
  const { agent, sessionId } = await newSession(t, fake.startEngine, () => true);
  fake.writes.length = 0;
  await setOption(agent, sessionId, "fast", "off"); // already off
  assert.equal(fake.writes.join("").includes("/fast"), false, "no /fast write for a same-state select");
});

// ---- Task 6 (R4) reconciliation on model switch ------------------------------------------------

test("R4.1 switching Opus→non-Opus resets fast to off and omits the toggle", async (t) => {
  const fake = makeStartEngine();
  const { agent, sessionId, sessions } = await newSession(t, fake.startEngine, () => true);
  await setOption(agent, sessionId, "fast", "on"); // fast ON on Opus
  await setOption(agent, sessionId, "model", "sonnet");
  await tick();
  assert.equal(fastOption(sessions, sessionId), undefined, "toggle gone on Sonnet");
  assert.equal(sessions[sessionId].fastModeOn ?? false, false, "fast state reset to off");
});

test("R4.2 switching back to Opus re-probes and re-advertises the toggle as off", async (t) => {
  const fake = makeStartEngine();
  const { agent, sessionId, sessions } = await newSession(t, fake.startEngine, () => true);
  await setOption(agent, sessionId, "model", "sonnet");
  await tick();
  assert.equal(fastOption(sessions, sessionId), undefined, "gone on Sonnet");
  await setOption(agent, sessionId, "model", "opus");
  await tick();
  const fast = fastOption(sessions, sessionId);
  assert.ok(fast, "toggle re-advertised on return to Opus");
  assert.equal(fast!.currentValue, "off", "re-advertised as off (switching turned it off)");
});
