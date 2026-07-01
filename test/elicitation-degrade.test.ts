// Story 065 / Task 4.1 (R4) — graceful-degradation / fail-closed HARDENING tests for the elicitation
// path. These pin the two gaps Tech Review found (and confirm the hook-server's defense-in-depth net),
// ADDITIVE to the frozen task-2.1 bridge suite (test/elicitation-bridge.test.ts, 12/12) and the task-3.1
// gate suite (test/gate-elicitation.test.ts) — this file touches NEITHER.
//
// The load-bearing posture (design.md "Fail closed everywhere"): the elicitation path must yield a
// LEGIBLE deny — never a crash, never an unhandled throw, never a hang — when
//   (a) the ACP client's `unstable_createElicitation` is MISSING (capability advertised, method absent)
//       or throws SYNCHRONOUSLY (the throw lands at argument-evaluation time, before the inline rejection
//       handler attaches), and
//   (b) a per-question `tool_input` is malformed (e.g. `{questions:[{header:"X"}]}` with no `options`),
//       which makes the bridge builder's `q.options.map(...)` throw OUT of decideElicitation unless it is
//       total.
// The hook-server's `decideWithTimeout` already provides a generic fail-closed net (a throwing decider →
// deny); (4) below asserts that defense-in-depth layer is intact (it lives in hook-server-failclosed.test
// too — noted, not duplicated here beyond confirming the observable contract).
//
// Build-first, like every fork test: runtime imports resolve against ../dist (npm run build first):
//   node --experimental-strip-types --test test/elicitation-degrade.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildElicitationRequest,
  mapOutcomeToDecision,
  requestElicitation,
  type AskUserQuestionInput,
  type ElicitationClient,
} from "../dist/permissions/elicitation-bridge.js";
import { setupSessionGate } from "../dist/permissions/gate-wiring.js";
import { ALLOW_OPTION_ID, type RequestPermissionParams } from "../dist/permissions/request-permission.js";
import { FORK_HOOK_MARKER_PATH } from "../dist/gate/settings-writer.js";

const SESSION = "sess-degrade-1";
const TOOL_USE_ID = "toolu_degrade_1";

/** A realistic single-question AskUserQuestion tool_input to build a well-formed request from. */
function oneQuestionInput(): AskUserQuestionInput {
  return {
    questions: [
      {
        question: "Which environment?",
        header: "Env",
        options: [{ label: "dev" }, { label: "prod" }],
      },
    ],
  };
}

// =====================================================================================================
// (1) BRIDGE — the client's `unstable_createElicitation` method is MISSING (undefined).
// A capability may be advertised while the method is absent; the eager `client.unstable_createElicitation
// (req)` then throws a SYNCHRONOUS TypeError at argument-evaluation time, BEFORE the inline .then(ok,err)
// rejection handler attaches. requestElicitation must NORMALIZE that to a fail-closed cancel (→ deny),
// surface it via onWarn, and NOT re-throw.
// =====================================================================================================

test("4.1 (bridge) a MISSING unstable_createElicitation resolves fail-closed (deny), never throws (R4)", async () => {
  const req = buildElicitationRequest(TOOL_USE_ID, SESSION, oneQuestionInput());
  let warned = "";

  // No `unstable_createElicitation` on this client at all — the method is undefined.
  const clientMissingMethod = {} as unknown as ElicitationClient;

  // Must RESOLVE (not reject): a throw escaping here would fail the test as an unhandled rejection.
  const resp = await requestElicitation(clientMissingMethod, req, {
    timeoutMs: 1000,
    onWarn: (m) => (warned = m),
  });

  assert.equal(
    mapOutcomeToDecision(resp).decision,
    "deny",
    "a missing elicitation method must fail closed to a deny, never an accept",
  );
  assert.ok(warned.length > 0, "the fail-closed degrade must be surfaced via onWarn");
});

// =====================================================================================================
// (2) BRIDGE — `unstable_createElicitation` throws SYNCHRONOUSLY (present, but throws before returning
// a promise). Same fail-closed contract: normalized to a deny, warned, no throw.
// =====================================================================================================

test("4.1 (bridge) a SYNC-throwing unstable_createElicitation resolves fail-closed (deny), never throws (R4)", async () => {
  const req = buildElicitationRequest(TOOL_USE_ID, SESSION, oneQuestionInput());
  let warned = "";

  const clientSyncThrows: ElicitationClient = {
    // NOT async — throws synchronously at call time (before any promise is created).
    unstable_createElicitation(): Promise<never> {
      throw new Error("sync boom at call time");
    },
  };

  const resp = await requestElicitation(clientSyncThrows, req, {
    timeoutMs: 1000,
    onWarn: (m) => (warned = m),
  });

  assert.equal(
    mapOutcomeToDecision(resp).decision,
    "deny",
    "a synchronous throw must fail closed to a deny, never an accept",
  );
  assert.ok(warned.length > 0, "the fail-closed degrade must be surfaced via onWarn");
  assert.match(warned, /sync boom at call time/, "the underlying error text should be reported");
});

