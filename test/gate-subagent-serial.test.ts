// Story 054 / Task 5.1 — serial queue: two parallel subagent permissions in one session resolve
// INDEPENDENTLY with their request+sweep critical sections SERIALIZED (no keystroke crossing).
//
// Contract (design.md fix step 4 "per-session serial queue around requestPermission+sweep", R5).
// Observable assertion: when two subagent hooks fire concurrently, the gate must NOT have two
// requestPermission bodies in-flight at once (serialized), and each must resolve to ITS OWN parent id
// + decision.
//
// Harness: REAL gate; a fake ACP client that records concurrency (inFlight counter, maxConcurrent) and
// returns a per-id decision after a small delay so any overlap would be observable. node:test (build first):
//   node --experimental-strip-types --test test/gate-subagent-serial.test.ts
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

const KNOBS = {
  correlationWaitMs: 500,
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
  });
}

test("5.1 two parallel subagent permissions resolve independently with serialized request/sweep (no crossing)", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gate-subagent-serial-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  let inFlight = 0;
  let maxConcurrent = 0;
  const seenIds: string[] = [];
  // Per-parent-id decision: task_1's tool → allow, task_2's tool → deny.
  const decisionFor = (parentId: string) => (parentId === "toolu_task_1" ? ALLOW_OPTION_ID : DENY_OPTION_ID);

  const client = {
    sessionUpdate: async () => {},
    requestPermission: async (params: RequestPermissionParams) => {
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      seenIds.push(params.toolCall.toolCallId);
      await new Promise((r) => setTimeout(r, 60)); // hold the critical section so any overlap shows
      inFlight -= 1;
      return { outcome: { outcome: "selected", optionId: decisionFor(params.toolCall.toolCallId) } };
    },
    readTextFile: async () => ({ content: "" }),
    writeTextFile: async () => ({}),
  } as never;

  const agent: any = new ClaudeAcpAgent(client, undefined, undefined, {
    startEngine: ((args: { sessionId?: string; cwd: string }) => ({
      sessionId: args.sessionId ?? "66666666-6666-4666-8666-666666666666",
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
  const gate = session.gate!;

  // Two subagent tools, each under a DIFFERENT parent Task — both registered (as the pump would).
  gate.correlator.register("toolu_inner_A");
  gate.correlator.register("toolu_inner_B");
  session.sidechainParentMap = new Map([
    ["toolu_inner_A", { id: "toolu_inner_A", parentId: "toolu_task_1", toolName: "Bash", toolInput: { command: "a" } }],
    ["toolu_inner_B", { id: "toolu_inner_B", parentId: "toolu_task_2", toolName: "Bash", toolInput: { command: "b" } }],
  ]);

  // Fire BOTH hooks concurrently.
  const [resA, resB] = await Promise.all([
    post(gate.port, payload("toolu_inner_A")),
    post(gate.port, payload("toolu_inner_B")),
  ]);

  assert.equal(maxConcurrent, 1, "the request/sweep critical section is SERIALIZED — never two prompts in-flight at once (R5)");
  assert.deepEqual(
    [...seenIds].sort(),
    ["toolu_task_1", "toolu_task_2"],
    "both subagent tools were raised, each under its OWN parent Task id (independent resolution)",
  );
  assert.equal(resA.json.hookSpecificOutput.permissionDecision, "allow", "task_1's subagent tool resolves to its own allow");
  assert.equal(resB.json.hookSpecificOutput.permissionDecision, "deny", "task_2's subagent tool resolves to its own deny — no crossing");
});
