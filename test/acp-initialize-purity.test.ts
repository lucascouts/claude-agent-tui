import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeAcpAgent } from "../dist/acp-agent.js";

// Story 011 / Task 1.2 — prove ClaudeAcpAgent.initialize() derives its response
// SOLELY from the incoming `clientCapabilities` plus static fork config, and never
// from engine/session state (§3 "initialize() só depende de clientCapabilities";
// §4 "Camada ACP REUSA integral — independe do motor"). Behavioral test against the
// built agent (dist/): each agent is constructed fresh and initialize() is called,
// then responses are compared across inputs. `initialize` never reads `this.client`,
// so an empty client stub is sufficient. Run under `node --test` against dist/ —
// the source's `./x.js` specifiers only resolve in the built tree.

function freshAgent() {
  // initialize() touches only request.clientCapabilities + static config; it never
  // reads this.client / this.sessions, so an empty client stub is sufficient.
  return new ClaudeAcpAgent({}, console);
}

async function initializeWith(clientCapabilities) {
  return freshAgent().initialize({ protocolVersion: 1, clientCapabilities });
}

// Two inputs that DIFFER but hold the auth-relevant fields constant (neither carries
// an `auth` block), so the entire capability block must come out identical.
const capsA = { fs: { readTextFile: true, writeTextFile: true } };
const capsB = { fs: { readTextFile: false, writeTextFile: false }, terminal: false };
// A third input whose auth flag DOES drive authMethods — proves the response is a
// pure function of clientCapabilities (the only varying input), never of an engine.
const capsGateway = { auth: { _meta: { gateway: true } } };

test("initialize purity: agentCapabilities + agentInfo are static (engine-independent across differing inputs)", async () => {
  const a = await initializeWith(capsA);
  const b = await initializeWith(capsB);
  const g = await initializeWith(capsGateway);
  assert.deepEqual(a.agentCapabilities, b.agentCapabilities);
  assert.deepEqual(a.agentCapabilities, g.agentCapabilities);
  assert.deepEqual(a.agentInfo, b.agentInfo);
  assert.deepEqual(a.agentInfo, g.agentInfo);
});

test("initialize purity: full block is invariant when auth-relevant input is held constant", async () => {
  const a = await initializeWith(capsA);
  const b = await initializeWith(capsB);
  assert.deepEqual(
    a,
    b,
    "response must depend only on clientCapabilities, not on non-auth fields that differ",
  );
});

test("initialize purity: authMethods derives from clientCapabilities (no engine input exists to vary)", async () => {
  const plain = await initializeWith(capsA);
  const gateway = await initializeWith(capsGateway);
  // No auth caps → no auth methods; the gateway cap → gateway methods appear. The
  // response changes ONLY because the clientCapabilities input changed.
  assert.deepEqual(plain.authMethods, []);
  assert.ok(
    gateway.authMethods.some((m) => m.id === "gateway"),
    "gateway clientCapabilities must surface the gateway auth method",
  );
});

test("initialize purity: initialize creates no engine/session state", async () => {
  const agent = freshAgent();
  await agent.initialize({ protocolVersion: 1, clientCapabilities: capsA });
  // initialize records clientCapabilities but must not spin up any engine/session.
  assert.deepEqual(agent.sessions, {}, "initialize must not create sessions / engine state");
  assert.deepEqual(agent.clientCapabilities, capsA, "initialize records the incoming clientCapabilities");
});
