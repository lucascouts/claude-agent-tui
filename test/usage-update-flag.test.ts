// Story 036 / Task 4.1 (R6.1, R6.2, R6.3) — usage_update is emitted ONLY behind a disable-able
// feature flag, mapping the JSONL `usage.{input,output}_tokens`, and is suppressed entirely when the
// flag is off WITHOUT dropping the surrounding core (text / tool_call) updates (R8 — the UNSTABLE
// variant may be rejected by the user's Zed).
//
// CONSOLIDATION-ONLY: this story authors no new usage logic. It drives the SHARED corpus
// (corpus-all-types.jsonl, line c-asst-final carries usage AND an assistant text block) through the
// REUSED translator (classifyEvent + the unmodified toAcpNotifications → the CORE thread) and the
// REUSED story-025 gate (usageUpdatesFor, src/usage.ts → the flag-gated usage_update), then asserts
// the flag-on / flag-off / default postures. It re-implements neither the translator nor the gate
// (self-guard at the bottom, established 018/019 pattern).
//
// node:test runner: `node --experimental-strip-types --test test/usage-update-flag.test.ts`
// (run `npm run build` first — both seams resolve against ../dist/*.js INTERNAL fork modules
// imported directly, NOT via lib.ts whose public surface is frozen to upstream v0.39.0).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classifyEvent } from "../dist/event-switch.js";
import { toAcpNotifications } from "../dist/lib.js";
import { usageUpdatesFor, type UsageCarrier } from "../dist/usage.js";

const logger = { log() {}, error() {} } as any;
const client = {} as any;

function loadJsonl(url: URL): Array<Record<string, unknown>> {
  return readFileSync(url, "utf8")
    .trim()
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

const CORPUS = loadJsonl(new URL("./fixtures/corpus-all-types.jsonl", import.meta.url));

/** The shared corpus' usage-bearing assistant turn: a text block AND usage.{input,output}_tokens. */
const usageTurn = CORPUS.find((e) => e.uuid === "c-asst-final")!;

/**
 * Emit a turn EXACTLY as the pump composes it: the CORE session/update notifications (via the reused
 * translator) FOLLOWED BY the flag-gated usage_update (via the reused story-025 gate). No new logic —
 * `usageUpdatesFor` is the single owner of the on/off decision and the token mapping.
 */
function emitTurn(event: Record<string, unknown>, usageUpdate: boolean): any[] {
  const c: any = classifyEvent(event as any, { onDrift: () => {} });
  const core =
    c.class === "content"
      ? (toAcpNotifications(c.content, c.role, "sess-usage", {}, client, logger, {
          registerHooks: false,
        }) as any[])
      : [];
  const usage = usageUpdatesFor(event as unknown as UsageCarrier, { usageUpdate }).map((u) => ({
    update: u,
  }));
  return [...core, ...usage];
}

const isUsage = (n: any) => n?.update?.sessionUpdate === "usage_update";
const isText = (n: any) =>
  n?.update?.sessionUpdate === "agent_message_chunk" && n?.update?.content?.type === "text";

// === R6.1 — flag ON: the usage_update carries BOTH token counts, alongside the core text ==========

test("flag ON: the usage turn emits a usage_update mapping usage.{input,output}_tokens (R6.1)", () => {
  const notifs = emitTurn(usageTurn, true);

  const usage = notifs.filter(isUsage);
  assert.equal(usage.length, 1, "flag on + usage tokens -> exactly one usage_update");
  // both input and output are mapped: used == input_tokens + output_tokens (1200 + 340).
  assert.equal(usage[0].update.used, 1540, "used maps usage.input_tokens + usage.output_tokens");
  assert.ok(usage[0].update.size >= usage[0].update.used, "size carries the context window (>= used)");

  // …and the surrounding CORE text chunk is present ALONGSIDE the usage_update.
  assert.ok(notifs.some(isText), "the core agent_message_chunk flows alongside the usage_update");
});

// === R6.2 — flag OFF: usage_update suppressed, core text STILL flows (R8) =========================

test("flag OFF: NO usage_update is emitted, yet the surrounding core text still flows (R6.2, R8)", () => {
  const notifs = emitTurn(usageTurn, false);

  assert.ok(!notifs.some(isUsage), "flag off -> NO usage_update is emitted (R8 suppression)");
  // the core thread is NOT dropped by the suppression — the text chunk still flows.
  assert.ok(notifs.some(isText), "core agent_message_chunk still flows with the flag off (R8)");
});

// === R6.3 — the default posture is OFF in BOTH the gate's no-options and explicit-false forms =====

test("default posture: usageUpdatesFor constructs nothing unless the flag is explicitly ON (R6.3)", () => {
  // no options / empty options / explicit false -> the default is OFF, nothing constructed.
  assert.deepEqual(usageUpdatesFor(usageTurn as unknown as UsageCarrier), [], "no options -> default OFF");
  assert.deepEqual(usageUpdatesFor(usageTurn as unknown as UsageCarrier, {}), [], "empty options -> default OFF");
  assert.deepEqual(
    usageUpdatesFor(usageTurn as unknown as UsageCarrier, { usageUpdate: false }),
    [],
    "explicit false -> OFF",
  );
  // explicit ON -> exactly one (the only state that emits).
  assert.equal(
    usageUpdatesFor(usageTurn as unknown as UsageCarrier, { usageUpdate: true }).length,
    1,
    "explicit ON is the only state that constructs a usage_update",
  );
});

test("best-effort: flag ON but a turn with NO usage tokens still emits nothing (no fabrication)", () => {
  // a different corpus turn (the first assistant text) carries no usage block.
  const noUsageTurn = CORPUS.find((e) => e.uuid === "c-asst-text")!;
  const notifs = emitTurn(noUsageTurn, true);
  assert.ok(!notifs.some(isUsage), "flag ON without usage tokens -> nothing fabricated");
  assert.ok(notifs.some(isText), "the core text chunk still flows");
});

// === the gate + translator are REUSED, not re-implemented here ====================================

test("the flag test REUSES the story-025 gate and the translator (no local re-impl) (R6)", () => {
  assert.equal(typeof usageUpdatesFor, "function", "usageUpdatesFor is the reused story-025 export");
  assert.equal(typeof toAcpNotifications, "function", "toAcpNotifications is the reused translator export");
  // established 018/019 self-guard: this file must not re-declare the gate or the translator locally.
  // (the `\s+`/`\b` form matches a genuine local decl only, never this assertion line.)
  const self = readFileSync(new URL("./usage-update-flag.test.ts", import.meta.url), "utf8");
  assert.ok(!/function\s+usageUpdatesFor\b/.test(self), "must not re-implement the usage gate locally");
  assert.ok(!/function\s+toAcpNotifications\b/.test(self), "must not re-implement the translator locally");
});
