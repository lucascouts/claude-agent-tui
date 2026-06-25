// Story 054 / Task 3.1 — requestPermission gains optional { dialogToolCallId, subagentLabel } so a
// subagent inner tool can be relayed to Zed under its PARENT Task tool_call.
//
// Contract (design.md):
//   - The correlator decision STILL uses the real INNER toolUseId (correlator.decide).
//   - When dialogToolCallId is set, client.requestPermission is built with
//       toolCall.toolCallId = dialogToolCallId  (the parent Task id Zed already rendered)
//       a title NAMING the inner tool (+ subagentLabel)
//       rawInput  = the inner toolInput (R7)
//   - A main-chain call (no extra params) is UNCHANGED: toolCallId = the inner toolUseId, title = tool
//     name, as today (regression U1).
//
// Authored from the contract + the existing request-permission-correlation.test.ts harness (no ToDo).
// OFFLINE: a fake ACP client records every requestPermission call. node:test (build first):
//   node --experimental-strip-types --test test/request-permission-subagent.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALLOW_OPTION_ID,
  DENY_OPTION_ID,
  requestPermission,
  ToolUseCorrelator,
  type PermissionClient,
  type RequestPermissionParams,
  type RequestPermissionResult,
} from "../dist/permissions/request-permission.js";

function fakeClient(
  reply: (params: RequestPermissionParams) => RequestPermissionResult,
): PermissionClient & { calls: RequestPermissionParams[] } {
  const calls: RequestPermissionParams[] = [];
  return {
    calls,
    async requestPermission(params) {
      calls.push(params);
      return reply(params);
    },
  };
}

const SESSION = "sess-sub";

test("3.1 a subagent call relays under the PARENT Task id while the correlator decides on the INNER id", async () => {
  const correlator = new ToolUseCorrelator();
  correlator.register("toolu_inner_bash"); // the pump fed the INNER sidechain id (story 054 R3)
  const client = fakeClient(() => ({ outcome: { outcome: "selected", optionId: ALLOW_OPTION_ID } }));

  const decision = await requestPermission({
    client,
    sessionId: SESSION,
    toolCall: { toolUseId: "toolu_inner_bash", toolName: "Bash", toolInput: { command: "ls" } },
    correlator,
    // Story 054 new params: parent Task id + a subagent label.
    dialogToolCallId: "toolu_task_1",
    subagentLabel: "general-purpose",
  } as never);

  assert.equal(decision, "allow", "the inner id was a clean match → the relayed allow is enforced");
  assert.equal(client.calls.length, 1, "exactly one prompt is raised in Zed");
  const params = client.calls[0];
  assert.equal(
    params.toolCall.toolCallId,
    "toolu_task_1",
    "the ACP prompt attaches to the PARENT Task id Zed already rendered (R2), NOT the inner id",
  );
  assert.notEqual(params.toolCall.toolCallId, "toolu_inner_bash", "the inner id is the correlation key only, never the ACP toolCallId");
  assert.match(
    String(params.toolCall.title ?? ""),
    /Bash/,
    "the prompt title NAMES the inner subagent tool (R2)",
  );
  assert.deepEqual(params.toolCall.rawInput, { command: "ls" }, "rawInput is the inner tool input (R7)");
});

test("3.1 the title also names the subagent label so the user sees which agent is asking", async () => {
  const correlator = new ToolUseCorrelator();
  correlator.register("toolu_inner_mcp");
  const client = fakeClient(() => ({ outcome: { outcome: "selected", optionId: DENY_OPTION_ID } }));

  const decision = await requestPermission({
    client,
    sessionId: SESSION,
    toolCall: { toolUseId: "toolu_inner_mcp", toolName: "perplexity", toolInput: { q: "x" } },
    correlator,
    dialogToolCallId: "toolu_task_2",
    subagentLabel: "research-agent",
  } as never);

  assert.equal(decision, "deny", "the user's deny on the relayed subagent prompt is enforced");
  const title = String(client.calls[0].toolCall.title ?? "");
  assert.match(title, /perplexity/, "title names the inner tool");
  assert.match(title, /research-agent/, "title names the subagent label (subagentLabel)");
});

test("3.1 a MAIN-CHAIN call (no extra params) is UNCHANGED: toolCallId = inner id, title = tool name (U1)", async () => {
  const correlator = new ToolUseCorrelator();
  correlator.register("toolu_main_1");
  const client = fakeClient(() => ({ outcome: { outcome: "selected", optionId: ALLOW_OPTION_ID } }));

  const decision = await requestPermission({
    client,
    sessionId: SESSION,
    toolCall: { toolUseId: "toolu_main_1", toolName: "Write", toolInput: { file_path: "/p" } },
    correlator,
  });

  assert.equal(decision, "allow");
  const params = client.calls[0];
  assert.equal(params.toolCall.toolCallId, "toolu_main_1", "main-chain prompt still keys on its own tool_use id");
  assert.equal(params.toolCall.title, "Write", "main-chain title is unchanged (the bare tool name)");
  assert.deepEqual(
    params.options.map((o) => o.optionId),
    [ALLOW_OPTION_ID, DENY_OPTION_ID],
    "options are unchanged [allow, deny]",
  );
});

test("3.1 a subagent call whose INNER id is NOT a clean match fails closed WITHOUT raising the parent prompt", async () => {
  const correlator = new ToolUseCorrelator(); // inner id never registered
  const client = fakeClient(() => ({ outcome: { outcome: "selected", optionId: ALLOW_OPTION_ID } }));
  let warned = "";

  const decision = await requestPermission({
    client,
    sessionId: SESSION,
    toolCall: { toolUseId: "toolu_inner_ghost", toolName: "Bash" },
    correlator,
    dialogToolCallId: "toolu_task_1",
    subagentLabel: "general-purpose",
    onWarn: (m) => (warned = m),
  } as never);

  assert.equal(decision, "deny", "an uncorrelated inner id is denied — the parent id must not ride an allow");
  assert.equal(client.calls.length, 0, "no prompt is raised against the parent id for an uncorrelated inner call");
  assert.match(warned, /toolu_inner_ghost/, "the warning names the uncorrelated INNER id");
});
