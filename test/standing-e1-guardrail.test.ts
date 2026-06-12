// Story 036 / Task 3.2 (R5.1, R5.2) — the entrypoint=='cli' E1 billing guard-rail as a STANDING check.
//
// Wires the EXISTING story-022 guard-rail assertion (inspectEvent / guardEvent — the E1 invariant
// from stories 002/022) into the regression suite as a permanent check: it passes for a cli-entrypoint
// (subscription) event and FAILS (aborts the session via the injected hooks) for any non-cli
// entrypoint. This story REUSES the assertion — it does not redefine the E1 invariant.
//
// node:test runner: `node --experimental-strip-types --test test/standing-e1-guardrail.test.ts`
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { inspectEvent, guardEvent, assertCleanBillingEnv } from "../dist/billing/entrypoint-guard.js";

/** Drive the guard against a billable event and capture whether it aborted (the standing E1 gate). */
function runGuard(entrypoint: string | undefined) {
  const event: Record<string, unknown> = {
    type: "assistant",
    sessionId: "sess-e1",
    uuid: "e1-evt",
    ...(entrypoint === undefined ? {} : { entrypoint }),
    message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
  };
  let aborted = false;
  let stopInfo: { entrypoint: string; entrypointClass: string } | undefined;
  const decision = guardEvent(event as any, {
    alert() {},
    stopSession(info) {
      aborted = true;
      stopInfo = info;
    },
  });
  return { decision, aborted, stopInfo };
}

// === R5.1 — the standing E1 check PASSES for entrypoint=='cli' (subscription) ===================

test("standing E1: entrypoint=='cli' is allowed — the subscription invariant holds (R5.1)", () => {
  const { decision, aborted } = runGuard("cli");
  assert.equal(decision.action, "allow", "cli is the E1 subscription entrypoint — allowed");
  assert.equal(aborted, false, "no session stop for the cli entrypoint");
  // inspectEvent (the pure decision) agrees — the standing check is the reused assertion, not a re-impl.
  assert.equal((inspectEvent({ type: "assistant", entrypoint: "cli" } as any) as any).action, "allow");
});

// === R5.2 — the standing E1 check FAILS for any non-cli entrypoint ==============================

test("standing E1: a credit-class entrypoint (sdk-ts) FAILS the standing check — session stopped (R5.2)", () => {
  const { decision, aborted, stopInfo } = runGuard("sdk-ts");
  assert.equal(decision.action, "abort", "sdk-ts bills on API credit — must abort");
  assert.equal(aborted, true, "the standing E1 check stops the session on a non-cli entrypoint");
  assert.equal(stopInfo!.entrypointClass, "credit");
});

test("standing E1: an unknown/absent entrypoint FAILS the standing check (conservative) (R5.2)", () => {
  for (const ep of [undefined, "", "mystery-client"]) {
    const { decision, aborted } = runGuard(ep);
    assert.equal(decision.action, "abort", `entrypoint ${JSON.stringify(ep)} must abort (not silently allowed)`);
    assert.equal(aborted, true, `the session is stopped for entrypoint ${JSON.stringify(ep)}`);
  }
});

// === R5.1 — the spawn-env E1 post-condition is also a standing check (no leaked billing env) =====

test("standing E1: a clean spawn env passes assertCleanBillingEnv; a leaked SDK var throws (R5.1, R5.2)", () => {
  // clean env → no throw (the E1 spawn post-condition holds).
  assert.doesNotThrow(() => assertCleanBillingEnv({ PATH: "/usr/bin" }));
  // a leaked CLAUDE_CODE_ENTRYPOINT / CLAUDE_AGENT_SDK_* → refuse to spawn (would bill as credit).
  assert.throws(
    () => assertCleanBillingEnv({ PATH: "/usr/bin", CLAUDE_CODE_ENTRYPOINT: "sdk-ts" }),
    /REFUSING TO SPAWN/,
    "a leaked entrypoint env var must fail the standing E1 check",
  );
  assert.throws(
    () => assertCleanBillingEnv({ CLAUDE_AGENT_SDK_VERSION: "0.3.156" }),
    /REFUSING TO SPAWN/,
    "a leaked CLAUDE_AGENT_SDK_* var must fail the standing E1 check",
  );
});

// === the standing check is the REUSED story-022 assertion, not a re-implementation ==============

test("standing E1: the check imports the story-022 guard-rail (reuse, not a local re-impl) (R5.1)", () => {
  assert.equal(typeof inspectEvent, "function", "inspectEvent is the reused story-022 export");
  assert.equal(typeof guardEvent, "function", "guardEvent is the reused story-022 export");
  // this test file must not declare its own classifier (no re-definition of the E1 invariant).
  // NB (the 018/019/3.1 precedent): the guard pattern uses `\s+`/`\b`, never a literal space, so it
  // matches ONLY a genuine local declaration of the reused export and NOT this assertion line itself.
  // For that reason this comment also avoids writing the reused symbol name after a literal "function ".
  const self = readFileSync(new URL("./standing-e1-guardrail.test.ts", import.meta.url), "utf8");
  assert.ok(
    !/function\s+classifyEntrypoint\b/.test(self),
    "the standing check must REUSE the guard-rail, never re-declare the classifier",
  );
});
