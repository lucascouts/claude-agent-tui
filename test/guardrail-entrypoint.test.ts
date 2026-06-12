// Story 027 / Task 6.1 — re-assert the §10 billing guard-rail in-product (R4.1, R4.2; E1 keystone).
//
// After an in-product turn, the live transcript's DISTINCT message-event entrypoint set must be
// exactly {cli} — the §10 selector `select(.type=='assistant' or .type=='user') | .entrypoint`. Any
// of sdk-ts/sdk-py/sdk-cli/print appearing means the run is billing on API CREDIT, not the
// subscription, and the guard-rail (consumed from story 022) MUST fail loudly, naming the offending
// value — never spoofing the label toward 'cli'. The entrypoint arises ORGANICALLY from the clean-env
// spawn (story 013); this guard only READS and REACTS.
//
// node:test runner: `node --experimental-strip-types --test test/guardrail-entrypoint.test.ts` (build first).
import { test } from "node:test";
import assert from "node:assert/strict";
import { inspectEvent, guardEvent, classifyEntrypoint } from "../dist/billing/entrypoint-guard.js";

/** §10 distinct-entrypoint extractor over message events (type assistant|user), via the story-022 guard. */
function distinctEntrypoints(records: any[]): Set<string> {
  const set = new Set<string>();
  for (const r of records) {
    const d = inspectEvent(r);
    if (d.action !== "skip") set.add(d.entrypoint);
  }
  return set;
}

// An in-product (clean-env spawn) transcript: every message event self-labels entrypoint 'cli';
// lightweight (non-message) types structurally lack entrypoint and are skipped.
const cliTranscript = [
  { type: "summary", summary: "compacted" }, // lightweight → skipped
  { type: "user", entrypoint: "cli", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
  { type: "assistant", entrypoint: "cli", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
  { type: "file-history-snapshot" }, // lightweight → skipped
  { type: "assistant", entrypoint: "cli", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
];

test("guard-rail: a clean in-product transcript's distinct message-event entrypoint set is exactly {cli} (R4.2, E1)", () => {
  const set = distinctEntrypoints(cliTranscript);
  assert.deepEqual([...set], ["cli"], "the distinct message-event entrypoint set must be exactly {cli}");
});

test("guard-rail: lightweight (non-message) events are skipped — they never enter the entrypoint set", () => {
  const set = distinctEntrypoints(cliTranscript);
  assert.equal(set.size, 1, "summary / file-history-snapshot contribute nothing; only message events count");
});

test("guard-rail: a seeded sdk-ts event FAILS LOUDLY — alert names the offending value + session, session stopped (R4.2)", () => {
  const seeded = {
    type: "assistant",
    entrypoint: "sdk-ts",
    sessionId: "sess-x",
    message: { role: "assistant", content: [{ type: "text", text: "credit-billed" }] },
  };
  let alerted = "";
  let stopped: any = null;
  const hooks = {
    alert: (m: string) => {
      alerted = m;
    },
    stopSession: (info: any) => {
      stopped = info;
    },
  };
  const decision = guardEvent(seeded, hooks);
  assert.equal(decision.action, "abort", "an sdk-ts message event aborts (credit billing, not subscription)");
  assert.match(alerted, /sdk-ts/, "the alert names the offending entrypoint value loudly (no spoofing to 'cli')");
  assert.match(alerted, /sess-x/, "the alert names the offending session id");
  assert.ok(stopped, "the session is stopped on the violation");
  assert.equal(stopped.entrypoint, "sdk-ts", "stopSession carries the offending entrypoint verbatim");
});

test("guard-rail: each §10 CREDIT label classifies as credit; 'cli' is subscription (no silent allow)", () => {
  for (const e of ["sdk-ts", "sdk-py", "sdk-cli", "print"]) {
    assert.equal(classifyEntrypoint(e), "credit", `${e} must classify as credit`);
  }
  assert.equal(classifyEntrypoint("cli"), "subscription", "cli is the subscription keystone (E1)");
});

test("guard-rail: a transcript seeded with an SDK value no longer extracts to a clean {cli} set", () => {
  const tainted = [...cliTranscript, { type: "assistant", entrypoint: "sdk-ts", message: { role: "assistant", content: [] } }];
  const set = distinctEntrypoints(tainted);
  assert.notDeepEqual([...set].sort(), ["cli"], "a seeded sdk-ts value breaks the {cli}-only invariant");
  assert.ok(set.has("sdk-ts"), "the offending value is surfaced in the distinct set, not hidden");
});
