// Story 064 (R1, R1.1, R3) — the AskUserQuestion deny-guard, exercised through the REAL loopback hook
// server (setupSessionGate's decide() chain) + a fake ACP client. OFFLINE: no claude, no Zed, no PTY —
// a 127.0.0.1 hook server is the only live socket and the gate is torn down in each test's own
// t.after, so the runner never hangs.
//
// RED ON PURPOSE (this is the failing-test sub-task; the production deny-branch is a SEPARATE sub-task):
// today decide() has NO AskUserQuestion branch, so an AskUserQuestion call FALLS THROUGH to the ACP
// relay and the fake client's ALLOW makes the body "allow" with one relay. The assertions below pin the
// post-fix contract — deny + zero relays + a bridge reason — so cases (1) and (2) FAIL behaviorally now
// (expected "deny", got "allow"; expected 0 relays, got 1) and will PASS once the guard is added. Case
// (3) (an unrelated Bash) is the invariant: it must hold both before and after the fix.
//
// The deny REASON is asserted by reading it OFF THE HTTP RESPONSE BODY
// (json.hookSpecificOutput.permissionDecisionReason) — NOT by importing any reason helper. Every symbol
// imported here already exists today, so the file LOADS cleanly (an import/compile failure would not be
// a valid Red).
//
// node:test runner (run `npm run build` first — behavioral imports resolve against ../dist):
//   node --experimental-strip-types --test test/askuserquestion-deny.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setupSessionGate } from "../dist/permissions/gate-wiring.js";
import {
  ALLOW_OPTION_ID,
  DENY_OPTION_ID,
  type RequestPermissionParams,
} from "../dist/permissions/request-permission.js";
import { FORK_HOOK_MARKER_PATH } from "../dist/gate/settings-writer.js";

/** The authoritative ACP session id the gate is bound to (an unbound gate fail-closes on decide). */
const ACP_SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

/** Short, hang-proof gate timing knobs (production defaults are seconds-scale). */
const SHORT_KNOBS = {
  correlationWaitMs: 250,
  correlationPollMs: 10,
  promptAppearMs: 50,
  promptPollMs: 5,
  injectTimeoutMs: 200,
  closeTimeoutMs: 1000,
};

/** POST a body to the loopback hook server at `${FORK_HOOK_MARKER_PATH}/<token>` (how claude calls it),
 *  resolving the decision JSON. The server enforces the per-session token, so it must be presented. */
function post(port: number, body: string, token?: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: token ? `${FORK_HOOK_MARKER_PATH}/${token}` : FORK_HOOK_MARKER_PATH,
        method: "POST",
        headers: { "content-type": "application/json" },
      },
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

/** A fixture PreToolUse payload (GATE_FINDINGS keystone 1.3 shape). The `session_id` is the TUI's own
 *  id, DELIBERATELY different from the bound ACP id — the authoritative (bound) id must win on relay. */
function fixturePayload(
  toolUseId: string,
  toolName = "Bash",
  toolInput: unknown = { command: "rm -rf /" },
  permissionMode = "default",
): string {
  return JSON.stringify({
    session_id: "tui-side-session-id",
    transcript_path: "/tmp/x.jsonl",
    cwd: "/tmp",
    permission_mode: permissionMode,
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: toolUseId,
  });
}

/** Minimal ACP client stub: records each session/request_permission and answers via `decide`. The
 *  client returns ALLOW in these tests — that is what makes the Red valid: with no guard, an
 *  AskUserQuestion call falls through to this relay and the allow makes the body "allow" with one call,
 *  so an assertion of "deny" + zero relays fails cleanly TODAY (and passes once the guard is added). */
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

/** Start a REAL gate over fakes + a tmp scratch dir, bind the authoritative ACP session id (no PTY:
 *  these cases never reach the allow-sweep), and wire idempotent cleanup. The client returns ALLOW. */
async function setupGate(t: Parameters<NonNullable<Parameters<typeof test>[0]>>[0]) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "askuserquestion-deny-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const { client, calls } = makeClient(() => ALLOW_OPTION_ID);
  const gate = await setupSessionGate({
    client,
    settingsDir: dir,
    onWarn: () => {}, // no-op: silence the fail-closed/stuck warnings (no PTY is bound here)
    ...SHORT_KNOBS,
  });
  t.after(() => gate.teardown()); // closes the hook server + removes the scratch — the runner never hangs

  // bindSession is mandatory: an unbound gate fail-closes (no ACP sessionId to relay with), which would
  // mask the behavior under test. The bound (authoritative) id deliberately differs from the payload's.
  gate.bindSession(ACP_SESSION_ID);

  return { gate, calls };
}

// === (1) R1/R1.1 — AskUserQuestion in "default" mode → DENY with a bridge reason, BEFORE any relay ===
// TODAY (no guard): default mode is neither bypass nor acceptEdits-edit, so the call is seeded into the
// correlator and relayed; the fake client's ALLOW makes the body "allow" with ONE relay. This case
// therefore FAILS behaviorally now (expected "deny" + 0 relays, got "allow" + 1) and passes once 2.2
// adds the deny-branch ahead of the relay.

