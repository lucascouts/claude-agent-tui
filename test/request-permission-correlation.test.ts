// Story 033 / Task 2.2 — correlate by tool_use.id and raise session/request_permission, failing closed
// on a missing/duplicate id; a matched id raises the prompt and resolves the user's choice (R2.2).
//
// OFFLINE: a FAKE ACP client captures requestPermission calls and returns a canned outcome — no
// AgentSideConnection, no Zed, no claude.
//
// node:test: build first, then
//   node --experimental-strip-types --test test/request-permission-correlation.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALLOW_OPTION_ID,
  DENY_OPTION_ID,
  buildPermissionOptions,
  requestPermission,
  ToolUseCorrelator,
  type PermissionClient,
  type RequestPermissionParams,
  type RequestPermissionResult,
} from "../dist/permissions/request-permission.js";

/** A fake ACP client: records every requestPermission call and returns a programmable outcome. */
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

const SESSION = "sess-1";

test("2.2 a clean single match raises request_permission and an allow selection resolves 'allow'", async () => {
  const correlator = new ToolUseCorrelator();
  correlator.register("toolu_1"); // the story-015 watcher saw this tool_use in the JSONL exactly once
  const client = fakeClient(() => ({ outcome: { outcome: "selected", optionId: ALLOW_OPTION_ID } }));

  const decision = await requestPermission({
    client,
    sessionId: SESSION,
    toolCall: { toolUseId: "toolu_1", toolName: "Bash", toolInput: { command: "ls" } },
    correlator,
  });

  assert.equal(decision, "allow");
  assert.equal(client.calls.length, 1, "a matched id raises exactly one prompt");
  const params = client.calls[0];
  assert.equal(params.sessionId, SESSION);
  assert.equal(params.toolCall.toolCallId, "toolu_1", "correlated by tool_use.id");
  assert.equal(params.toolCall.title, "Bash");
  assert.deepEqual(params.toolCall.rawInput, { command: "ls" });
  // options are [allow, deny]
  assert.deepEqual(
    params.options.map((o) => o.optionId),
    [ALLOW_OPTION_ID, DENY_OPTION_ID],
  );
});

test("2.2 a deny selection resolves 'deny'", async () => {
  const correlator = new ToolUseCorrelator();
  correlator.register("toolu_2");
  const client = fakeClient(() => ({ outcome: { outcome: "selected", optionId: DENY_OPTION_ID } }));

  const decision = await requestPermission({
    client,
    sessionId: SESSION,
    toolCall: { toolUseId: "toolu_2", toolName: "Edit" },
    correlator,
  });
  assert.equal(decision, "deny");
  assert.equal(client.calls.length, 1);
});

test("2.2 a MISSING tool_use.id fails closed (deny) and never raises the prompt", async () => {
  const correlator = new ToolUseCorrelator(); // nothing registered → the id is uncorrelated
  const client = fakeClient(() => ({ outcome: { outcome: "selected", optionId: ALLOW_OPTION_ID } }));
  let warned = "";

  const decision = await requestPermission({
    client,
    sessionId: SESSION,
    toolCall: { toolUseId: "toolu_ghost", toolName: "Bash" },
    correlator,
    onWarn: (m) => (warned = m),
  });

  assert.equal(decision, "deny", "an uncorrelated call is denied, not approved");
  assert.equal(client.calls.length, 0, "no prompt is raised for an uncorrelated call");
  assert.match(warned, /FAIL CLOSED/);
  assert.match(warned, /toolu_ghost/);
});

test("2.2 a DUPLICATE tool_use.id fails closed (deny) even if Zed would allow", async () => {
  const correlator = new ToolUseCorrelator();
  correlator.register("toolu_dup");
  correlator.register("toolu_dup"); // seen twice in the JSONL → duplicate / id reuse
  const client = fakeClient(() => ({ outcome: { outcome: "selected", optionId: ALLOW_OPTION_ID } }));

  const decision = await requestPermission({
    client,
    sessionId: SESSION,
    toolCall: { toolUseId: "toolu_dup", toolName: "Bash" },
    correlator,
  });

  assert.equal(decision, "deny", "a duplicate id is never approved (id reuse must not ride an allow)");
  assert.equal(client.calls.length, 0);
});

test("2.2 re-asking an already-decided id fails closed (re-entrancy → duplicate)", async () => {
  const correlator = new ToolUseCorrelator();
  correlator.register("toolu_re");
  const client = fakeClient(() => ({ outcome: { outcome: "selected", optionId: ALLOW_OPTION_ID } }));

  const first = await requestPermission({
    client,
    sessionId: SESSION,
    toolCall: { toolUseId: "toolu_re", toolName: "Bash" },
    correlator,
  });
  assert.equal(first, "allow", "first ask is a clean match");

  const second = await requestPermission({
    client,
    sessionId: SESSION,
    toolCall: { toolUseId: "toolu_re", toolName: "Bash" },
    correlator,
  });
  assert.equal(second, "deny", "a second ask for a consumed id fails closed");
  assert.equal(client.calls.length, 1, "only the first ask reached the client");
});

test("2.2 a 'cancelled' outcome fails closed (a cancel is not an approval)", async () => {
  const correlator = new ToolUseCorrelator();
  correlator.register("toolu_c");
  const client = fakeClient(() => ({ outcome: { outcome: "cancelled" } }));

  const decision = await requestPermission({
    client,
    sessionId: SESSION,
    toolCall: { toolUseId: "toolu_c", toolName: "Bash" },
    correlator,
  });
  assert.equal(decision, "deny");
});

test("2.2 an ACP transport error fails closed (deny)", async () => {
  const correlator = new ToolUseCorrelator();
  correlator.register("toolu_err");
  const client: PermissionClient = {
    async requestPermission() {
      throw new Error("connection reset");
    },
  };
  let warned = "";

  const decision = await requestPermission({
    client,
    sessionId: SESSION,
    toolCall: { toolUseId: "toolu_err", toolName: "Bash" },
    correlator,
    onWarn: (m) => (warned = m),
  });
  assert.equal(decision, "deny");
  assert.match(warned, /transport error/);
  assert.match(warned, /connection reset/);
});

test("2.2 an unknown optionId fails closed (deny)", async () => {
  const correlator = new ToolUseCorrelator();
  correlator.register("toolu_u");
  const client = fakeClient(() => ({ outcome: { outcome: "selected", optionId: "something-else" } }));

  const decision = await requestPermission({
    client,
    sessionId: SESSION,
    toolCall: { toolUseId: "toolu_u", toolName: "Bash" },
    correlator,
  });
  assert.equal(decision, "deny");
});

test("2.2 correlator helpers: register/isCleanMatch/decide are consistent", () => {
  const c = new ToolUseCorrelator();
  assert.equal(c.isCleanMatch("x"), false, "unseen id is not a clean match");
  assert.equal(c.register("x"), true, "first register returns true");
  assert.equal(c.isCleanMatch("x"), true, "single-seen, unconsumed id is a clean match");
  assert.equal(c.register("x"), false, "duplicate register returns false");
  assert.equal(c.isCleanMatch("x"), false, "duplicate id is no longer a clean match");
  assert.equal(c.decide("x"), "deny", "decide denies a duplicate");
});

test("2.2 buildPermissionOptions offers exactly [allow, deny] with the right kinds", () => {
  const options = buildPermissionOptions();
  assert.equal(options.length, 2);
  assert.equal(options[0].optionId, ALLOW_OPTION_ID);
  assert.equal(options[0].kind, "allow_once");
  assert.equal(options[1].optionId, DENY_OPTION_ID);
  assert.equal(options[1].kind, "reject_once");
});
