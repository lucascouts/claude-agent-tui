// Story 055 / Task 2.3 — best-effort parent grouping + orphan → labelled relay (NEVER deny).
//
// This INVERTS the story-054 behavior (gate-subagent-decide.test.ts): an orphan/unresolved subagent
// tool USED to be a visible deny (gate-wiring.ts:414). 055 changes it to a bare, LABELLED relay — the
// dialog is raised under the inner tool_use id (no parent to attach to) with an attributed title, and
// the user's decision is enforced. Still gated, still prompted — never silently denied nor allowed.
//
// Two contracts (R2.3):
//   (a) parent present in sidechainParentMap → dialog attaches under the PARENT Task id;
//   (b) orphan/unresolved (parentId null OR no map entry) → a LABELLED dialog under the INNER id, and
//       the user's allow/deny is enforced — NOT a fail-closed deny-without-dialog.
// The label is sourced from the payload's agent_type (R2.1/R2.2), available at decide()-time.
//
// Authored RED-first by the Test Advisor from the contract + the existing gate-subagent-decide.test.ts
// harness (no ToDo). Harness: the REAL story-034 gate (loopback hook server + correlator + decide
// chain) over a fake ACP client + fake PTY. node:test (build first), cwd=fork/:
//   node --experimental-strip-types --test test/gate-subagent-orphan-relay.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ClaudeAcpAgent } from "../dist/acp-agent.js";
import { type SessionGate } from "../dist/permissions/gate-wiring.js";
import { ALLOW_OPTION_ID, type RequestPermissionParams } from "../dist/permissions/request-permission.js";
import { FORK_HOOK_MARKER_PATH } from "../dist/gate/settings-writer.js";

const SHORT_KNOBS = {
  correlationWaitMs: 250,
  correlationPollMs: 10,
  promptAppearMs: 50,
  promptPollMs: 5,
  injectTimeoutMs: 200,
  closeTimeoutMs: 1000,
};

/** POST a §9 payload; the path carries the per-session token when the gate exposes one. */
function post(port: number, body: string, token?: string): Promise<{ status: number; json: any }> {
  const p = token ? `${FORK_HOOK_MARKER_PATH}/${token}` : FORK_HOOK_MARKER_PATH;
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path: p, method: "POST", headers: { "content-type": "application/json" } },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, json: data ? JSON.parse(data) : null });
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

/** A subagent-internal §9 payload carrying agent_id/agent_type (the label source, R2.1). */
function subagentPayload(toolUseId: string, agentType = "general-purpose") {
  return JSON.stringify({
    session_id: "tui-side",
    transcript_path: "/tmp/x.jsonl",
    cwd: "/tmp",
    permission_mode: "default",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "whoami" },
    tool_use_id: toolUseId,
    agent_id: "agent_xyz",
    agent_type: agentType,
  });
}

function makeClient(decide: () => string) {
  const calls: RequestPermissionParams[] = [];
  const client = {
    sessionUpdate: async () => {},
    requestPermission: async (params: RequestPermissionParams) => {
      calls.push(params);
      return { outcome: { outcome: "selected", optionId: decide() } };
    },
    readTextFile: async () => ({ content: "" }),
    writeTextFile: async () => ({}),
  } as never;
  return { client, calls };
}

function makeFakeStartEngine() {
  return (args: { sessionId?: string; cwd: string; settingsFile?: string }) => ({
    sessionId: args.sessionId ?? "33333333-3333-4333-8333-333333333333",
    pty: { onExit: () => ({ dispose() {} }), onData: () => ({ dispose() {} }), resize() {}, write() {}, kill() {} } as never,
    watcher: { stop() {}, notifyEndOfTurn() {} },
    cwd: args.cwd,
  });
}

async function setup(t: any, decide: () => string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gate-subagent-orphan-relay-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const { client, calls } = makeClient(decide);
  const agent: any = new ClaudeAcpAgent(client, undefined, undefined, {
    startEngine: makeFakeStartEngine() as never,
    gate: true,
    gateOptions: { settingsDir: dir, ...SHORT_KNOBS },
  });
  t.after(() => agent.dispose());
  const r = await agent.createSession({ cwd: "/work", mcpServers: [] });
  const session = agent.sessions[r.sessionId] as {
    gate?: SessionGate & { token?: string };
    sidechainParentMap?: Map<string, { id: string; parentId: string | null; toolName: string; toolInput: unknown }>;
  };
  assert.ok(session.gate, "gate present");
  return { agent, calls, session, gate: session.gate! };
}

/** Seed the correlator as the pump would; optionally register a sidechain parent entry. */
function seed(
  session: { gate?: SessionGate; sidechainParentMap?: Map<string, any> },
  id: string,
  parentId: string | null | undefined,
) {
  session.gate!.correlator.register(id);
  if (parentId !== undefined) {
    session.sidechainParentMap = session.sidechainParentMap ?? new Map();
    session.sidechainParentMap.set(id, { id, parentId, toolName: "Bash", toolInput: { command: "whoami" } });
  }
}

test("055/2.3 (a) parent present → the labelled dialog attaches under the PARENT Task id", async (t) => {
  const { calls, gate, session } = await setup(t, () => ALLOW_OPTION_ID);
  seed(session, "toolu_inner_grouped", "toolu_task_1");

  const { json } = await post(gate.port, subagentPayload("toolu_inner_grouped"), gate.token);

  assert.equal(calls.length, 1, "a grouped subagent tool raises exactly one dialog");
  assert.equal(calls[0].toolCall.toolCallId, "toolu_task_1", "the dialog attaches under the parent Task id");
  assert.match(String(calls[0].toolCall.title ?? ""), /from the general-purpose agent/, "and is labelled from agent_type");
  assert.equal(json.hookSpecificOutput.permissionDecision, "allow", "the user's allow is enforced");
});

test("055/2.3 (b) an ORPHAN (parentId null) → a LABELLED relay under the INNER id, NOT a deny", async (t) => {
  const { calls, gate, session } = await setup(t, () => ALLOW_OPTION_ID);
  seed(session, "toolu_orphan_inner", null); // registered, but no real parent Task

  const { json } = await post(gate.port, subagentPayload("toolu_orphan_inner"), gate.token);

  assert.equal(calls.length, 1, "an orphan subagent tool now PROMPTS (055 inverts the 054 silent deny)");
  assert.equal(
    calls[0].toolCall.toolCallId,
    "toolu_orphan_inner",
    "with no parent, the labelled dialog keys on the INNER id",
  );
  assert.match(
    String(calls[0].toolCall.title ?? ""),
    /Bash · from the general-purpose agent/,
    "the orphan dialog is still attributed from agent_type",
  );
  assert.equal(
    json.hookSpecificOutput.permissionDecision,
    "allow",
    "the user's allow on the orphan prompt is enforced — never a silent deny",
  );
});

test("055/2.3 (b) an UNRESOLVED subagent (no map entry at all) → labelled relay under the inner id, not deny", async (t) => {
  const { calls, gate, session } = await setup(t, () => ALLOW_OPTION_ID);
  // The fast-subagent live case: the inner id correlates (seeded) but the pump never registered a parent.
  seed(session, "toolu_fast_inner", undefined);

  const { json } = await post(gate.port, subagentPayload("toolu_fast_inner"), gate.token);

  assert.equal(calls.length, 1, "an unresolved subagent tool still prompts (never silently denied)");
  assert.equal(calls[0].toolCall.toolCallId, "toolu_fast_inner", "the dialog keys on the inner id");
  assert.equal(json.hookSpecificOutput.permissionDecision, "allow", "the user's decision is enforced");
});
