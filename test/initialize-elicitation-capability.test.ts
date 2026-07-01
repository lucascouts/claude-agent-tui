import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeAcpAgent } from "../dist/acp-agent.js";

// Story 065 / Task 1.1 — capability negotiation at initialize (R1, R3).
//
// `initialize()` must derive a plain boolean `clientSupportsElicitationForm` from the
// incoming `clientCapabilities.elicitation.form`, using PRESENCE (`!= null`), never the
// truthiness of a property: the UNSTABLE `ElicitationFormCapabilities` type carries only
// an optional `_meta`, so a client may legitimately advertise `form` as an empty `{}`.
//   - a present (non-null) `form`  → true  (R1: relay via elicitation)
//   - `elicitation` present, no `form` → false (R3: story-064 deny fallback)
//   - no `elicitation` key          → false (R3)
//   - `form: null`                  → false (`!= null` covers null, not only undefined)
//
// This is a UNIT test mirroring acp-initialize-purity.test.ts: it constructs the agent
// directly and calls initialize() with NO live client / NO NDJSON transport. initialize()
// never reads this.client / this.sessions, so an empty client stub + console logger suffice.
// It imports the class from the built tree (../dist/acp-agent.js) because src/acp-agent.ts's
// internal `./x.js` specifiers only resolve after `tsc` (hence Validation builds first).
// This sub-task establishes the flag ONLY; the gate branch it drives lands in task 3.1.

function freshAgent() {
  return new ClaudeAcpAgent({}, console);
}

async function flagFor(clientCapabilities) {
  const agent = freshAgent();
  await agent.initialize({ protocolVersion: 1, clientCapabilities });
  return agent.clientSupportsElicitationForm;
}

test("initialize elicitation (R1): a present `elicitation.form` (empty {}) sets the flag true", async () => {
  const flag = await flagFor({ elicitation: { form: {} } });
  assert.equal(
    flag,
    true,
    "a present (non-null) form — even an empty {} — must be detected by presence, not property truthiness",
  );
});

test("initialize elicitation (R3): `elicitation` present but no `form` leaves the flag false", async () => {
  const flag = await flagFor({ elicitation: {} });
  assert.equal(flag, false, "no form advertised → unsupported → deny-guard fallback");
});

test("initialize elicitation (R3): no `elicitation` key leaves the flag false", async () => {
  const flag = await flagFor({ fs: { readTextFile: true, writeTextFile: true } });
  assert.equal(flag, false, "no elicitation capability at all → unsupported → deny-guard fallback");
});

test("initialize elicitation (R3): `form: null` leaves the flag false (`!= null` covers null)", async () => {
  const flag = await flagFor({ elicitation: { form: null } });
  assert.equal(flag, false, "an explicit null form must be treated as unsupported, not truthy");
});

test("initialize elicitation: the flag defaults to false before initialize() runs", () => {
  // A freshly-constructed agent that has never negotiated must not claim support.
  assert.equal(
    freshAgent().clientSupportsElicitationForm,
    false,
    "the field must be a plain boolean defaulting to false (safe fallback)",
  );
});

test("initialize elicitation: the flag is a plain boolean, never the raw capability object", async () => {
  // Guards against a regression that stores the `form` object (truthy but not `true`)
  // instead of a normalized boolean — a later `=== true` gate check would then break.
  const flag = await flagFor({ elicitation: { form: {} } });
  assert.equal(typeof flag, "boolean", "must be normalized to a boolean, not the form object");
  assert.strictEqual(flag, true, "must be the boolean true, not merely truthy");
});
