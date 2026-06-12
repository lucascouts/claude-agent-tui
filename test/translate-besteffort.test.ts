// Story 020 / Task 4.1 — lock the best-effort GATE for the plan/image convenience surfaces
// (R4.1, R4.2). The gate (`translateBestEffort`, src/besteffort.ts) splits an event's content into
// a CORE subset (text/tool_call — the live thread) and a CONVENIENCE subset (image + `TodoWrite`
// → `plan`). CORE is ALWAYS emitted via the REUSED `toAcpNotifications`; CONVENIENCE is gated by a
// per-surface flag and wrapped in try/catch so a failure there is CONTAINED — it skips only that
// surface and NEVER breaks the surrounding core stream.
//
// CONTAINMENT, NOT NEW TRANSLATION: the gate owns no translation logic — both passes delegate to the
// unmodified `toAcpNotifications`. This test asserts the GATING + CONTAINMENT behavior; it does not
// re-implement the translator (self-guard at the bottom, established 018/019 pattern).
//
// node:test runner: `node --experimental-strip-types --test test/translate-besteffort.test.ts`
// (run `npm run build` first — the gate resolves against ../dist/besteffort.js, an INTERNAL fork
// module imported directly like jsonl/event-switch/linearize — NOT via lib.ts, whose public export
// surface is frozen to upstream v0.39.0 and locked by lib-exports.test.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  translateBestEffort,
  isConvenienceBlock,
  type ConvenienceFlags,
} from "../dist/besteffort.js";

// The gate's CORE/CONVENIENCE passes only touch the cache/client on the tool_use arm; minimal stubs
// suffice (established §7 reuse pattern — read-only, no ACP-side input fed back in).
const client = {} as any;
const here = dirname(fileURLToPath(import.meta.url));

/** A capturing logger so the containment test can assert the drift note was logged via `error`. */
function capturingLogger() {
  const errors: any[][] = [];
  return {
    logger: { log() {}, error(...args: any[]) { errors.push(args); } } as any,
    errors,
  };
}

// A representative event content mixing CORE (text + a `Read` tool_use) with CONVENIENCE (a
// `TodoWrite` tool_use → `plan`, and an `image` block → image content).
function mixedContent() {
  return [
    { type: "text", text: "hello" }, // core → agent_message_chunk
    { type: "tool_use", id: "toolu_read", name: "Read", input: { file_path: "/a" } }, // core → tool_call
    {
      type: "tool_use",
      id: "toolu_todo",
      name: "TodoWrite",
      input: { todos: [{ content: "x", status: "pending", activeForm: "x" }] },
    }, // convenience → plan
    { type: "image", source: { type: "base64", media_type: "image/png", data: "aGk=" } }, // convenience → image content
  ];
}

/** Run the gate over the mixed content as an assistant turn, with the given flags / opts. */
function run(flags: ConvenienceFlags, logger: any, opts?: any) {
  return translateBestEffort(
    mixedContent() as any,
    "assistant",
    "sess-020",
    {},
    client,
    logger,
    flags,
    opts,
  ) as any[];
}

// Predicates over the emitted SessionNotifications.
const isPlan = (n: any) => n?.update?.sessionUpdate === "plan";
const isImage = (n: any) => n?.update?.content?.type === "image";
const isText = (n: any) =>
  n?.update?.sessionUpdate === "agent_message_chunk" && n?.update?.content?.type === "text";
const isReadToolCall = (n: any) =>
  n?.update?.sessionUpdate === "tool_call" && n?.update?.toolCallId === "toolu_read";

test("flag OFF: convenience surface suppressed (no plan, no image) while CORE text + tool_call flow", () => {
  const { logger } = capturingLogger();
  const notifs = run({ plan: false, image: false }, logger);

  // R4.1 — with the flag off the convenience surface is suppressed entirely.
  assert.ok(!notifs.some(isPlan), "no `plan` update is emitted when flags.plan is off");
  assert.ok(!notifs.some(isImage), "no image-content update is emitted when flags.image is off");
  // …while the CORE thread still flows (never gated).
  assert.ok(notifs.some(isText), "core `text` (agent_message_chunk) still flows with flag off");
  assert.ok(notifs.some(isReadToolCall), "core `Read` tool_call still flows with flag off");
});

