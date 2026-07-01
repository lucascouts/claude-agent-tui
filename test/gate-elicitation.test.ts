// Story 065 / Task 3.1 (R1, R2.1, R2.2, R3) — the gate's AskUserQuestion elicitation branch, exercised
// through the REAL loopback hook server (setupSessionGate's decide() chain) + a fake ACP client. OFFLINE:
// no claude, no Zed, no PTY — a 127.0.0.1 hook server is the only live socket, and the gate is torn down
// in each test's own t.after so the runner never hangs.
//
// This is the test-after companion of task 3.1's implementation: with the capability negotiated
// (`clientSupportsElicitationForm: true`), an AskUserQuestion call is driven through a real ACP form
// elicitation (`client.unstable_createElicitation`) and the outcome is mapped back to a deny+reason — the
// tool is ALWAYS denied at the wire (a PreToolUse hook cannot synthesize a native tool_result), and the
// user's selection (or the dismissal note) travels back to the model INSIDE the deny reason. Without the
// capability the gate DEGRADES to the story-064 fail-closed deny-guard and NEVER calls the client.
//
// The decision + reason are asserted by reading them OFF THE HTTP RESPONSE BODY
// (json.hookSpecificOutput.permissionDecision / permissionDecisionReason) — the same wire contract the
// story-064 test uses — not by importing any reason/decision helper.
//
// node:test runner (run `npm run build` first — behavioral imports resolve against ../dist):
//   node --experimental-strip-types --test test/gate-elicitation.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setupSessionGate } from "../dist/permissions/gate-wiring.js";
import { ALLOW_OPTION_ID, type RequestPermissionParams } from "../dist/permissions/request-permission.js";
import { FORK_HOOK_MARKER_PATH } from "../dist/gate/settings-writer.js";

/** The authoritative ACP session id the gate is bound to (an unbound gate fail-closes on decide). */
const ACP_SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

/** Short, hang-proof gate timing knobs (production defaults are seconds-scale). `elicitationTimeoutMs`
 *  is small so a stalled/never-answering fake client would fail closed FAST — but the happy-path fakes
 *  below resolve synchronously, so it is never actually hit in these cases. */
