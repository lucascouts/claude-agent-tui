// Story 033 / Task 2.4 — deny-path integration: a fixture PreToolUse payload drives the loopback hook
// server → IPC decider → a fake ACP client that returns deny, and the hook response intercepts the
// tool, correlated by tool_use.id (R2.1, R2.2, R2.3).
//
// This wires the REAL hook-server + request-permission units together (the only fake is the ACP
// client). OFFLINE: a real loopback http server; no claude, no Zed, no PTY. If the server fails to
// bind, the await rejects and the test fails with the bind error rather than hanging.
//
// node:test: build first, then
//   node --experimental-strip-types --test test/deny-path-e2e.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { findFreePort } from "../dist/gate/port.js";
import { startHookServer, type ForwardedToolCall } from "../dist/permissions/hook-server.js";
import {
  ALLOW_OPTION_ID,
  DENY_OPTION_ID,
  requestPermission,
  ToolUseCorrelator,
  type PermissionClient,
  type RequestPermissionParams,
} from "../dist/permissions/request-permission.js";

const HOOK_PATH = "/__fork-acp-gate__";
const SESSION = "sess-e2e";

function post(port: number, body: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path: HOOK_PATH, method: "POST", headers: { "content-type": "application/json" } },
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

/** A fixture PreToolUse payload (GATE_FINDINGS keystone 1.3 shape) for a Bash tool. */
function fixturePayload(toolUseId: string, toolName = "Bash"): string {
  return JSON.stringify({
    session_id: SESSION,
    transcript_path: "/tmp/x.jsonl",
    cwd: "/tmp",
    permission_mode: "default",
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_input: { command: "rm -rf /" },
    tool_use_id: toolUseId,
  });
}

/** Build the full gate decider: correlate by tool_use.id → ask the fake ACP client → enforce. */
function buildDecider(
  client: PermissionClient,
  correlator: ToolUseCorrelator,
): (call: ForwardedToolCall) => Promise<"allow" | "deny"> {
  return (call) =>
    requestPermission({
      client,
      sessionId: call.sessionId ?? SESSION,
      toolCall: { toolUseId: call.toolUseId, toolName: call.toolName, toolInput: call.toolInput },
      correlator,
    });
}

test("2.4 deny path: fixture payload → hook → IPC → fake ACP client (deny) → tool intercepted", async (t) => {
  const port = await findFreePort();

  // The fake ACP client returns DENY — capturing the request_permission params for assertions.
  const calls: RequestPermissionParams[] = [];
  const client: PermissionClient = {
    async requestPermission(params) {
      calls.push(params);
      return { outcome: { outcome: "selected", optionId: DENY_OPTION_ID } };
    },
  };

  // The story-015 watcher saw this tool_use.id once in the JSONL → a clean correlation.
  const correlator = new ToolUseCorrelator();
  correlator.register("toolu_e2e");

  const server = await startHookServer({ port, onToolCall: buildDecider(client, correlator) });
  t.after(() => server.close());

  const { status, json } = await post(port, fixturePayload("toolu_e2e"));

  // The hook response intercepts the tool.
  assert.equal(status, 200);
  assert.equal(json.hookSpecificOutput.permissionDecision, "deny", "deny intercepts the tool before it runs");

  // The request was correlated by tool_use.id and reached the fake ACP client exactly once.
  assert.equal(calls.length, 1, "exactly one session/request_permission was raised");
  assert.equal(calls[0].toolCall.toolCallId, "toolu_e2e", "correlated by tool_use.id");
  assert.equal(calls[0].sessionId, SESSION);
  assert.deepEqual(calls[0].toolCall.rawInput, { command: "rm -rf /" }, "the tool input was forwarded to Zed");
  assert.deepEqual(
    calls[0].options.map((o) => o.optionId),
    [ALLOW_OPTION_ID, DENY_OPTION_ID],
  );
});

test("2.4 allow path: the SAME wiring returns allow when the fake client selects allow", async (t) => {
  const port = await findFreePort();
  const client: PermissionClient = {
    async requestPermission() {
      return { outcome: { outcome: "selected", optionId: ALLOW_OPTION_ID } };
    },
  };
  const correlator = new ToolUseCorrelator();
  correlator.register("toolu_ok");

  const server = await startHookServer({ port, onToolCall: buildDecider(client, correlator) });
  t.after(() => server.close());

  const { json } = await post(port, fixturePayload("toolu_ok"));
  assert.equal(json.hookSpecificOutput.permissionDecision, "allow");
});

test("2.4 an UNCORRELATED tool_use.id is intercepted (deny) without raising a Zed prompt", async (t) => {
  const port = await findFreePort();
  const calls: RequestPermissionParams[] = [];
  const client: PermissionClient = {
    async requestPermission(params) {
      calls.push(params);
      return { outcome: { outcome: "selected", optionId: ALLOW_OPTION_ID } };
    },
  };
  const correlator = new ToolUseCorrelator(); // nothing registered → the payload's id is uncorrelated

  const server = await startHookServer({ port, onToolCall: buildDecider(client, correlator) });
  t.after(() => server.close());

  const { json } = await post(port, fixturePayload("toolu_ghost"));
  assert.equal(json.hookSpecificOutput.permissionDecision, "deny", "an uncorrelated call is denied");
  assert.equal(calls.length, 0, "no Zed prompt is raised for an uncorrelated call");
});

test("2.4 an ACP transport error end-to-end fails closed (deny) — never ungated", async (t) => {
  const port = await findFreePort();
  const client: PermissionClient = {
    async requestPermission() {
      throw new Error("ACP socket closed");
    },
  };
  const correlator = new ToolUseCorrelator();
  correlator.register("toolu_err");

  const server = await startHookServer({ port, onToolCall: buildDecider(client, correlator) });
  t.after(() => server.close());

  const { json } = await post(port, fixturePayload("toolu_err"));
  assert.equal(json.hookSpecificOutput.permissionDecision, "deny", "a transport error never leaves a tool ungated");
});

test("2.4 the server bound a real loopback port (bind failure would have rejected startHookServer)", async (t) => {
  // If startHookServer's promise resolves, the socket bound — a bind error rejects it (the spawn path
  // then fails fast rather than spawning claude with an ungated hook URL). Asserting the resolved port
  // is the documented bind-success signal.
  const port = await findFreePort();
  const correlator = new ToolUseCorrelator();
  const client: PermissionClient = {
    async requestPermission() {
      return { outcome: { outcome: "cancelled" } };
    },
  };
  const server = await startHookServer({ port, onToolCall: buildDecider(client, correlator) });
  t.after(() => server.close());
  assert.equal(server.port, port, "the server reports the bound loopback port");
});
