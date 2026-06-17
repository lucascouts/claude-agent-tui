// Story 046 / Task 5.1 — reconcile the `mode` configOption from transcript permission-mode events
// (R4.1, R4.2, R4.3).
//
// CONTRACT (story.md R4.1 / R4.2 / R4.3 + design.md §8): on a `permission-mode` transcript event the
// pump reconciles the `mode` configOption `currentValue` to the event's mode AND emits a
// `current_mode_update` EXACTLY ONCE (covers manual Shift+Tab, plan-approval, re-spawn). The `model`
// and `effort` options have NO transcript drift event — their currentValue is optimistic-on-apply only
// (R4.3, documented), so a permission-mode event must NOT touch them.
//
// The reconcile reads the transcript via the injectable `getMessages` seam (precedent:
// pump-tail-source.test.ts). A `permission-mode` line carries `type:"permission-mode"` +
// `permissionMode:"<mode>"` (corpus-all-types.jsonl shape). node:test (build first):
//   node --experimental-strip-types --test test/mode-reconcile.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeAcpAgent } from "../dist/acp-agent.js";

function makeAgent(messages: unknown[]) {
  const captured: Array<{ update: { sessionUpdate?: string; currentModeId?: string } }> = [];
  const client = {
    sessionUpdate: async (n: { update: { sessionUpdate?: string; currentModeId?: string } }) => {
      captured.push(n);
    },
    requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    readTextFile: async () => ({ content: "" }),
    writeTextFile: async () => ({}),
  } as never;
  const fakeStartEngine = (args: { sessionId?: string; cwd: string }) => ({
    sessionId: args.sessionId ?? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    pty: {
      onExit: () => ({ dispose() {} }),
      onData: () => ({ dispose() {} }),
      resize() {},
      write() {},
      kill() {},
    } as never,
    watcher: { stop() {}, notifyEndOfTurn() {} },
    cwd: args.cwd,
  });
  const getMessages = async () => messages as never;
  const agent = new ClaudeAcpAgent(client, undefined, undefined, {
    startEngine: fakeStartEngine as never,
    getMessages,
  });
  return { agent, captured };
}

/** A transcript permission-mode line (corpus-all-types.jsonl shape) announcing a mode change. */
function permissionModeMsg(uuid: string, mode: string) {
  return {
    uuid,
    type: "permission-mode",
    sessionId: "sess",
    parentUuid: null,
    isSidechain: false,
    permissionMode: mode,
    message: { role: "system", content: [] },
  };
}

const modeCurrentValue = (agent: ClaudeAcpAgent, sessionId: string) =>
  (agent as unknown as {
    sessions: Record<string, { configOptions: Array<{ id: string; currentValue?: unknown }> }>;
  }).sessions[sessionId].configOptions.find((o) => o.id === "mode")?.currentValue;

async function freshSession(agent: ClaudeAcpAgent): Promise<string> {
  const r = await (agent as unknown as {
    createSession: (p: unknown) => Promise<{ sessionId: string }>;
  }).createSession({ cwd: "/work", mcpServers: [] });
  return r.sessionId;
}

const pump = (agent: ClaudeAcpAgent, sessionId: string) =>
  (agent as unknown as { pumpUpdates: (id: string) => Promise<void> }).pumpUpdates(sessionId);

test("5.1 a transcript permission-mode event reconciles the mode currentValue (R4.1)", async (t) => {
  const { agent } = makeAgent([permissionModeMsg("p1", "acceptEdits")]);
  t.after(() => agent.dispose());
  const sessionId = await freshSession(agent);

  await pump(agent, sessionId);

  assert.equal(
    modeCurrentValue(agent, sessionId),
    "acceptEdits",
    "the mode configOption currentValue must reconcile to the transcript permission-mode (R4.1)",
  );
});

test("5.1 a permission-mode event emits current_mode_update EXACTLY ONCE (R4.1 — no duplicate)", async (t) => {
  const { agent, captured } = makeAgent([permissionModeMsg("p1", "plan")]);
  t.after(() => agent.dispose());
  const sessionId = await freshSession(agent);

  await pump(agent, sessionId);

  const modeUpdates = captured.filter((n) => n.update.sessionUpdate === "current_mode_update");
  assert.equal(
    modeUpdates.length,
    1,
    `exactly one current_mode_update must be emitted for one permission-mode event (R4.1), got ${modeUpdates.length}`,
  );
  assert.equal(modeUpdates[0].update.currentModeId, "plan", "the emitted update carries the new mode");
});

test("5.1 no spurious current_mode_update when the transcript carries no permission-mode event", async (t) => {
  const { agent, captured } = makeAgent([
    { uuid: "u1", type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } },
  ]);
  t.after(() => agent.dispose());
  const sessionId = await freshSession(agent);

  await pump(agent, sessionId);

  const modeUpdates = captured.filter((n) => n.update.sessionUpdate === "current_mode_update");
  assert.equal(modeUpdates.length, 0, "no permission-mode event → no current_mode_update (no spurious emit)");
});