test("flag ON (normal translate): plan AND image appear ALONGSIDE the core text + tool_call", () => {
  const { logger } = capturingLogger();
  const notifs = run({ plan: true, image: true }, logger);

  // Full convenience surface enabled.
  assert.ok(notifs.some(isPlan), "`plan` update appears when flags.plan is on");
  assert.ok(notifs.some(isImage), "image-content update appears when flags.image is on");
  // Core thread is unaffected — still present alongside the convenience surfaces.
  assert.ok(notifs.some(isText), "core `text` still present with flags on");
  assert.ok(notifs.some(isReadToolCall), "core `Read` tool_call still present with flags on");
});

test("flag ON + forced throw: error CONTAINED — surface skipped, core text + tool_call survive, error logged", () => {
  const { logger, errors } = capturingLogger();
  // Inject a convenience translator that throws — the CORE pass uses the REAL translator, so only the
  // convenience surface should be affected.
  const notifs = run({ plan: true, image: true }, logger, {
    translate: () => {
      throw new Error("forced convenience failure");
    },
  });

  // R4.2 — the throw does NOT escape `translateBestEffort` (we got a result array, not an exception).
  assert.ok(Array.isArray(notifs), "translateBestEffort did not rethrow — it returned a result array");
  // …only the convenience surface is skipped.
  assert.ok(!notifs.some(isPlan), "plan surface is skipped when the convenience translation throws");
  assert.ok(!notifs.some(isImage), "image surface is skipped when the convenience translation throws");
  // …and the surrounding CORE thread is NOT broken — its updates are still emitted.
  assert.ok(notifs.some(isText), "core `text` survives a convenience failure (thread not broken)");
  assert.ok(
    notifs.some(isReadToolCall),
    "core `Read` tool_call survives a convenience failure (thread not broken)",
  );
  // …and the failure was recorded as a drift note via logger.error.
  assert.ok(errors.length >= 1, "the contained convenience failure is logged via logger.error");
});

test("flag ON, only plan: image-content suppressed independently while plan + core flow", () => {
  const { logger } = capturingLogger();
  const notifs = run({ plan: true, image: false }, logger);

  // R4.1 — surfaces gate INDEPENDENTLY: plan on, image off.
  assert.ok(notifs.some(isPlan), "plan survives when only flags.plan is on");
  assert.ok(!notifs.some(isImage), "image is suppressed when flags.image is off (independent gating)");
  assert.ok(notifs.some(isText), "core text still flows");
  assert.ok(notifs.some(isReadToolCall), "core tool_call still flows");
});

test("isConvenienceBlock: true for image & TodoWrite tool_use, false for text & a Read tool_use", () => {
  assert.equal(
    isConvenienceBlock({ type: "image", source: { type: "base64", media_type: "image/png", data: "aGk=" } }),
    true,
    "an image block is convenience",
  );
  assert.equal(
    isConvenienceBlock({ type: "tool_use", id: "t", name: "TodoWrite", input: { todos: [] } }),
    true,
    "a TodoWrite tool_use is convenience",
  );
  assert.equal(isConvenienceBlock({ type: "text", text: "hi" }), false, "text is core, not convenience");
  assert.equal(
    isConvenienceBlock({ type: "tool_use", id: "t", name: "Read", input: { file_path: "/a" } }),
    false,
    "a non-TodoWrite tool_use (Read) is core, not convenience",
  );
});

test("the gate REUSES the translator (no local re-implementation of toAcpNotifications in this test)", () => {
  // The behavioral imports are the real upstream exports — functions, not local stand-ins.
  assert.equal(typeof translateBestEffort, "function", "translateBestEffort must be the reused lib export");
  assert.equal(typeof isConvenienceBlock, "function", "isConvenienceBlock must be the reused lib export");
  // Established 018/019 self-guard: this test must not re-declare the translator locally.
  const self = readFileSync(join(here, "translate-besteffort.test.ts"), "utf8");
  assert.ok(
    !/function\s+toAcpNotifications\b/.test(self),
    "the test must not re-implement the translator locally",
  );
});
