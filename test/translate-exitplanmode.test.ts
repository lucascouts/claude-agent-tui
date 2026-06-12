// Story 020 / Task 3.1 — verify the `ExitPlanMode` PLAN PATH renders end-to-end through the REUSED,
// unmodified translator (`toAcpNotifications` + `tools.ts` `toolInfoFromToolUse`), on this story's
// plan-path surface. Routing in `toAcpNotifications`'s tool_use arm is by name: `TodoWrite`→`plan`,
// `Task*`→suppressed, and EVERYTHING ELSE (incl. `ExitPlanMode`) → the `else` arm that emits exactly
// one `tool_call` (acp-agent.ts §7, lines ~2942-3050). This sub-task asserts that emission, NOT the
// kind value.
//
// KIND VALUE OWNED BY 019 (do NOT duplicate): the `ExitPlanMode` → `kind:'switch_mode'` mapping is
// the SINGLE responsibility of story 019 (Task 2.1, R4·3) in `test/translate-tool-kind.test.ts`.
// To avoid divergence this file MUST NOT re-assert `kind === 'switch_mode'` — at most it may assert
// the `kind` KEY exists (path is wired), never its value. The reuse self-guard below enforces this.
//
// REGRESSION GUARD over already-delivered runtime (story 011 translator + story 019 wiring): the §7
// translator is kept byte-for-byte; this story only WIRES the seam and asserts. EXPECTED to PASS on
// first run — a failure is a real regression: STOP, do not patch `src/`.
//
// node:test runner: `node --experimental-strip-types --test test/translate-exitplanmode.test.ts`
// (run `npm run build` first — the behavioral imports resolve against ../dist).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { classifyEvent } from "../dist/event-switch.js";
import { toAcpNotifications } from "../dist/lib.js";

const here = dirname(fileURLToPath(import.meta.url));

// Only the tool_use arm touches the cache/client; minimal read-only stubs suffice (seam decision 4).
const logger = { log() {}, error() {} } as any;
const client = {} as any;

/** Compose the Degrau-1 read seam exactly as story 019: event → classifyEvent → reused translator. */
function translate(event: unknown, cache: any) {
  const c: any = classifyEvent(event as any);
  return toAcpNotifications(c.content, c.role, "sess-020", cache, client, logger, {
    registerHooks: false,
  });
}

function assistantToolUse(block: unknown) {
  return {
    uuid: "epm1",
    type: "assistant",
    userType: "external",
    message: { role: "assistant", content: [block] },
  };
}

// The fixture: input is a plan string, mirroring story 019's plan-input ExitPlanMode case.
const EXITPLANMODE_TOOL_USE = {
  type: "tool_use",
  id: "toolu_exitplan",
  name: "ExitPlanMode",
  input: { plan: "ship the read-only thread" },
} as const;

test("ExitPlanMode plan path renders end-to-end: exactly one tool_call, no throw", () => {
  const cache = {};
  let notifs: any;
  assert.doesNotThrow(() => {
    notifs = translate(assistantToolUse(EXITPLANMODE_TOOL_USE), cache);
  }, "routing ExitPlanMode through the reused kind map must NOT throw");

  assert.equal(
    notifs.length,
    1,
    "ExitPlanMode falls into the else arm and emits exactly one notification",
  );
  assert.equal(
    notifs[0].update.sessionUpdate,
    "tool_call",
    "ExitPlanMode renders as a tool_call (not a plan, not suppressed)",
  );
});

test("ExitPlanMode tool_call reuses tool_use.id verbatim (019 first-use contract)", () => {
  const cache = {};
  const notifs: any = translate(assistantToolUse(EXITPLANMODE_TOOL_USE), cache);
  assert.equal(
    notifs[0].update.toolCallId,
    "toolu_exitplan",
    "toolCallId reuses tool_use.id byte-for-byte (never minted)",
  );
});

test("ExitPlanMode tool_call carries a `kind` KEY (path wired) — value owned by 019, not asserted here", () => {
  const cache = {};
  const notifs: any = translate(assistantToolUse(EXITPLANMODE_TOOL_USE), cache);
  // Prove only that toolInfoFromToolUse ran (the kind key is present). The VALUE 'switch_mode' is
  // asserted exclusively in story 019's test/translate-tool-kind.test.ts — NOT re-pinned here.
  assert.ok(
    "kind" in notifs[0].update,
    "the reused toolInfoFromToolUse populated `kind` (its value is story 019's to own)",
  );
});

test("reuse self-guard: no local re-implementation of the translator or the kind resolver", () => {
  const self = readFileSync(join(here, "translate-exitplanmode.test.ts"), "utf8");
  assert.ok(
    !/function\s+toolInfoFromToolUse\b/.test(self),
    "must not re-implement the kind resolver locally (reuse the upstream lib export)",
  );
  assert.ok(
    !/function\s+toAcpNotifications\b/.test(self),
    "must not re-implement the translator locally (reuse the upstream lib export)",
  );
  // NOTE: the "do not re-own the kind VALUE" rule (story 019 is its single owner) is satisfied by
  // construction — this file asserts only the `kind` KEY's presence above, never `=== 'switch_mode'`.
  // It is intentionally NOT enforced by scanning this source: a regex cannot tell an assertion from a
  // comment that quotes it (the header documents the rule in prose), and 018/019 self-guards likewise
  // only guard against local re-implementation, not assertion strings.
});
