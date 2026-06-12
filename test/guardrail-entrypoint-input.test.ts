// Story 034 / Task 4.1 — the §10 billing guard-rail holds across INPUT-DRIVEN turns (R4.1, R4.2).
//
// Degrau 1 proved entrypoint=={cli} for TUI-driven turns; Degrau 2's reverse path (Zed input →
// PTY) must not weaken it — the sanitized spawn (013) plus the gated spawn's `--settings` flag
// (034) must keep every message event self-labelled `cli`. The LIVE halves were verified during
// the 034 acceptance runs (sessions 47952c58/e2f75483: gated Write deny+allow turns, distinct
// entrypoint set {cli}); THIS file is the offline regression: the §10 selector over a multi-turn
// input-driven transcript yields exactly {cli}, and a seeded SDK/credit value fails LOUDLY.
//
// REUSES the story-022 guard-rail (inspectEvent/guardEvent) — never a local re-implementation.
// node:test runner: `node --experimental-strip-types --test test/guardrail-entrypoint-input.test.ts`
import { test } from "node:test";
import assert from "node:assert/strict";
import { inspectEvent, guardEvent } from "../dist/billing/entrypoint-guard.js";

/** A minimal multi-turn INPUT-DRIVEN transcript: 3 user prompts (typed in Zed) + replies + tools. */
function multiTurnTranscript(entrypoints: { user: string; assistant: string }): unknown[] {
  const { user, assistant } = entrypoints;
  const msg = (type: string, entrypoint: string, extra: object = {}) => ({
    type,
    entrypoint,
    uuid: `${type}-${Math.random().toString(36).slice(2)}`,
    message: { role: type, content: [] },
    ...extra,
  });
  return [
    msg("user", user),
    msg("assistant", assistant, { message: { role: "assistant", content: [], stop_reason: "end_turn" } }),
    msg("user", user), // turn 2 (e.g. the post-cancel prompt)
    msg("assistant", assistant, { message: { role: "assistant", content: [], stop_reason: "tool_use" } }),
    msg("user", user), // tool_result carrier
    msg("assistant", assistant, { message: { role: "assistant", content: [], stop_reason: "end_turn" } }),
    msg("user", user), // turn 3
    msg("assistant", assistant, { message: { role: "assistant", content: [], stop_reason: "end_turn" } }),
  ];
}

/** The §10 selector: the DISTINCT entrypoint set over message events (assistant|user). */
function distinctEntrypoints(events: unknown[]): Set<string> {
  const set = new Set<string>();
  for (const e of events) {
    const ev = e as { type?: string; entrypoint?: string };
    if (ev.type === "assistant" || ev.type === "user") {
      if (typeof ev.entrypoint === "string") set.add(ev.entrypoint);
    }
  }
  return set;
}

/** Story-022 GuardHooks fake: records every alert + stopSession (the loud abort channels). */
function makeHooks() {
  const stops: Array<{ entrypoint: string; entrypointClass: string }> = [];
  const alerts: string[] = [];
  return {
    hooks: {
      alert: (message: string) => {
        alerts.push(message);
      },
      stopSession: (info: { entrypoint: string; entrypointClass: "credit" | "unknown" }) => {
        stops.push(info);
      },
    } as never,
    stops,
    alerts,
  };
}

test("R4.1/R4.2 — a multi-turn input-driven transcript yields the distinct entrypoint set {cli}", () => {
  const events = multiTurnTranscript({ user: "cli", assistant: "cli" });
  assert.deepEqual([...distinctEntrypoints(events)], ["cli"], "every message event self-labels cli");
  // And the story-022 guard allows every event (subscription class — stopSession never fires).
  const { hooks, stops } = makeHooks();
  for (const e of events) {
    const verdict = inspectEvent(e as never);
    assert.notEqual(verdict.action, "abort", "no event draws an abort");
    guardEvent(e as never, hooks);
  }
  assert.equal(stops.length, 0, "the guard-rail stays green across all input-driven turns");
});

test("R4.1 — a seeded SDK/credit entrypoint fails LOUDLY (never silently shipped as credit)", () => {
  for (const bad of ["sdk-ts", "sdk-py", "sdk-cli", "print"]) {
    const events = multiTurnTranscript({ user: "cli", assistant: bad });
    const set = distinctEntrypoints(events);
    assert.ok(set.has(bad), `the selector surfaces the offending value (${bad})`);
    assert.notDeepEqual([...set], ["cli"], "the distinct set is NOT {cli} when a credit value appears");
    const offender = events.find((e) => (e as { entrypoint?: string }).entrypoint === bad);
    const verdict = inspectEvent(offender as never);
    assert.equal(verdict.action, "abort", `${bad} classifies as an abort`);
    const { hooks, stops, alerts } = makeHooks();
    guardEvent(offender as never, hooks);
    assert.equal(stops.length, 1, "the guard stops the session exactly once");
    assert.equal(stops[0].entrypoint, bad, `the abort names the offending ${bad} value`);
    assert.equal(stops[0].entrypointClass, "credit", "the offending value classifies as credit");
    assert.ok(
      alerts.some((m) => m.includes(bad)),
      "the loud alert message carries the offending value",
    );
  }
});
