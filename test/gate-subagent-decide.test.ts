// Story 054 / Task 4.1 — the gate's decide() looks up the inner id in the session's
// sidechainParentMap: a subagent tool whose inner id has a parent RAISES a permission dialog carrying
// the PARENT Task id; an ORPHAN (parentId === null) does NOT raise against a bogus id (falls through
// to the R4 visible deny).
//
// Contract (design.md fix step 4 + "Orphan parent" note). Verifies the BUG: before the fix a subagent
// tool_use is never correlated → silent timeout deny, no dialog.
//
// Harness: the REAL story-034 gate (loopback hook server + correlator + decide chain) over a fake ACP
// client + fake PTY; we seed `session.sidechainParentMap` + the correlator as the pump would (story
// 054 task 2.1), then POST a PreToolUse payload for the inner id (how claude calls the hook).
// node:test (build first):
//   node --experimental-strip-types --test test/gate-subagent-decide.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ClaudeAcpAgent } from "../dist/acp-agent.js";
import { type SessionGate } from "../dist/permissions/gate-wiring.js";
import { ALLOW_OPTION_ID, DENY_OPTION_ID, type RequestPermissionParams } from "../dist/permissions/request-permission.js";
import { FORK_HOOK_MARKER_PATH } from "../dist/gate/settings-writer.js";

const SHORT_KNOBS = {
  correlationWaitMs: 250,
  correlationPollMs: 10,
  promptAppearMs: 50,
  promptPollMs: 5,
  injectTimeoutMs: 200,
  closeTimeoutMs: 1000,
};

function post(port: number, body: string, token?: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path: token ? `${FORK_HOOK_MARKER_PATH}/${token}` : FORK_HOOK_MARKER_PATH, method: "POST", headers: { "content-type": "application/json" } },
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

function payload(toolUseId: string, toolName = "Bash", toolInput: unknown = { command: "ls" }, permissionMode = "default") {
  return JSON.stringify({
    session_id: "tui-side",
    transcript_path: "/tmp/x.jsonl",
    cwd: "/tmp",
    permission_mode: permissionMode,
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: toolUseId,
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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gate-subagent-decide-test-"));
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
    gate?: SessionGate;
    registeredSidechain?: Set<string>;
    sidechainParentMap?: Map<string, { id: string; parentId: string | null; toolName: string; toolInput: unknown }>;
  };
  assert.ok(session.gate, "gate present");
  return { agent, calls, sessionId: r.sessionId, session, gate: session.gate! };
}

/** Simulate the pump (task 2.1) having registered a sidechain inner tool_use under a parent. */
function seedSidechain(
  session: { gate?: SessionGate; sidechainParentMap?: Map<string, any> },
  use: { id: string; parentId: string | null; toolName: string; toolInput: unknown },
) {
  session.gate!.correlator.register(use.id);
  session.sidechainParentMap = session.sidechainParentMap ?? new Map();
  session.sidechainParentMap.set(use.id, use);
}

test("4.1 a subagent inner tool RAISES a dialog carrying the PARENT Task id (the bug fix)", async (t) => {
  const { calls, gate, session } = await setup(t, () => ALLOW_OPTION_ID);
  seedSidechain(session, {
    id: "toolu_inner_bash",
    parentId: "toolu_task_1",
    toolName: "Bash",
    toolInput: { command: "ls" },
  });

  const { json } = await post(gate.port, payload("toolu_inner_bash"), gate.token);

  assert.equal(calls.length, 1, "a subagent tool now raises EXACTLY one Zed dialog (before the fix: zero)");
  assert.equal(
    calls[0].toolCall.toolCallId,
    "toolu_task_1",
    "the dialog attaches to the PARENT Task id Zed rendered (R2), not the inner id",
  );
  assert.match(String(calls[0].toolCall.title ?? ""), /Bash/, "the title names the inner subagent tool");
  assert.equal(json.hookSpecificOutput.permissionDecision, "allow", "the user's allow is enforced on the inner tool");
});

test("4.1 (055-inverted) an ORPHAN subagent (parentId null) relays a LABELLED dialog under the INNER id — never a deny", async (t) => {
  // STORY 055 (R2.3) INVERTS the story-054 behavior: an orphan subagent tool USED to be a silent deny
  // (no dialog). It is now a bare, LABELLED relay — the dialog is raised under the INNER tool_use id
  // (no parent to attach to) and the user's decision is enforced. Still gated, still prompted.
  const { calls, gate, session } = await setup(t, () => ALLOW_OPTION_ID);
  // The pump saw the inner id but its parent was never a real Task (parentId null = orphan).
  seedSidechain(session, {
    id: "toolu_orphan_inner",
    parentId: null,
    toolName: "Bash",
    toolInput: { command: "whoami" },
  });

  const { json } = await post(gate.port, payload("toolu_orphan_inner"), gate.token);

  assert.equal(calls.length, 1, "an orphan subagent tool now PROMPTS (055 inverts the 054 silent deny)");
  assert.equal(
    calls[0].toolCall.toolCallId,
    "toolu_orphan_inner",
    "with no parent, the labelled dialog keys on the INNER tool_use id",
  );
  assert.equal(
    json.hookSpecificOutput.permissionDecision,
    "allow",
    "the user's allow on the orphan prompt is enforced — never a silent deny",
  );
});

test("4.1 a MAIN-CHAIN tool still raises under its OWN id (no sidechain entry) — parity unchanged (U1)", async (t) => {
  const { calls, gate } = await setup(t, () => DENY_OPTION_ID);
  gate.correlator.register("toolu_main"); // main-chain feed, no sidechainParentMap entry

  const { json } = await post(gate.port, payload("toolu_main", "Write", { file_path: "/p", content: "x" }), gate.token);

  assert.equal(calls.length, 1, "a main-chain tool still prompts");
  assert.equal(calls[0].toolCall.toolCallId, "toolu_main", "main-chain dialog keys on its own id (no parent re-target)");
  assert.equal(json.hookSpecificOutput.permissionDecision, "deny", "the user's deny is enforced");
});