test("(1) AskUserQuestion in default mode is DENIED with a bridge reason and raises ZERO Zed relays (R1, R1.1)", async (t) => {
  const { gate, calls } = await setupGate(t);

  const { status, json } = await post(
    gate.port,
    fixturePayload("toolu_ask_default", "AskUserQuestion", { question: "Pick one" }, "default"),
    gate.token,
  );

  assert.equal(status, 200, "the hook server answers (it is really listening on the scratch URL's port)");
  assert.equal(
    json.hookSpecificOutput.permissionDecision,
    "deny",
    "R1: AskUserQuestion is denied BEFORE any generic session/request_permission is relayed",
  );
  const reason: string = json.hookSpecificOutput.permissionDecisionReason;
  assert.ok(reason && reason.length > 0, "R1.1: the deny carries a non-empty reason (never a blank deny)");
  assert.match(reason, /AskUserQuestion/, "R1.1: the reason names the AskUserQuestion tool");
  assert.match(
    reason,
    /bridge/i,
    "R1.1: the reason states interactive questions are unsupported over the bridge (model continues, no stall)",
  );
  assert.equal(
    calls.length,
    0,
    "R1: ZERO session/request_permission relays were raised — the guard precedes the ACP relay",
  );
});

// === (2) R1 — AskUserQuestion in "bypassPermissions" → STILL deny, ZERO relays =======================
// TODAY (no guard): the bypassPermissions short-circuit (decide() returns "allow" for ANY tool) runs
// BEFORE there could be a guard, so the body is "allow" with zero relays. This case FAILS behaviorally
// now on the DECISION (expected "deny", got "allow") and passes once the AskUserQuestion guard is placed
// AHEAD of the mode auto-allow. (The relay count is already 0 today because bypass short-circuits before
// the relay; asserting it stays 0 keeps the post-fix contract honest.)

test("(2) AskUserQuestion under bypassPermissions is STILL denied (guard precedes the mode auto-allow) with ZERO relays (R1)", async (t) => {
  const { gate, calls } = await setupGate(t);

  const { status, json } = await post(
    gate.port,
    fixturePayload("toolu_ask_bypass", "AskUserQuestion", { question: "Pick one" }, "bypassPermissions"),
    gate.token,
  );

  assert.equal(status, 200, "the hook server answers");
  assert.equal(
    json.hookSpecificOutput.permissionDecision,
    "deny",
    "R1: the AskUserQuestion guard precedes the bypassPermissions auto-allow — it is denied even in bypass",
  );
  const reason: string = json.hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /AskUserQuestion/, "R1.1: the reason names the AskUserQuestion tool, in any mode");
  assert.match(reason, /bridge/i, "R1.1: the reason cites the bridge limitation, in any mode");
  assert.equal(calls.length, 0, "R1: no session/request_permission relay is raised under bypass either");
});

// === (3) R3 — an UNRELATED tool is UNAFFECTED: Bash (default) still relays and is allowed =============
// This is the over-broad-matching invariant: the guard must apply ONLY to AskUserQuestion. A correlated
// Bash in default mode falls through to the ACP relay and the fake client's ALLOW is enforced → body
// "allow" with EXACTLY ONE relay. This case is expected to PASS both BEFORE and AFTER 2.2.

test("(3) an unrelated tool (Bash, default) is UNAFFECTED — it still relays once and is allowed (R3)", async (t) => {
  const { gate, calls } = await setupGate(t);

  // The fall-through (ask-Zed) path needs a clean correlation within SHORT_KNOBS timing — simulate the
  // live pump having observed this tool_use id in the JSONL (registerGateToolUses).
  gate.correlator.register("toolu_bash_unrelated");

  const { status, json } = await post(
    gate.port,
    fixturePayload("toolu_bash_unrelated", "Bash", { command: "ls" }, "default"),
    gate.token,
  );

  assert.equal(status, 200, "the hook server answers");
  assert.equal(
    json.hookSpecificOutput.permissionDecision,
    "allow",
    "R3: Bash is unaffected by the AskUserQuestion guard — Zed's allow is enforced on the fall-through",
  );
  assert.equal(
    calls.length,
    1,
    "R3: exactly ONE session/request_permission relay was raised for the unrelated tool (guard is not over-broad)",
  );
  assert.equal(
    calls[0].sessionId,
    ACP_SESSION_ID,
    "the relay carries the AUTHORITATIVE bound ACP session id (bindSession), not the TUI payload's id",
  );
  assert.equal(calls[0].toolCall.toolCallId, "toolu_bash_unrelated", "correlated by tool_use.id");
  assert.deepEqual(
    calls[0].options.map((o) => o.optionId),
    [ALLOW_OPTION_ID, DENY_OPTION_ID],
    "the gate offers [allow, deny] for the unrelated tool",
  );
});