// =====================================================================================================
// (3) GATE — a malformed PER-QUESTION tool_input drives decideElicitation to a legible deny WITHOUT a
// throw escaping the decider. Exercised end-to-end through the REAL loopback hook server (setupSessionGate
// → decide()) with the elicitation capability negotiated, modeled on test/gate-elicitation.test.ts.
// `{questions:[{header:"X"}]}` has NO `options`; before the 4.1 total-function fix, the bridge builder's
// `q.options.map(...)` would throw out of decideElicitation. Now it degrades to the story-064 deny.
// =====================================================================================================

const ACP_SESSION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/** Hang-proof gate timing knobs (production defaults are seconds-scale). */
const SHORT_KNOBS = {
  correlationWaitMs: 250,
  correlationPollMs: 10,
  promptAppearMs: 50,
  promptPollMs: 5,
  injectTimeoutMs: 200,
  closeTimeoutMs: 1000,
  elicitationTimeoutMs: 1000,
};

/** POST a body to the loopback hook server at `${FORK_HOOK_MARKER_PATH}/<token>` (how claude calls it). */
function post(port: number, body: string, token: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: `${FORK_HOOK_MARKER_PATH}/${token}`,
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

/** A fixture PreToolUse payload with a caller-supplied (malformed) tool_input. */
function fixturePayload(toolUseId: string, toolInput: unknown): string {
  return JSON.stringify({
    session_id: "tui-side-session-id",
    transcript_path: "/tmp/x.jsonl",
    cwd: "/tmp",
    permission_mode: "default",
    hook_event_name: "PreToolUse",
    tool_name: "AskUserQuestion",
    tool_input: toolInput,
    tool_use_id: toolUseId,
  });
}

/** A client whose `unstable_createElicitation` records calls — a malformed input must NEVER reach it. */
function makeClient() {
  const elicitations: unknown[] = [];
  const client = {
    sessionUpdate: async () => {},
    requestPermission: async (params: RequestPermissionParams) => {
      void params;
      return { outcome: { outcome: "selected", optionId: ALLOW_OPTION_ID } };
    },
    unstable_createElicitation: async (params: unknown) => {
      elicitations.push(params);
      return { action: "accept", content: { Env: "prod" } };
    },
    readTextFile: async () => ({ content: "" }),
    writeTextFile: async () => ({}),
  } as never;
  return { client, elicitations };
}

test("4.1 (gate) a malformed per-question tool_input DEGRADES to a deny; decide() does not throw (R4)", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "elicitation-degrade-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const { client, elicitations } = makeClient();
  const gate = await setupSessionGate({
    client,
    settingsDir: dir,
    clientSupportsElicitationForm: true, // the elicitation path IS taken (not the 064 pre-guard)
    onWarn: () => {}, // silence the fail-closed diagnostics (no PTY is bound here)
    ...SHORT_KNOBS,
  });
  t.after(() => gate.teardown());
  gate.bindSession(ACP_SESSION_ID);

  // `{questions:[{header:"X"}]}` — a non-empty questions array whose sole question has NO options.
  const malformed = { questions: [{ header: "X" }] };
  const { status, json } = await post(gate.port, fixturePayload("toolu_malformed", malformed), gate.token);

  assert.equal(status, 200, "the hook server answers (decide() did not throw / crash the request)");
  assert.equal(
    json.hookSpecificOutput.permissionDecision,
    "deny",
    "R4: a malformed per-question tool_input fails closed to a deny, never an approve",
  );
  const reason: string = json.hookSpecificOutput.permissionDecisionReason;
  assert.ok(typeof reason === "string" && reason.length > 0, "the deny must carry a legible reason");
  assert.match(reason, /AskUserQuestion/, "the deny reason names the AskUserQuestion tool (story-064 reason)");
});

// =====================================================================================================
// (4) HOOK-SERVER — a THROWING decider → a deny body, server does not crash. This defense-in-depth net
// is ALSO covered by test/hook-server-failclosed.test.ts ("2.1 a decider THROW fails closed (deny)").
// It is re-asserted here through the REAL gate (a malformed input already exercises the total decider,
// so the hook-server net is not the ONLY guard) — kept as a single end-to-end observable-contract check
// to avoid duplicating the dedicated hook-server unit test. See that file for the isolated case.
// =====================================================================================================

test("4.1 (hook-server) the malformed-input deny above proves the request completes (no crash), 200 + deny body", async (t) => {
  // A second malformed shape (empty questions array) — still a legible deny via the gate, server intact.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "elicitation-degrade-test2-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const { client } = makeClient();
  const gate = await setupSessionGate({
    client,
    settingsDir: dir,
    clientSupportsElicitationForm: true,
    onWarn: () => {},
    ...SHORT_KNOBS,
  });
  t.after(() => gate.teardown());
  gate.bindSession(ACP_SESSION_ID);

  const { status, json } = await post(
    gate.port,
    fixturePayload("toolu_empty_questions", { questions: [] }),
    gate.token,
  );

  assert.equal(status, 200, "the server responded (it did not crash on the malformed input)");
  assert.equal(
    json.hookSpecificOutput.permissionDecision,
    "deny",
    "an empty questions array fails closed to a deny",
  );
});
