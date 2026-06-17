// Story 046 / Task 2.3 — live model-switch injection (R1.2, R1.3, R1.4, R1.5, R4.2).
//
// CONTRACT (story.md R1.2–R1.5 / R4.2 + design.md §5):
//   - Selecting a resolvable model WHILE idle injects `/model <alias>` into the PTY as a side-channel
//     write (a `/model ...` command appears in the PTY's write stream) — R1.2.
//   - The injection is NOT routed through the prompt turn-resolver: it produces no turn, so no
//     `turnDetector` is set and the call resolves immediately (does not hang) — R1.4.
//   - WHILE a turn is in flight (`turnDetector` set) the injection is DEFERRED — no `/model` is written
//     to the PTY mid-turn — R1.3.
//   - An UNRESOLVABLE model value is rejected: no `/model` is injected and the model option's
//     `currentValue` is NOT updated — R1.5.
//   - On a resolvable apply the model option `currentValue` updates optimistically to the applied value
//     — R4.2.
//
// AGENT INTEGRATION over fakes (gate-wiring.test.ts precedent): a fake ACP client + a fake startEngine
// returning a fake PTY whose `write` calls are recorded. No claude is spawned, nothing bills. Tests
// drive the PUBLIC ACP surface (createSession → setSessionConfigOption) and assert observable behavior.
//
// node:test (build first): node --experimental-strip-types --test test/model-injection.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeAcpAgent } from "../dist/acp-agent.js";

/** A fake PTY recording every raw byte written (the injection surface). */
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
  const updates: Array<{ sessionUpdate?: string; [k: string]: unknown }> = [];
  const client = {
    sessionUpdate: async (u: { update: Record<string, unknown> }) => {
      updates.push(u.update as never);
    },
    requestPermission: async () => ({ outcome: { outcome: "selected", optionId: "allow" } }),
    readTextFile: async () => ({ content: "" }),
    writeTextFile: async () => ({}),
  } as never;
  return { client, updates };
}

function makeFakeStartEngine() {
  const fakePty = makeFakePty();
  const startEngine = (args: { sessionId?: string; cwd: string }) => ({
    sessionId: args.sessionId ?? "11111111-1111-4111-8111-111111111111",
    pty: fakePty.pty,
    watcher: { stop: () => {}, notifyEndOfTurn: () => {} },
    cwd: args.cwd,
  });
  return { startEngine, pty: fakePty };
}

async function newAgentSession(
  t: Parameters<NonNullable<Parameters<typeof test>[0]>>[0],
  extraDeps: Record<string, unknown> = {},
) {
  const { client, updates } = makeClient();
  const fake = makeFakeStartEngine();
  const agent = new ClaudeAcpAgent(client, undefined, undefined, {
    startEngine: fake.startEngine as never,
    ...extraDeps,
  });
  t.after(() => agent.dispose());
  const response = await (agent as unknown as {
    createSession: (p: unknown) => Promise<{ sessionId: string }>;
  }).createSession({ cwd: "/work/dir", mcpServers: [] });
  const sessions = (agent as unknown as {
    sessions: Record<string, { configOptions: Array<{ id: string; currentValue?: unknown }>; turnDetector?: unknown }>;
  }).sessions;
  return { agent, updates, writes: fake.pty.writes, sessionId: response.sessionId, sessions };
}

const setOption = (agent: ClaudeAcpAgent, sessionId: string, configId: string, value: string) =>
  (agent as unknown as {
    setSessionConfigOption: (p: { sessionId: string; configId: string; value: string }) => Promise<unknown>;
  }).setSessionConfigOption({ sessionId, configId, value });

const modelCurrentValue = (sessions: Record<string, { configOptions: Array<{ id: string; currentValue?: unknown }> }>, sessionId: string) =>
  sessions[sessionId].configOptions.find((o) => o.id === "model")?.currentValue;

test("2.3 idle + resolvable model → injects `/model <alias>` as a side-channel write (R1.2)", async (t) => {
  const { agent, sessionId, writes } = await newAgentSession(t);
  await setOption(agent, sessionId, "model", "sonnet");
  const joined = writes.join("");
  assert.ok(
    /\/model\s+sonnet/.test(joined),
    `expected a side-channel "/model sonnet" write to the PTY, got writes: ${JSON.stringify(writes)}`,
  );
});

