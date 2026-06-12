// Story 023 / Group 1 (sub-task 1.2) — createSession wires the JSONL watcher and stores a handle
// holding pty + watcher + emitted(Set). Integration: with an injected fake startEngine resolving a
// fixture transcript within the file-discovery watchdog, assert the stored per-session handle holds
// `pty`, `watcher`, and an `emitted` Set.
// node:test runner: `node --experimental-strip-types --test test/createSession-watcher.test.ts`
// (run `npm run build` first — behavioral imports resolve against ../dist).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeAcpAgent } from "../dist/acp-agent.js";

function makeClient() {
  return {
    sessionUpdate: async () => {},
    requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    readTextFile: async () => ({ content: "" }),
    writeTextFile: async () => ({}),
  } as never;
}

function makeFakePty() {
  return {
    onExit: () => ({ dispose() {} }),
    onData: () => ({ dispose() {} }),
    resize: () => {},
    write: () => {},
    kill: () => {},
    __isFakePty: true,
  } as never;
}

/** Fake startEngine: returns a sentinel pty + a watcher, plus the discovered cwd from "inside" the JSONL. */
function makeFakeStartEngine() {
  const pty = makeFakePty();
  let watcherStarted = false;
  const watcher = {
    stop: () => {},
    notifyEndOfTurn: () => {},
    __isFakeWatcher: true,
  };
  const startEngine = (args: { sessionId?: string; cwd: string }) => {
    watcherStarted = true;
    return {
      sessionId: args.sessionId ?? "22222222-2222-4222-8222-222222222222",
      pty,
      watcher,
      cwd: "/runtime/cwd/from/inside/jsonl",
    };
  };
  return { startEngine, pty, watcher, watcherStarted: () => watcherStarted };
}

test("createSession stores a per-session handle holding pty + watcher + emitted(Set)", async (t) => {
  const fake = makeFakeStartEngine();
  const agent = new ClaudeAcpAgent(makeClient(), undefined, undefined, {
    startEngine: fake.startEngine,
  });
  t.after(() => agent.dispose());

  const response = (await (agent as unknown as {
    createSession: (p: unknown, o?: unknown) => Promise<{ sessionId: string }>;
  }).createSession({ cwd: "/host", mcpServers: [] }));

  const session = (agent as unknown as {
    sessions: Record<string, { pty?: unknown; watcher?: unknown; emitted?: unknown }>;
  }).sessions[response.sessionId];

  assert.ok(session, "the session record is stored");
  assert.equal(session.pty, fake.pty, "the handle holds the spawned PTY");
  assert.equal(session.watcher, fake.watcher, "the handle holds the started JSONL watcher");
  assert.ok(session.emitted instanceof Set, "the handle holds an `emitted` Set (uuids dedupe guard)");
  assert.ok(fake.watcherStarted(), "the watcher was started during createSession");
});

test("createSession adopts the runtime cwd discovered from inside the JSONL transcript", async (t) => {
  const fake = makeFakeStartEngine();
  const agent = new ClaudeAcpAgent(makeClient(), undefined, undefined, {
    startEngine: fake.startEngine,
  });
  t.after(() => agent.dispose());

  const response = (await (agent as unknown as {
    createSession: (p: unknown, o?: unknown) => Promise<{ sessionId: string }>;
  }).createSession({ cwd: "/host", mcpServers: [] }));

  const session = (agent as unknown as {
    sessions: Record<string, { cwd?: string }>;
  }).sessions[response.sessionId];

  assert.equal(
    session.cwd,
    "/runtime/cwd/from/inside/jsonl",
    "the session cwd is read from inside the JSONL (not decoded from the dir name)",
  );
});
