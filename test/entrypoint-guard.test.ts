// Story 022 — runtime entrypoint billing guard-rail (abort on credit, never spoof).
// Doc §10 "Auditoria de billing — entrypoint"; binding fixtures from DEGRAU0-RESULTS.md E1
// (clean-env PTY → {cli} = subscription; SDK env + CLAUDE_CODE_ENTRYPOINT=sdk-ts → {sdk-ts} = credit).
//
// node:test runner: `node --experimental-strip-types --test test/entrypoint-guard.test.ts`
// (run `npm run build` first — the behavioural import resolves against ../dist, the degrau-1 norm).
//
// Namespace import (not named) so the file can grow test-first one sub-task at a time: a symbol a
// later task adds (inspectEvent, guardEvent, …) is simply `undefined` until implemented, so only its
// own new cases go Red — the link of the already-green cases is not broken.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as EG from "../dist/billing/entrypoint-guard.js";

// ── Task 1.1 — classifier over the frozen §10 taxonomy ────────────────────────
// SUBSCRIPTION (OK) and CREDIT (ABORT) are the two §10 sets; anything else is 'unknown'
// and MUST NOT fall through to 'subscription' (an unrecognized/new label is treated
// conservatively by the caller — task 2.2).
const SUBSCRIPTION = ["cli", "claude-vscode", "vscode", "jetbrains", "firstParty", "local-agent"];
const CREDIT = ["sdk-ts", "sdk-py", "sdk-cli", "print"];

test("1.1 every §10 subscription label classifies as 'subscription'", () => {
  for (const e of SUBSCRIPTION) {
    assert.equal(EG.classifyEntrypoint(e), "subscription", `${e} must classify as subscription`);
  }
});

test("1.1 every §10 credit label classifies as 'credit'", () => {
  for (const e of CREDIT) {
    assert.equal(EG.classifyEntrypoint(e), "credit", `${e} must classify as credit`);
  }
});

test("1.1 an unrecognized label classifies as 'unknown' (never 'subscription')", () => {
  for (const e of ["sdk-future", "agent-x", "unknown-label", ""]) {
    const got = EG.classifyEntrypoint(e);
    assert.equal(got, "unknown", `${JSON.stringify(e)} must classify as unknown`);
    assert.notEqual(got, "subscription", "an unknown label must never fall through to subscription");
  }
});

// ── Task 2.1 — read entrypoint per message event, skip lightweight types ──────
// inspectEvent is a PURE decision over one watched event (the SessionMessage shape delivered by the
// story-015 watcher). Lightweight types (summary, system, file-history-snapshot, …) structurally
// lack `.entrypoint` and are SKIPPED — a structurally-absent field is NOT a violation. assistant/user
// events read `.entrypoint`; a missing/empty `.entrypoint` on such an event is routed as 'unknown'
// (NOT allowed — do not silently allow a fieldless message event).
//
// Decision shape pinned by these tests:
//   { action: 'skip' }
//   | { action: 'allow';  entrypoint: string; entrypointClass: 'subscription' }
//   | { action: 'abort';  entrypoint: string; entrypointClass: 'credit' | 'unknown' }

test("2.1 lightweight events (no .entrypoint) are skipped — no classification, no abort", () => {
  for (const type of ["summary", "system", "file-history-snapshot", "x-some-light-type"]) {
    const d = EG.inspectEvent({ type });
    assert.equal(d.action, "skip", `${type} must be skipped`);
  }
});

test("2.1 an 'assistant' event missing .entrypoint is routed as 'unknown', not allowed", () => {
  const d = EG.inspectEvent({ type: "assistant" }); // structurally a message type, but no entrypoint
  assert.notEqual(d.action, "skip", "assistant is a message type — it must be inspected, not skipped");
  assert.notEqual(d.action, "allow", "a fieldless assistant event must NOT be allowed");
  assert.equal(d.entrypointClass, "unknown", "missing .entrypoint must route as 'unknown'");
});

test("2.1 a 'user' event with empty .entrypoint is routed as 'unknown', not allowed", () => {
  const d = EG.inspectEvent({ type: "user", entrypoint: "" });
  assert.notEqual(d.action, "allow", "an empty .entrypoint must NOT be allowed");
  assert.equal(d.entrypointClass, "unknown", "empty .entrypoint must route as 'unknown'");
});

test("2.1 message events ARE classified by their .entrypoint (cli routes, sdk-ts routes)", () => {
  assert.equal(EG.inspectEvent({ type: "assistant", entrypoint: "cli" }).entrypointClass, "subscription");
  assert.equal(EG.inspectEvent({ type: "user", entrypoint: "sdk-ts" }).entrypointClass, "credit");
});

// ── Task 2.2 — allow subscription, abort/alert on credit (never spoof) ────────
// guardEvent(event, hooks) applies inspectEvent's decision against injected hooks:
//   - 'allow'  → no side effect (continue the stream).
//   - 'abort'  → raise a LOUD alert (carrying the offending entrypoint value AND the session id)
//                and STOP the session (hooks.stopSession). 'unknown' is treated conservatively as a
//                violation per §10.
// It NEVER mutates/defaults/overwrites the observed `entrypoint` toward 'cli' (forcing = evasion, §10).
//
// Hooks shape pinned by these tests:
//   interface GuardHooks {
//     alert(message: string): void;
//     stopSession(info: { entrypoint: string; sessionId?: string; entrypointClass: "credit" | "unknown" }): void;
//   }
function makeHooks() {
  const alerts: string[] = [];
  const stops: Array<{ entrypoint: string; sessionId?: string; entrypointClass: string }> = [];
  const hooks = {
    alert: (m: string) => void alerts.push(m),
    stopSession: (info: { entrypoint: string; sessionId?: string; entrypointClass: string }) =>
      void stops.push(info),
  };
  return { hooks, alerts, stops };
}

