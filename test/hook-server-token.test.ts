// Story 055 / Task 2.1 + 1.3 — hook-server payload-attribution + per-session URL token.
//
// Authored RED-first by the Test Advisor BEFORE implementation (R2.1, R1.3). Two contracts:
//   - parsePayload MUST carry the subagent attribution fields (agent_id/agent_type) the §9 payload
//     already ships, onto the forwarded call (today they are dropped → the dialog can't be labelled).
//   - the hook-server MUST validate a per-session secret token from req.url and FAIL CLOSED (deny,
//     WITHOUT invoking the decider) on an absent/wrong token, while the correct token relays normally.
//
// OFFLINE: a REAL loopback http server bound on a story-032 free port; POSTs via node:http. No claude,
// no Zed. The decider is an injected fake — so an absent-token POST that reaches the decider is the
// detectable failure.
//
// node:test (build first), cwd=fork/:
//   node --experimental-strip-types --test test/hook-server-token.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { findFreePort } from "../dist/gate/port.js";
import { parsePayload, startHookServer } from "../dist/permissions/hook-server.js";

const HOOK_PATH = "/__fork-acp-gate__";

/** POST a JSON body to 127.0.0.1:<port><path>; `path` lets a test present (or omit) the token. */
function post(
  port: number,
  body: string,
  path = HOOK_PATH,
): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "application/json" } },
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

/** A subagent-internal §9 PreToolUse payload carrying agent_id/agent_type (snake_case, as claude POSTs). */
function subagentPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: "sess-1",
    transcript_path: "/tmp/x.jsonl",
    cwd: "/tmp",
    permission_mode: "default",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "ls" },
    tool_use_id: "toolu_inner",
    agent_id: "agent_abc123",
    agent_type: "general-purpose",
    ...overrides,
  });
}

// ── R2.1 — parsePayload carries the subagent attribution fields ────────────────────────────────────

test("055/2.1 parsePayload carries agent_id/agent_type onto the forwarded call", () => {
  const call = parsePayload(subagentPayload());
  assert.ok(call, "a well-formed subagent payload still parses");
  assert.equal(call!.agentId, "agent_abc123", "agent_id is carried as agentId (today it is dropped)");
  assert.equal(call!.agentType, "general-purpose", "agent_type is carried as agentType");
});

test("055/2.1 a main-chain payload leaves agentId/agentType undefined", () => {
  const call = parsePayload(subagentPayload({ agent_id: undefined, agent_type: undefined }));
  assert.ok(call);
  assert.equal(call!.agentId, undefined, "a main-chain call carries no subagent id");
  assert.equal(call!.agentType, undefined, "a main-chain call carries no subagent type");
});

// ── R1.3 — per-session URL token (fail-closed on absent/wrong, relay on correct) ───────────────────

test("055/1.3 an absent token FAILS CLOSED (deny) WITHOUT invoking the decider", async (t) => {
  const port = await findFreePort();
  const token = "s3cr3t-per-session-token";
  let deciderCalls = 0;
  const server = await startHookServer({
    port,
    token,
    onToolCall: () => {
      deciderCalls++;
      return "allow";
    },
  });
  t.after(() => server.close());

  // POST to the bare marker path — no token segment.
  const { json } = await post(port, subagentPayload(), HOOK_PATH);
  assert.equal(json.hookSpecificOutput.permissionDecision, "deny", "a tokenless POST is denied");
  assert.equal(deciderCalls, 0, "a tokenless POST never reaches the decider (fail-closed, no decision)");
});

test("055/1.3 a WRONG token FAILS CLOSED (deny) WITHOUT invoking the decider", async (t) => {
  const port = await findFreePort();
  let deciderCalls = 0;
  const server = await startHookServer({
    port,
    token: "the-real-token",
    onToolCall: () => {
      deciderCalls++;
      return "allow";
    },
  });
  t.after(() => server.close());

  const { json } = await post(port, subagentPayload(), `${HOOK_PATH}/an-attacker-token`);
  assert.equal(json.hookSpecificOutput.permissionDecision, "deny", "a forged-token POST is denied");
  assert.equal(deciderCalls, 0, "a forged-token POST never reaches the decider");
});

test("055/1.3 the CORRECT token reaches the decider and relays its decision", async (t) => {
  const port = await findFreePort();
  const token = "the-real-token";
  let seenToolUse: string | null = null;
  const server = await startHookServer({
    port,
    token,
    onToolCall: (call) => {
      seenToolUse = call.toolUseId;
      return "allow";
    },
  });
  t.after(() => server.close());

  const { json } = await post(port, subagentPayload(), `${HOOK_PATH}/${token}`);
  assert.equal(seenToolUse, "toolu_inner", "the tokenized POST reaches the decider");
  assert.equal(json.hookSpecificOutput.permissionDecision, "allow", "and its decision is relayed");
});
