// Story 033 / Task 4.3 — capstone gate integration (R6.3): the DENY path intercepts a fixture tool
// call end-to-end (correlated by tool_use.id), the hybrid ALLOW path injects the `'1\r'` keystroke via
// the story-032 PTY driver, and NO SDK `canUseTool` symbol is referenced (it was cut in story 023).
//
// This is the OFFLINE integration the acceptance hinges on — a fake ACP client + a fake PTY are the
// ONLY fakes; the hook server, the tool_use.id correlator, the deny/allow decision bodies, and the
// keystroke-injection picker are the REAL units wired together. Live in-Zed verification of the
// permission prompt is GATED on story 027 (fork registered in Zed) and is NOT run here.
//
// node:test: build first, then
//   node --experimental-strip-types --test test/gate-integration.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
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
import {
  clearNativePrompt,
  KEYSTROKE_YES,
  KEYSTROKE_NO,
  type PtyWriter,
} from "../dist/permissions/allow-inject.js";

const HOOK_PATH = "/__fork-acp-gate__";
const SESSION = "sess-gate-integ";

/** POST a body to the loopback hook server and resolve the decision JSON (mirrors how claude calls it). */
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

/** A fixture PreToolUse payload (GATE_FINDINGS keystone 1.3 shape). */
function fixturePayload(toolUseId: string, toolName = "Bash", toolInput: unknown = { command: "rm -rf /" }): string {
  return JSON.stringify({
    session_id: SESSION,
    transcript_path: "/tmp/x.jsonl",
    cwd: "/tmp",
    permission_mode: "default",
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: toolUseId,
  });
}

/** Wire the REAL gate decider: correlate by tool_use.id → ask the fake ACP client → enforce. */
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

test("4.3 DENY path: fixture PreToolUse → hook server → IPC → fake ACP client (deny) → tool intercepted by tool_use.id", async (t) => {
  const port = await findFreePort();

  const calls: RequestPermissionParams[] = [];
  const client: PermissionClient = {
    async requestPermission(params) {
      calls.push(params);
      return { outcome: { outcome: "selected", optionId: DENY_OPTION_ID } };
    },
  };

  const correlator = new ToolUseCorrelator();
  correlator.register("toolu_integ_deny"); // the story-015 watcher saw this id once in the JSONL

  // If the server fails to bind, this await REJECTS (the test fails with the bind error, never hangs).
  const server = await startHookServer({ port, onToolCall: buildDecider(client, correlator) });
  t.after(() => server.close());

  const { status, json } = await post(port, fixturePayload("toolu_integ_deny"));

  assert.equal(status, 200);
  assert.equal(
    json.hookSpecificOutput.permissionDecision,
    "deny",
    "deny intercepts the tool BEFORE it runs (the load-bearing capability)",
  );
  assert.equal(calls.length, 1, "exactly one session/request_permission was raised");
  assert.equal(calls[0].toolCall.toolCallId, "toolu_integ_deny", "the Zed prompt is correlated by tool_use.id");
  assert.deepEqual(calls[0].toolCall.rawInput, { command: "rm -rf /" }, "the tool input was forwarded to Zed");
  assert.deepEqual(
    calls[0].options.map((o) => o.optionId),
    [ALLOW_OPTION_ID, DENY_OPTION_ID],
    "the gate offers [allow, deny]",
  );
});

test("4.3 an UNCORRELATED tool_use.id fails closed (deny) without ever prompting Zed", async (t) => {
  const port = await findFreePort();
  const calls: RequestPermissionParams[] = [];
  const client: PermissionClient = {
    async requestPermission(params) {
      calls.push(params);
      return { outcome: { outcome: "selected", optionId: ALLOW_OPTION_ID } };
    },
  };
  const correlator = new ToolUseCorrelator(); // nothing registered → the payload id is uncorrelated

  const server = await startHookServer({ port, onToolCall: buildDecider(client, correlator) });
  t.after(() => server.close());

  const { json } = await post(port, fixturePayload("toolu_ghost"));
  assert.equal(json.hookSpecificOutput.permissionDecision, "deny", "an uncorrelated call is denied, not approved");
  assert.equal(calls.length, 0, "no Zed prompt is raised for an uncorrelated call");
});

test("4.3 hybrid ALLOW path: a non-suppressed native prompt injects '1\\r' via the story-032 PTY driver", async (t) => {
  const port = await findFreePort();

  // The fake ACP client APPROVES — so the hybrid allow path must clear the still-shown native prompt.
  const client: PermissionClient = {
    async requestPermission() {
      return { outcome: { outcome: "selected", optionId: ALLOW_OPTION_ID } };
    },
  };
  const correlator = new ToolUseCorrelator();
  correlator.register("toolu_integ_allow");

  const server = await startHookServer({ port, onToolCall: buildDecider(client, correlator) });
  t.after(() => server.close());

  // 1) The gate returns allow over the wire.
  const { json } = await post(port, fixturePayload("toolu_integ_allow", "Edit", { file_path: "/x", new_string: "y" }));
  assert.equal(json.hookSpecificOutput.permissionDecision, "allow", "the gate returned allow");

  // 2) #52822: the native prompt is STILL shown — the fork clears it via the story-032 PTY driver.
  const writes: string[] = [];
  const pty: PtyWriter = { write: (d) => writes.push(d) };
  let shown = true; // the native prompt is shown; it clears once the keystroke is typed.
  const result = await clearNativePrompt({
    pty,
    decision: "allow",
    isPromptShown: () => shown,
    timeoutMs: 500,
    pollMs: 5,
    schedule: (fn, ms) => {
      // Model the TUI consuming the keystroke: the prompt clears right after the keystroke is written.
      if (writes.length > 0) shown = false;
      setTimeout(fn, ms);
    },
  });

  assert.equal(result.status, "cleared", "the native prompt was cleared by the injected keystroke");
  assert.deepEqual(writes, [KEYSTROKE_YES], "exactly the '1\\r' (Yes) keystroke was injected via the PTY driver");
  assert.notEqual(KEYSTROKE_YES, KEYSTROKE_NO, "Yes and refusal are distinct keystrokes");
});

test("4.3 the gate references NO SDK `canUseTool` symbol (cut in story 023 — the gate is the hook + request_permission)", async () => {
  // The permission modules are the WHOLE gate surface; statically assert none reintroduces the cut
  // SDK permission callback. (canUseTool does not exist on the PTY path — IMPLEMENTACAO §3 / story 023.)
  const here = path.dirname(fileURLToPath(import.meta.url));
  const permDir = path.resolve(here, "../dist/permissions");
  const entries = await fs.readdir(permDir);
  const jsFiles = entries.filter((f) => f.endsWith(".js"));
  assert.ok(jsFiles.length >= 5, "all five permission modules are present in dist");
  for (const f of jsFiles) {
    const src = await fs.readFile(path.join(permDir, f), "utf8");
    assert.ok(
      !/canUseTool/.test(src),
      `${f} must NOT reference canUseTool — the gate is the PreToolUse hook + session/request_permission`,
    );
  }
});
