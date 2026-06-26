// Story 055 / Task 2.2 — the subagent label is rendered from the payload's agent_type and is DECOUPLED
// from whether a parent Task id is known (R2.2). Today the attributed title is gated on
// `dialogToolCallId !== undefined`; 055 renders `<tool> · from the <agent_type> agent` whenever
// `subagentLabel` is set — including the common live case where the parent join has NOT landed
// (dialogToolCallId undefined → the dialog keys on the inner id, but the title is still attributed).
//
// Authored RED-first by the Test Advisor BEFORE implementation, from the contract + the existing
// request-permission-subagent.test.ts harness (no ToDo). OFFLINE: a fake ACP client records the call.
// node:test (build first), cwd=fork/:
//   node --experimental-strip-types --test test/request-permission-label.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALLOW_OPTION_ID,
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

const SESSION = "sess-label";

test("055/2.2 a subagentLabel with NO parent id STILL renders the attributed title (decoupled from dialogToolCallId)", async () => {
  const correlator = new ToolUseCorrelator();
  correlator.register("toolu_inner_bash"); // the inner id is a clean match (seeded/registered)
  const client = fakeClient(() => ({ outcome: { outcome: "selected", optionId: ALLOW_OPTION_ID } }));

  const decision = await requestPermission({
    client,
    sessionId: SESSION,
    toolCall: { toolUseId: "toolu_inner_bash", toolName: "Bash", toolInput: { command: "ls" } },
    correlator,
    // The parent join has NOT landed (the common fast-subagent live case): NO dialogToolCallId,
    // but the payload's agent_type IS known → the label must still appear.
    subagentLabel: "general-purpose",
  } as never);

  assert.equal(decision, "allow", "the inner id was a clean match → the relayed allow is enforced");
  assert.equal(client.calls.length, 1, "exactly one prompt is raised");
  const params = client.calls[0];
  // The dialog still keys on the inner id (no parent to re-target onto).
  assert.equal(
    params.toolCall.toolCallId,
    "toolu_inner_bash",
    "with no parent, the dialog keys on the inner tool_use id",
  );
  // The CONTRACT under test: the title is attributed from the label even though dialogToolCallId is undefined.
  assert.equal(
    String(params.toolCall.title ?? ""),
    "Bash · from the general-purpose agent",
    "the title is labelled from agent_type even when the parent id is unknown (decoupled)",
  );
});

test("055/2.2 a MAIN-CHAIN call (no subagentLabel) stays byte-identical: a bare tool name", async () => {
  const correlator = new ToolUseCorrelator();
  correlator.register("toolu_main");
  const client = fakeClient(() => ({ outcome: { outcome: "selected", optionId: ALLOW_OPTION_ID } }));

  await requestPermission({
    client,
    sessionId: SESSION,
    toolCall: { toolUseId: "toolu_main", toolName: "Write", toolInput: { file_path: "/p", content: "x" } },
    correlator,
  } as never);

  const params = client.calls[0];
  assert.equal(params.toolCall.toolCallId, "toolu_main", "main-chain keys on its own id");
  assert.equal(
    String(params.toolCall.title ?? ""),
    "Write",
    "a main-chain call with no label renders the bare tool name (regression U1)",
  );
});
