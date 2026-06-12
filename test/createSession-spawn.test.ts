// Story 023 / Group 1 (sub-tasks 1.1+1.2) — createSession rewrite: PTY engine, NOT the SDK query().
// Integration: construct the agent with an injected fake engine-start + fake getMessages, call the
// session-creation entry, assert it returns a sessionId, that it invoked the injected spawn (PTY
// engine started), and that the createSession source references NO SDK `query(` / `claudeCliPath`.
// node:test runner: `node --experimental-strip-types --test test/createSession-spawn.test.ts`
// (run `npm run build` first — behavioral imports resolve against ../dist).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ClaudeAcpAgent } from "../dist/acp-agent.js";

const here = dirname(fileURLToPath(import.meta.url));
const ACP_AGENT_SRC = join(here, "..", "src", "acp-agent.ts");

// RFC-4122 v4 (the shape randomUUID() emits).
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Minimal ACP client stub — every method the agent may call on construction/createSession. */
function makeClient() {
  return {
    sessionUpdate: async () => {},
    requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    readTextFile: async () => ({ content: "" }),
    writeTextFile: async () => ({}),
  } as never;
}

/** A fake PTY: records nothing of substance, just satisfies the handle shape used by createSession. */
function makeFakePty() {
  return {
    onExit: () => ({ dispose() {} }),
    onData: () => ({ dispose() {} }),
    resize: () => {},
    write: () => {},
    kill: () => {},
  } as never;
}

/**
 * Build an injected `startEngine` seam that records each invocation and returns a fake handle.
 * Mirrors the production default's return contract: { sessionId, pty, watcher, cwd }.
 */
function makeFakeStartEngine(opts?: { cwd?: string }) {
  const calls: Array<{ sessionId: string | undefined; cwd: string; resume: boolean }> = [];
  let stopped = 0;
  const startEngine = (args: { sessionId?: string; cwd: string; resume?: boolean }) => {
    const sessionId = args.sessionId ?? "11111111-1111-4111-8111-111111111111";
    calls.push({ sessionId: args.sessionId, cwd: args.cwd, resume: !!args.resume });
    return {
      sessionId,
      pty: makeFakePty(),
      watcher: { stop: () => { stopped++; }, notifyEndOfTurn: () => {} },
      cwd: opts?.cwd ?? args.cwd,
    };
  };
  return { startEngine, calls, stopCount: () => stopped };
}

test("createSession returns a sessionId and starts the PTY engine via the injected seam (NOT the SDK)", async (t) => {
  const fake = makeFakeStartEngine();
  const agent = new ClaudeAcpAgent(makeClient(), undefined, undefined, {
    startEngine: fake.startEngine,
  });
  t.after(() => agent.dispose());

  const response = await (agent as unknown as {
    createSession: (p: unknown, o?: unknown) => Promise<{ sessionId: string }>;
  }).createSession({ cwd: "/work/dir", mcpServers: [] });

  assert.ok(response.sessionId, "createSession must return a sessionId");
  assert.match(response.sessionId, UUID_V4, "the sessionId is a v4 uuid");
  assert.equal(fake.calls.length, 1, "the injected startEngine (PTY spawn) was invoked exactly once");
  assert.equal(fake.calls[0].cwd, "/work/dir", "the engine spawns in the requested host cwd");
});

test("createSession returns the ACP NewSessionResponse shape (sessionId + models + modes + configOptions)", async (t) => {
  const fake = makeFakeStartEngine();
  const agent = new ClaudeAcpAgent(makeClient(), undefined, undefined, {
    startEngine: fake.startEngine,
  });
  t.after(() => agent.dispose());

  const response = (await (agent as unknown as {
    createSession: (p: unknown, o?: unknown) => Promise<unknown>;
  }).createSession({ cwd: "/work", mcpServers: [] })) as {
    sessionId: string;
    models: { availableModels: unknown[]; currentModelId: string };
    modes: { availableModes: unknown[]; currentModeId: string };
    configOptions: unknown[];
  };

  assert.ok(response.models, "models present");
  assert.ok(Array.isArray(response.models.availableModels), "models.availableModels is an array");
  assert.ok(response.models.currentModelId, "a current model id is set");
  assert.ok(response.modes, "modes present");
  assert.equal(response.modes.currentModeId, "default", "the static Degrau-1 default mode is `default`");
  assert.ok(Array.isArray(response.configOptions), "configOptions is an array");
});

test("a fresh session adopts the engine's spawn-generated sessionId as its key", async (t) => {
  const fake = makeFakeStartEngine();
  const agent = new ClaudeAcpAgent(makeClient(), undefined, undefined, {
    startEngine: fake.startEngine,
  });
  t.after(() => agent.dispose());

  const response = (await (agent as unknown as {
    createSession: (p: unknown, o?: unknown) => Promise<{ sessionId: string }>;
  }).createSession({ cwd: "/work", mcpServers: [] }));

  const sessions = (agent as unknown as { sessions: Record<string, unknown> }).sessions;
  assert.ok(sessions[response.sessionId], "the stored session is keyed by the returned sessionId");
});

test("createSession source references NO SDK query()/getAvailableModels/claudeCliPath in its body", () => {
  const src = readFileSync(ACP_AGENT_SRC, "utf8");
  // Slice the createSession method body: from its declaration to the start of the next private method.
  const startIdx = src.indexOf("private async createSession(");
  assert.ok(startIdx >= 0, "createSession method found in source");
  // The method ends at the closing of the class member; bound the slice at the next top-level
  // function declaration after the class (`function shouldEmitRawMessage`) to be safe.
  const endMarker = "function shouldEmitRawMessage(";
  const endIdx = src.indexOf(endMarker, startIdx);
  const body = src.slice(startIdx, endIdx >= 0 ? endIdx : undefined);

  assert.ok(!/\bquery\s*\(/.test(body), "createSession must not call the SDK query()");
  assert.ok(!/\bgetAvailableModels\s*\(/.test(body), "createSession must not call getAvailableModels()");
  assert.ok(!/\bq\./.test(body), "createSession must not reference the SDK query handle `q.`");
  assert.ok(!/resolveClaudePath|claudeCliPath/.test(body), "createSession must not resolve the claude CLI path");
  assert.ok(!/pathToClaudeCodeExecutable/.test(body), "createSession must not pass pathToClaudeCodeExecutable");
});