const SHORT_KNOBS = {
  correlationWaitMs: 250,
  correlationPollMs: 10,
  promptAppearMs: 50,
  promptPollMs: 5,
  injectTimeoutMs: 200,
  closeTimeoutMs: 1000,
  elicitationTimeoutMs: 1000,
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

/** A realistic AskUserQuestion tool_input (the shape the bridge projects into a form). */
const ASK_INPUT = {
  questions: [
    {
      question: "Which environment should I deploy to?",
      header: "Env",
      options: [{ label: "prod" }, { label: "staging" }],
    },
  ],
};

/** A fixture PreToolUse payload (GATE_FINDINGS keystone 1.3 shape). The `session_id` is the TUI's own
 *  id, DELIBERATELY different from the bound ACP id — the authoritative (bound) id must win. */
function fixturePayload(
  toolUseId: string,
  toolName = "AskUserQuestion",
  toolInput: unknown = ASK_INPUT,
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

/** Records the elicitation params the gate raised. */
interface RecordedElicitation {
  sessionId: string;
  toolCallId?: string;
  mode?: string;
}

/**
 * A minimal ACP client stub carrying BOTH capabilities the broadened gate `client` type needs:
 *   - `requestPermission` (the story-033 relay — returns ALLOW; only reached by a NON-AskUserQuestion
 *     fall-through, which these tests never take, so it is a guard that never fires here);
 *   - `unstable_createElicitation` (the story-065 bridge) — returns the injected `elicitationResponse`
 *     and records each call so a test can assert whether it was raised.
 */
function makeClient(elicitationResponse: unknown) {
  const permissionCalls: RequestPermissionParams[] = [];
  const elicitations: RecordedElicitation[] = [];
  const client = {
    sessionUpdate: async () => {},
    requestPermission: async (params: RequestPermissionParams) => {
      permissionCalls.push(params);
      return { outcome: { outcome: "selected", optionId: ALLOW_OPTION_ID } };
    },
    unstable_createElicitation: async (params: any) => {
      elicitations.push({ sessionId: params.sessionId, toolCallId: params.toolCallId, mode: params.mode });
      return elicitationResponse;
    },
    readTextFile: async () => ({ content: "" }),
    writeTextFile: async () => ({}),
  } as never;
  return { client, permissionCalls, elicitations };
}

/**
 * Start a REAL gate over fakes + a tmp scratch dir, bind the authoritative ACP session id (no PTY: these
 * cases never reach the allow-sweep), and wire idempotent cleanup. `clientSupportsElicitationForm` is
 * threaded through so a test can toggle the capability (true = elicitation path; false/omitted = the
 * story-064 degrade path).
 */
async function setupGate(
  t: Parameters<NonNullable<Parameters<typeof test>[0]>>[0],
  opts: { elicitationResponse: unknown; clientSupportsElicitationForm?: boolean },
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gate-elicitation-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const { client, permissionCalls, elicitations } = makeClient(opts.elicitationResponse);
  const gate = await setupSessionGate({
    client,
    settingsDir: dir,
    clientSupportsElicitationForm: opts.clientSupportsElicitationForm,
    onWarn: () => {}, // no-op: silence the fail-closed diagnostics (no PTY is bound here)
    ...SHORT_KNOBS,
  });
  t.after(() => gate.teardown()); // closes the hook server + removes the scratch — the runner never hangs

  // bindSession is mandatory: an unbound gate fail-closes (no ACP sessionId to raise an elicitation with).
  // The bound (authoritative) id deliberately differs from the payload's TUI-side id.
  gate.bindSession(ACP_SESSION_ID);

  return { gate, permissionCalls, elicitations };
}

// === (1) R1 + R2.1 — capability present + ACCEPT: the answer is carried back inside the deny reason =====
// With the form capability negotiated, an AskUserQuestion call is driven through a real ACP form
// elicitation. The fake accepts with `{ Env: "prod" }`, so the gate denies at the wire but embeds the
// selection in the reason — the model reads the answer off the deny reason.

test("(1) capability present + accept: AskUserQuestion is DENIED but the reason CARRIES the answer (R1, R2.1)", async (t) => {
  const { gate, permissionCalls, elicitations } = await setupGate(t, {
    clientSupportsElicitationForm: true,
    elicitationResponse: { action: "accept", content: { Env: "prod" } },
  });

  const { status, json } = await post(gate.port, fixturePayload("toolu_ask_accept"), gate.token);

  assert.equal(status, 200, "the hook server answers (it is really listening on the scratch URL's port)");
  assert.equal(
    json.hookSpecificOutput.permissionDecision,
    "deny",
    "R1: AskUserQuestion is ALWAYS denied at the wire — a PreToolUse hook cannot synthesize a tool_result",
  );
  const reason: string = json.hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /prod/, "R2.1: the accepted selection (Env=prod) is carried back inside the deny reason");
  assert.equal(elicitations.length, 1, "R1: exactly one ACP form elicitation was raised");
  assert.equal(
    elicitations[0].sessionId,
    ACP_SESSION_ID,
    "the elicitation carries the AUTHORITATIVE bound ACP session id (bindSession), not the TUI payload's id",
  );
  assert.equal(elicitations[0].toolCallId, "toolu_ask_accept", "the elicitation is tied to the originating tool_use.id");
  assert.equal(elicitations[0].mode, "form", "the elicitation is raised as a form (the negotiated capability)");
  assert.equal(permissionCalls.length, 0, "no generic session/request_permission relay is raised on the elicitation path");
});

// === (2) R2.2 — capability present + DECLINE / CANCEL: a dismissal, never an answer ====================
// A declined or cancelled elicitation maps to a deny whose reason reads as a user dismissal (no answer),
// distinct from the accept reason above. Both dismissal actions are covered.

for (const action of ["decline", "cancel"] as const) {
  test(`(2) capability present + ${action}: AskUserQuestion is DENIED with a dismissal reason (R2.2)`, async (t) => {
    const { gate, permissionCalls, elicitations } = await setupGate(t, {
      clientSupportsElicitationForm: true,
      elicitationResponse: { action },
    });

    const { status, json } = await post(gate.port, fixturePayload(`toolu_ask_${action}`), gate.token);

    assert.equal(status, 200, "the hook server answers");
    assert.equal(
      json.hookSpecificOutput.permissionDecision,
      "deny",
      `R2.2: a ${action} still denies the tool at the wire`,
    );
    const reason: string = json.hookSpecificOutput.permissionDecisionReason;
    assert.match(
      reason,
      /dismiss|declin|cancel|did not|no answer|without/i,
      `R2.2: a ${action} reads as a user dismissal (no answer), not as a selection`,
    );
    assert.doesNotMatch(reason, /prod/, "R2.2: a dismissal carries no fabricated answer");
    assert.equal(elicitations.length, 1, "the ACP form elicitation was still raised (the user dismissed it)");
    assert.equal(permissionCalls.length, 0, "no generic session/request_permission relay is raised on the elicitation path");
  });
}

// === (3) R3 — capability ABSENT (omitted): DEGRADE to the story-064 deny-guard, NEVER call the client ===
// Without `clientSupportsElicitationForm`, the gate keeps the story-064 fail-closed deny-guard: the deny
// reason names AskUserQuestion and cites the bridge limitation, and `unstable_createElicitation` is NEVER
// called (the guard degrades WITHOUT reaching for a capability the client did not negotiate).

test("(3) capability absent (omitted): AskUserQuestion DEGRADES to the story-064 deny-guard and NEVER raises an elicitation (R3)", async (t) => {
  const { gate, permissionCalls, elicitations } = await setupGate(t, {
    // clientSupportsElicitationForm omitted → defaults false (the load-bearing story-064 degrade default)
    elicitationResponse: { action: "accept", content: { Env: "prod" } }, // would be used IF the client were called
  });

  const { status, json } = await post(gate.port, fixturePayload("toolu_ask_degrade"), gate.token);

  assert.equal(status, 200, "the hook server answers");
  assert.equal(json.hookSpecificOutput.permissionDecision, "deny", "R3: AskUserQuestion is denied fail-closed");
  const reason: string = json.hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /AskUserQuestion/, "R3: the degrade reason names the AskUserQuestion tool (story-064 reason)");
  assert.match(reason, /bridge/i, "R3: the degrade reason cites the bridge limitation (story-064 reason)");
  assert.doesNotMatch(reason, /prod/, "R3: the degrade path never reaches the client, so no answer leaks into the reason");
  assert.equal(elicitations.length, 0, "R3: the capability-absent path NEVER calls unstable_createElicitation");
  assert.equal(permissionCalls.length, 0, "R3: nor does it raise a generic session/request_permission relay");
});

