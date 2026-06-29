import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeAcpAgent } from "../dist/acp-agent.js";

// Story 061 / Task 2.1 — regression guard for the `session/delete` wire name.
//
// acp-sdk 1.0.0 dispatches the `session/delete` wire method to the agent handler
// named EXACTLY `deleteSession` (no `unstable_` prefix). The SDK's registration gate
// is (node_modules/@agentclientprotocol/sdk/dist/acp.js:972):
//
//     if (implementation.deleteSession) {
//         app.onRequest(AGENT_METHODS.session_delete,
//                       async (ctx) => (await implementation.deleteSession(ctx.params)) ?? {});
//     }
//
// The fork had named the handler `unstable_deleteSession`, so that `if` was false and
// `session/delete` was never registered — the handler was dead code over the wire, and
// a client (Zed) calling `session/delete` got a no-op instead of a torn-down session.
// These tests fail (Red) while the handler carries the `unstable_` prefix and pass
// (Green) once it is renamed to `deleteSession`.
//
// `unstable_forkSession` MUST keep its prefix (acp.js:975 binds
// `implementation.unstable_forkSession` for `session/fork`), so it is guarded here too
// against an accidental over-eager rename (story R3 / U2).
//
// Hermetic by design: asserts the public class surface plus a thin shim mirroring the
// SDK's bind logic — no PTY, no disk, no SDK private state. The handler body's teardown
// + on-disk-transcript removal is unchanged by the rename (only the method name changes)
// and is covered by `tsc` over the untouched body; the test runner does not enable
// `--experimental-test-module-mocks`, so the external disk helper cannot be module-mocked
// here, and exercising it for real would couple this wire test to on-disk transcript layout.

function freshAgent() {
  // The handler surface lives on the prototype; an empty client stub is sufficient to
  // inspect it — same construction the initialize-purity suite uses (no engine/session).
  return new ClaudeAcpAgent({}, console);
}

test("session/delete wire: handler is named deleteSession (no unstable_ prefix)", () => {
  const agent = freshAgent();
  assert.equal(
    typeof agent.deleteSession,
    "function",
    "acp-sdk 1.0.0 dispatches session/delete → implementation.deleteSession",
  );
  assert.equal(
    agent.unstable_deleteSession,
    undefined,
    "unstable_deleteSession is dead code under acp-sdk 1.0.0 — the prefixed name must be gone",
  );
});

test("session/delete wire: SDK registration gate selects the handler", () => {
  const agent = freshAgent();
  // Mirror the SDK's bind logic: it registers session/delete ONLY when
  // `implementation.deleteSession` is present. A wrongly-prefixed name leaves it unbound.
  let registered = null;
  const app = {
    onRequest: (method) => {
      registered = method;
    },
  };
  if (agent.deleteSession) {
    app.onRequest("session/delete", (ctx) => agent.deleteSession(ctx.params));
  }
  assert.equal(
    registered,
    "session/delete",
    "session/delete must register because implementation.deleteSession is present",
  );
});

test("session/fork wire: unstable_forkSession KEEPS its prefix (not renamed by mistake)", () => {
  const agent = freshAgent();
  assert.equal(
    typeof agent.unstable_forkSession,
    "function",
    "acp-sdk 1.0.0 still dispatches session/fork → implementation.unstable_forkSession (prefix stays)",
  );
});