test("2.2 a 'cli' assistant event passes — no abort, no alert, no stop, no mutation", () => {
  const { hooks, alerts, stops } = makeHooks();
  const event = { type: "assistant", entrypoint: "cli", sessionId: "sess-ok" };
  const d = EG.guardEvent(event, hooks);
  assert.equal(d.action, "allow");
  assert.equal(alerts.length, 0, "subscription must not alert");
  assert.equal(stops.length, 0, "subscription must not stop the session");
  assert.equal(event.entrypoint, "cli", "the observed entrypoint must not be mutated");
});

test("2.2 a planted 'sdk-ts' event aborts: loud alert (value + session id) + stops session", () => {
  const { hooks, alerts, stops } = makeHooks();
  const event = { type: "assistant", entrypoint: "sdk-ts", sessionId: "sess-credit" };
  const d = EG.guardEvent(event, hooks);
  assert.equal(d.action, "abort");
  assert.equal(d.entrypointClass, "credit");
  assert.equal(stops.length, 1, "a credit-class label must stop the session");
  assert.equal(alerts.length, 1, "a credit-class label must raise a loud alert");
  assert.match(alerts[0], /sdk-ts/, "the alert must surface the offending entrypoint value");
  assert.match(alerts[0], /sess-credit/, "the alert must surface the session id");
  assert.equal(stops[0].entrypoint, "sdk-ts");
  assert.equal(stops[0].sessionId, "sess-credit");
});

test("2.2 the guard NEVER writes back a mutated entrypoint (no spoof toward 'cli')", () => {
  const { hooks } = makeHooks();
  const event = { type: "assistant", entrypoint: "sdk-ts", sessionId: "s" };
  EG.guardEvent(event, hooks);
  assert.equal(event.entrypoint, "sdk-ts", "entrypoint must remain verbatim — forcing it to 'cli' is evasion (§10)");
});

test("2.2 an 'unknown' label is treated conservatively as a violation (abort + stop)", () => {
  const { hooks, stops } = makeHooks();
  const event = { type: "assistant", entrypoint: "sdk-future", sessionId: "s2" };
  const d = EG.guardEvent(event, hooks);
  assert.equal(d.action, "abort");
  assert.equal(d.entrypointClass, "unknown");
  assert.equal(stops.length, 1, "an unrecognized label must not bill silently — it stops the session");
});

test("2.2 a lightweight event is a no-op (skip — no alert, no stop)", () => {
  const { hooks, alerts, stops } = makeHooks();
  const d = EG.guardEvent({ type: "summary" }, hooks);
  assert.equal(d.action, "skip");
  assert.equal(alerts.length, 0);
  assert.equal(stops.length, 0);
});

// ── Task 3.1 — startup self-check: fail fast on leaked SDK env ─────────────────
// assertCleanBillingEnv(env) throws (fail-fast) if the env about to be passed to spawn still carries
// any billing-sensitive key: any `CLAUDE_AGENT_SDK_*` (prefix — covers VERSION, CLIENT_APP, future
// siblings) or the exact `CLAUDE_CODE_ENTRYPOINT`. Inheriting these from the parent Node/ACP process
// would silently flip the spawned TUI to credit (R1) BEFORE any message event is produced — so this
// must run BEFORE spawn. It is the ASSERTION that the spawn helper's env-sanitize worked; it does NOT
// delete-and-continue. `CLAUDECODE` is deliberately NOT checked here: that is the spawn helper's
// anti-recusa concern, distinct from this billing check (§10).
const CLEAN_ENV = { PATH: "/usr/bin:/bin", HOME: "/home/u", LANG: "en_US.UTF-8" };

test("3.1 a clean env passes assertCleanBillingEnv (no throw)", () => {
  assert.doesNotThrow(() => EG.assertCleanBillingEnv({ ...CLEAN_ENV }));
});

test("3.1 a leaked CLAUDE_CODE_ENTRYPOINT fails fast, naming the key", () => {
  assert.throws(
    () => EG.assertCleanBillingEnv({ ...CLEAN_ENV, CLAUDE_CODE_ENTRYPOINT: "sdk-ts" }),
    /CLAUDE_CODE_ENTRYPOINT/,
  );
});

test("3.1 a leaked CLAUDE_AGENT_SDK_VERSION fails fast, naming the key", () => {
  assert.throws(
    () => EG.assertCleanBillingEnv({ ...CLEAN_ENV, CLAUDE_AGENT_SDK_VERSION: "0.1.0" }),
    /CLAUDE_AGENT_SDK_VERSION/,
  );
});

test("3.1 the CLAUDE_AGENT_SDK_ prefix catches future siblings (CLIENT_APP)", () => {
  assert.throws(
    () => EG.assertCleanBillingEnv({ ...CLEAN_ENV, CLAUDE_AGENT_SDK_CLIENT_APP: "vscode" }),
    /CLAUDE_AGENT_SDK_CLIENT_APP/,
  );
});

test("3.1 CLAUDECODE alone does NOT trip the billing check (distinct anti-recusa concern, §10)", () => {
  assert.doesNotThrow(() => EG.assertCleanBillingEnv({ ...CLEAN_ENV, CLAUDECODE: "1" }));
});