test("2.3 the model injection resolves immediately and never sets turnDetector (R1.4 — not turn-routed)", async (t) => {
  const { agent, sessionId, sessions } = await newAgentSession(t);
  // If this were routed through prompt()/createTurnResolver it would hang forever (no stop_reason).
  await setOption(agent, sessionId, "model", "opus");
  assert.equal(
    sessions[sessionId].turnDetector,
    undefined,
    "a /model side-channel write must NOT arm a turnDetector (it produces no turn) — R1.4",
  );
});

test("2.3 a resolvable apply updates the model option currentValue optimistically (R4.2)", async (t) => {
  const { agent, sessionId, sessions } = await newAgentSession(t);
  await setOption(agent, sessionId, "model", "haiku");
  assert.equal(
    modelCurrentValue(sessions, sessionId),
    "haiku",
    "the model configOption currentValue must reflect the applied value optimistically (R4.2)",
  );
});

test("2.3 in-flight (turnDetector set) → the /model injection is DEFERRED, not written mid-turn (R1.3)", async (t) => {
  const { agent, sessionId, writes, sessions } = await newAgentSession(t);
  // Simulate a turn in flight: mark the session not-idle (design §5 idle-guard).
  sessions[sessionId].turnDetector = { observe() {}, noteActivity() {} } as never;
  await setOption(agent, sessionId, "model", "sonnet");
  const joined = writes.join("");
  assert.ok(
    !/\/model\s+sonnet/.test(joined),
    `a mid-turn model change must be queued, NOT written to the PTY (R1.3), got: ${JSON.stringify(writes)}`,
  );
});

test("hang-fix: a resolvable apply schedules a confirm Enter to accept the `Switch model?` dialog", async (t) => {
  // claude 2.1.176 opens a blocking "Switch model? 1.Yes/2.No" dialog mid-conversation; unconfirmed,
  // the next prompt's \r confirms it and is lost → 120 s stall (live 39a93bfc). The fix schedules ONE
  // Enter after the /model write. An immediate `schedule` runs it synchronously here.
  const { agent, sessionId, writes } = await newAgentSession(t, { schedule: (fn: () => void) => fn() });
  await setOption(agent, sessionId, "model", "sonnet");
  assert.ok(/\/model\s+sonnet/.test(writes.join("")), `expected the /model sonnet write, got: ${JSON.stringify(writes)}`);
  const enters = writes.filter((w) => w === "\r").length;
  assert.equal(
    enters,
    2,
    `expected a submit \\r + a dialog-confirm \\r (2 total), got ${enters}: ${JSON.stringify(writes)}`,
  );
  assert.equal(writes[writes.length - 1], "\r", "the dialog-confirm Enter must be the trailing write");
});

test("hang-fix: re-selecting the model the session is already on does NOT re-inject /model (same-model guard)", async (t) => {
  const { agent, sessionId, writes } = await newAgentSession(t, { schedule: (fn: () => void) => fn() });
  await setOption(agent, sessionId, "model", "sonnet"); // first switch → injects
  assert.ok(writes.join("").includes("/model"), "the first switch must inject /model");
  const afterFirst = writes.length;
  await setOption(agent, sessionId, "model", "sonnet"); // same model → guarded, no second injection
  const since = writes.slice(afterFirst).join("");
  assert.ok(
    !since.includes("/model"),
    `re-selecting the current model must not re-inject /model, got new writes: ${JSON.stringify(writes.slice(afterFirst))}`,
  );
});

test("2.3 an unresolvable model is rejected: no injection, no currentValue update (R1.5)", async (t) => {
  const { agent, sessionId, writes, sessions } = await newAgentSession(t);
  const before = modelCurrentValue(sessions, sessionId);
  await assert.rejects(
    setOption(agent, sessionId, "model", "no-such-model-xyz"),
    "an unresolvable alias must be rejected (R1.5)",
  );
  assert.ok(
    !writes.join("").includes("/model"),
    `no /model must be injected for an unresolvable alias (R1.5), got: ${JSON.stringify(writes)}`,
  );
  assert.equal(
    modelCurrentValue(sessions, sessionId),
    before,
    "the model currentValue must be unchanged after a rejected unresolvable alias (R1.5)",
  );
});
