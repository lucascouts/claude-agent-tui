import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeAcpAgent } from "../dist/acp-agent.js";

// Story 025 / Task 1.1 — regression guard pinning the fork's `initialize` reply to the
// §15 shape every Degrau-1 translation story depends on: `protocolVersion` is the
// INTEGER 1 (never the string "1"), and `agentCapabilities.loadSession` is true.
//
// This is a UNIT test: it constructs the agent and calls initialize() directly, with
// NO live client and NO NDJSON transport (cf. initialize-smoke.test.ts, which pins the
// same shape end-to-end over stdio, and acp-initialize-purity.test.ts, which pins
// engine-independence). The runtime is already delivered by story 011 — this test locks
// it so a future regression (e.g. protocolVersion → "1", or loadSession dropped) is
// caught. The Zed-SENT protocolVersion and the UNSTABLE-rejection verdict are an
// empirical probe recorded in FORK.md (Task 1.2), not asserted here.

function freshAgent() {
  // initialize() reads only request.clientCapabilities + static config; it never
  // touches this.client / this.sessions, so an empty deps + console logger suffice.
  return new ClaudeAcpAgent({}, console);
}

const clientCapabilities = { fs: { readTextFile: true, writeTextFile: true } };

test('initialize (§15): protocolVersion is the integer 1, never the string "1"', async () => {
  const res = await freshAgent().initialize({ protocolVersion: 1, clientCapabilities });
  assert.equal(typeof res.protocolVersion, "number", "protocolVersion must be a number, not a string");
  assert.ok(Number.isInteger(res.protocolVersion), "protocolVersion must be an integer");
  assert.equal(res.protocolVersion, 1, "protocolVersion must be exactly 1");
  assert.notStrictEqual(res.protocolVersion, "1", 'protocolVersion must not be the string "1"');
});

test("initialize (§15): agentCapabilities.loadSession is true", async () => {
  const res = await freshAgent().initialize({ protocolVersion: 1, clientCapabilities });
  assert.equal(res.agentCapabilities.loadSession, true, "agentCapabilities.loadSession must be true");
});
