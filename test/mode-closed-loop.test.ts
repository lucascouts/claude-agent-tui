// Story 046 / Task 4.3 — closed-loop Shift+Tab for cyclable permission modes (R3.3, R4.1).
//
// CONTRACT (story.md R3.3 + design.md §6b): selecting a cyclable mode (default/acceptEdits/plan, +auto
// when enabled) WHILE idle drives the TUI with RAW `\x1b[Z` (Shift+Tab) bytes — written directly to the
// PTY, NOT via `sendPrompt` (whose leading Ctrl+U `\x15` clear would corrupt the escape, design GOTCHA).
// The cycle reads the confirming `permission-mode` event from the transcript (never from `p.onData`),
// with a per-step Δt timeout that aborts rather than hangs. WHILE not idle, the change is deferred.
//
// This file pins the two robustly-observable invariants of the closed-loop write path: (1) a raw
// `\x1b[Z` is written for a cyclable-mode selection, and (2) the corrupting Ctrl+U clear is NEVER
// written on that path. The full feedback-loop convergence + Δt abort is exercised live in Run mode.
//
// AGENT INTEGRATION over fakes. To keep the closed loop from awaiting a (never-arriving) fake
// transcript event, the test supplies the confirming event through the injectable `getMessages` seam so
// the first step converges immediately. node:test (build first):
//   node --experimental-strip-types --test test/mode-closed-loop.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeAcpAgent } from "../dist/acp-agent.js";

const SHIFT_TAB = "\x1b[Z";
const CTRL_U = "\x15"; // sendPrompt's leading clear — must NEVER appear on the raw mode-cycle path

function makeFakePty() {
  const writes: string[] = [];
  const pty = {
    onExit: () => ({ dispose() {} }),
    onData: () => ({ dispose() {} }),
    resize: () => {},
    write: (s: string) => writes.push(s),
    kill: () => {},
  };
  return { pty: pty as never, writes };
}

/** A transcript permission-mode line confirming the target mode (so one Shift+Tab converges). */
function permissionModeMsg(mode: string) {
  return {
    uuid: `pm-${mode}`,
    type: "permission-mode",
    sessionId: "sess",
    parentUuid: null,
    isSidechain: false,
    permissionMode: mode,
    message: { role: "system", content: [] },
  };
}

function makeAgent(confirmMode: string) {
  const fake = makeFakePty();
  const client = {
    sessionUpdate: async () => {},
    requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    readTextFile: async () => ({ content: "" }),
    writeTextFile: async () => ({}),
  } as never;
  const startEngine = (args: { sessionId?: string; cwd: string }) => ({
    sessionId: args.sessionId ?? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    pty: fake.pty,
    watcher: { stop() {}, notifyEndOfTurn() {} },
    cwd: args.cwd,
  });
  // The transcript already shows the target mode → the first re-read confirms, so the loop converges
  // on a single step (no hang) and we can assert the raw byte it wrote.
  const getMessages = async () => [permissionModeMsg(confirmMode)] as never;
  const agent = new ClaudeAcpAgent(client, undefined, undefined, {
    startEngine: startEngine as never,
    getMessages,
  });
  return { agent, writes: fake.writes };
}

const setMode = (agent: ClaudeAcpAgent, sessionId: string, modeId: string) =>
  (agent as unknown as { setSessionMode: (p: { sessionId: string; modeId: string }) => Promise<unknown> })
    .setSessionMode({ sessionId, modeId });

async function freshSession(agent: ClaudeAcpAgent): Promise<string> {
  const r = await (agent as unknown as {
    createSession: (p: unknown) => Promise<{ sessionId: string }>;
  }).createSession({ cwd: "/work", mcpServers: [] });
  return r.sessionId;
}

test("4.3 selecting a cyclable mode while idle writes a RAW \\x1b[Z (Shift+Tab) to the PTY (R3.3)", async (t) => {
  const { agent, writes } = makeAgent("acceptEdits");
  t.after(() => agent.dispose());
  const sessionId = await freshSession(agent);

  await setMode(agent, sessionId, "acceptEdits");

  assert.ok(
    writes.some((w) => w.includes(SHIFT_TAB)),
    `a cyclable-mode change must write a raw \\x1b[Z to the PTY (R3.3), got: ${JSON.stringify(writes)}`,
  );
});

test("4.3 the closed-loop path NEVER writes the sendPrompt Ctrl+U clear (it would corrupt the escape)", async (t) => {
  const { agent, writes } = makeAgent("plan");
  t.after(() => agent.dispose());
  const sessionId = await freshSession(agent);

  await setMode(agent, sessionId, "plan");

  assert.ok(
    !writes.some((w) => w.includes(CTRL_U)),
    `the raw mode-cycle path must NOT emit the Ctrl+U clear (\\x15) — it corrupts \\x1b[Z, got: ${JSON.stringify(writes)}`,
  );
});
