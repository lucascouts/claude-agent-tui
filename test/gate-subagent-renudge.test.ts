// Story 054 / Task 4.2 — re-nudge during the correlation wait: a sidechain inner id that materializes
// MID-WAIT (after the first poll, before the timeout) resolves to a CLEAN MATCH and raises the dialog,
// rather than expiring into a fail-closed deny.
//
// Contract (design.md fix step 4): in the wait loop, re-nudge the pump so a sidechain row that
// materializes mid-wait gets sourced + registered before expiry. Behavior-level assertion: an inner id
// that becomes a clean match (with its parentMap entry) DURING the wait window resolves to a raised
// dialog under the parent id, before the bounded wait elapses.
//
// Harness: REAL gate, fake ACP client. We POST the hook FIRST (entering the wait), then register the
// sidechain id slightly later (mid-wait materialization). With a 250ms wait window the late
// registration lands inside it. node:test (build first):
//   node --experimental-strip-types --test test/gate-subagent-renudge.test.ts
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

// A wait window long enough to register mid-flight, short enough not to hang the runner.
const KNOBS = {
  correlationWaitMs: 800,
  correlationPollMs: 20,
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

function payload(toolUseId: string) {
  return JSON.stringify({
    session_id: "tui-side",
    transcript_path: "/tmp/x.jsonl",
    cwd: "/tmp",
    permission_mode: "default",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "ls" },
    tool_use_id: toolUseId,
    // Story 055 (R2.1/R2.3): a subagent tool POSTs its agent_id/agent_type — the signal that lets the
    // gate run the best-effort parent-grouping wait (so the row registering MID-WAIT is still grouped).
    agent_id: "agent_renudge",
    agent_type: "general-purpose",
  });
}

async function setup(t: any) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gate-subagent-renudge-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const calls: RequestPermissionParams[] = [];
  const client = {
    sessionUpdate: async () => {},
    requestPermission: async (params: RequestPermissionParams) => {
      calls.push(params);
      return { outcome: { outcome: "selected", optionId: ALLOW_OPTION_ID } };
    },
    readTextFile: async () => ({ content: "" }),
    writeTextFile: async () => ({}),
  } as never;
  const agent: any = new ClaudeAcpAgent(client, undefined, undefined, {
    startEngine: ((args: { sessionId?: string; cwd: string }) => ({
      sessionId: args.sessionId ?? "44444444-4444-4444-8444-444444444444",
      pty: { onExit: () => ({ dispose() {} }), onData: () => ({ dispose() {} }), resize() {}, write() {}, kill() {} } as never,
      watcher: { stop() {}, notifyEndOfTurn() {} },
      cwd: args.cwd,
    })) as never,
    gate: true,
    gateOptions: { settingsDir: dir, ...KNOBS },
  });
  t.after(() => agent.dispose());
  const r = await agent.createSession({ cwd: "/work", mcpServers: [] });
  const session = agent.sessions[r.sessionId] as { gate?: SessionGate; sidechainParentMap?: Map<string, any> };
  assert.ok(session.gate, "gate present");
  return { calls, session, gate: session.gate! };
}

test("4.2 a sidechain id that registers MID-WAIT resolves to a clean match and raises the dialog (re-nudge)", async (t) => {
  const { calls, session, gate } = await setup(t);

  // Register the sidechain PARENT row ~100ms after the hook fires — inside the wait window. STORY 055:
  // the INNER id is seeded by decide()'s ensureRegistered (the deadlock fix), so the pump must NOT
  // re-register it here (a second register would mark it a DUPLICATE → deny; in live the pump's own
  // register lands POST-decision, harmless). Only the PARENT grouping lands mid-wait, and the
  // best-effort waitForSubagentParent re-nudge catches it so the dialog attaches under the parent.
  setTimeout(() => {
    session.sidechainParentMap = session.sidechainParentMap ?? new Map();
    session.sidechainParentMap.set("toolu_late_inner", {
      id: "toolu_late_inner",
      parentId: "toolu_task_1",
      toolName: "Bash",
      toolInput: { command: "ls" },
    });
  }, 100);

  const { json } = await post(gate.port, payload("toolu_late_inner"), gate.token);

  assert.equal(json.hookSpecificOutput.permissionDecision, "allow", "the mid-wait registration is honored → allow, not a timeout deny");
  assert.equal(calls.length, 1, "exactly one dialog is raised once the lagging sidechain row lands");
  assert.equal(calls[0].toolCall.toolCallId, "toolu_task_1", "the late-resolved subagent tool relays under its parent id");
});