// === (R6 invariant) — this path introduces NO one-shot query()/`-p`/`stream-json` and does NOT alter the
// spawn entrypoint. The elicitation branch runs ENTIRELY inside the loopback-hook decider over the kept
// AgentSideConnection (unstable_createElicitation) + the pure bridge; it spawns nothing and touches no
// engine argv. The spawn-entrypoint invariant (single interactive `claude` PTY, no `-p`/`--print`, no
// `--output-format stream-json`, no SDK `query()`) is owned END-TO-END by test/entrypoint-guard.test.ts
// and test/guardrail-entrypoint.test.ts; this suite deliberately does NOT duplicate them — it only
// source-guards that gate-wiring itself introduced none of those tokens on the new elicitation path.
test("(R6) the gate elicitation path introduces NO query()/-p/stream-json and does not touch the spawn entrypoint", async () => {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const src = await fs.readFile(path.join(here, "..", "src", "permissions", "gate-wiring.ts"), "utf8");
  assert.doesNotMatch(src, /--print\b|(^|[^\w-])-p\b/m, "gate-wiring must not introduce a one-shot -p/--print spawn");
  assert.doesNotMatch(src, /stream-json/, "gate-wiring must not introduce a stream-json output format");
  assert.doesNotMatch(src, /\bquery\s*\(/, "gate-wiring must not call the SDK query() one-shot entrypoint");
  // The authoritative entrypoint invariant lives in entrypoint-guard / guardrail-entrypoint (see comment).
});
