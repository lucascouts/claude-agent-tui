// Story 054 / Task 4.3 — fail-loud fallback + parity (R4, U1, U4):
//   - an uncorrelatable / orphan SUBAGENT tool yields a VISIBLE/LOGGED deny that NAMES the subagent +
//     inner tool (never a silent timeout, and never a generic main-chain warning);
//   - a main-chain tool still correlates + raises unchanged (U1);
//   - bypassPermissions / acceptEdits auto-allow subagent tools WITHOUT a dialog (U4).
//
// Contract (design.md fix step 4 "on expiry → visible deny via onWarn naming the subagent + inner
// tool"; "Orphan parent → fall through to the visible deny (R4)"; U4 mode parity).
//
// CAPTURE NOTE: the agent wires the gate's warning surface to `this.logger.error` (acp-agent.ts:2559
// `onWarn: (m) => this.logger.error(m)`) and IGNORES `gateOptions.onWarn` (typed Omit<…,"onWarn">).
// So the R4 "visible deny" is observed by injecting a capturing Logger as the 2nd constructor arg —
// NOT via gateOptions.onWarn. node:test (build first):
//   node --experimental-strip-types --test test/gate-subagent-fallback.test.ts
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
  correlationWaitMs: 200,
  correlationPollMs: 10,
  promptAppearMs: 50,
  promptPollMs: 5,
  injectTimeoutMs: 200,
  closeTimeoutMs: 1000,
};

function post(port: number, body: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path: FORK_HOOK_MARKER_PATH, method: "POST", headers: { "content-type": "application/json" } },
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

async function setup(t: any, decide: () => string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gate-subagent-fallback-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const calls: RequestPermissionParams[] = [];
  // The R4 "visible deny" surface is the agent's logger (onWarn → this.logger.error). Capture it.
  const errors: string[] = [];
  const logger = { log: () => {}, error: (...a: any[]) => errors.push(a.map(String).join(" ")) };
  const client = {
    sessionUpdate: async () => {},
    requestPermission: async (params: RequestPermissionParams) => {
      calls.push(params);
      return { outcome: { outcome: "selected", optionId: decide() } };
    },
    readTextFile: async () => ({ content: "" }),
    writeTextFile: async () => ({}),
  } as never;
  const agent: any = new ClaudeAcpAgent(client, logger as never, undefined, {
    startEngine: ((args: { sessionId?: string; cwd: string }) => ({
      sessionId: args.sessionId ?? "55555555-5555-4555-8555-555555555555",
      pty: { onExit: () => ({ dispose() {} }), onData: () => ({ dispose() {} }), resize() {}, write() {}, kill() {} } as never,
      watcher: { stop() {}, notifyEndOfTurn() {} },
      cwd: args.cwd,
    })) as never,
    gate: true,
    gateOptions: { settingsDir: dir, ...SHORT_KNOBS },
  });
  t.after(() => agent.dispose());
  const r = await agent.createSession({ cwd: "/work", mcpServers: [] });
  const session = agent.sessions[r.sessionId] as { gate?: SessionGate; sidechainParentMap?: Map<string, any> };
  assert.ok(session.gate, "gate present");
  return { calls, errors, session, gate: session.gate! };
}

test("4.3 an ORPHAN subagent tool yields a LOGGED visible deny NAMING the subagent + inner tool (R4)", async (t) => {
  const { calls, errors, session, gate } = await setup(t, () => ALLOW_OPTION_ID);
  // The pump saw the inner id but its parent was never a real Task (parentId null = orphan). The gate
  // KNOWS it is a subagent (parentMap entry) → the visible deny must name the subagent + inner tool.
  gate.correlator.register("toolu_orphan_inner");
  session.sidechainParentMap = new Map([
    [
      "toolu_orphan_inner",
      { id: "toolu_orphan_inner", parentId: null, toolName: "Bash", toolInput: { command: "whoami" }, subagentLabel: "general-purpose" },
    ],
  ]);

  const { json } = await post(gate.port, payload("toolu_orphan_inner"));

  assert.equal(json.hookSpecificOutput.permissionDecision, "deny", "an orphan subagent tool is denied, never approved");
  assert.equal(calls.length, 0, "no dialog is raised against a non-existent parent id");
  const joined = errors.join("\n");
  assert.ok(
    /subagent/i.test(joined),
    "the visible deny names it as a SUBAGENT (R4 — not a generic main-chain 'never reached the pump' warning)",
  );
  assert.ok(
    joined.includes("toolu_orphan_inner") || /Bash/.test(joined),
    "the visible deny names the inner tool (id or name) so the user/log can see WHAT was denied (R4)",
  );
});

test("4.3 a MAIN-CHAIN tool still correlates and raises unchanged (U1 parity)", async (t) => {
  const { calls, gate } = await setup(t, () => ALLOW_OPTION_ID);
  gate.correlator.register("toolu_main_ok");
  const { json } = await post(gate.port, payload("toolu_main_ok", "Write", { file_path: "/p", content: "x" }));

  assert.equal(calls.length, 1, "the main-chain tool still raises its dialog");
  assert.equal(calls[0].toolCall.toolCallId, "toolu_main_ok", "main-chain semantics unchanged");
  assert.equal(json.hookSpecificOutput.permissionDecision, "allow", "and the decision is enforced");
});

test("4.3 bypassPermissions AUTO-ALLOWS a subagent tool WITHOUT a dialog (U4)", async (t) => {
  const { calls, session, gate } = await setup(t, () => ALLOW_OPTION_ID);
  // Even fully registered as a subagent tool, bypass short-circuits before any relay.
  gate.correlator.register("toolu_sub_bypass");
  session.sidechainParentMap = new Map([
    ["toolu_sub_bypass", { id: "toolu_sub_bypass", parentId: "toolu_task_1", toolName: "Bash", toolInput: {} }],
  ]);

  const { json } = await post(gate.port, payload("toolu_sub_bypass", "Bash", { command: "rm -rf /" }, "bypassPermissions"));

  assert.equal(json.hookSpecificOutput.permissionDecision, "allow", "bypassPermissions auto-allows the subagent tool");
  assert.equal(calls.length, 0, "no dialog is raised under bypass (selector honored, parity with main-chain U4)");
});

test("4.3 acceptEdits AUTO-ALLOWS an edit-class subagent tool WITHOUT a dialog (U4)", async (t) => {
  const { calls, session, gate } = await setup(t, () => ALLOW_OPTION_ID);
  gate.correlator.register("toolu_sub_edit");
  session.sidechainParentMap = new Map([
    ["toolu_sub_edit", { id: "toolu_sub_edit", parentId: "toolu_task_1", toolName: "Write", toolInput: { file_path: "/x", content: "y" } }],
  ]);

  const { json } = await post(gate.port, payload("toolu_sub_edit", "Write", { file_path: "/x", content: "y" }, "acceptEdits"));

  assert.equal(json.hookSpecificOutput.permissionDecision, "allow", "acceptEdits auto-allows the edit-class subagent tool");
  assert.equal(calls.length, 0, "no dialog under acceptEdits for an edit-class subagent tool (U4)");
});
