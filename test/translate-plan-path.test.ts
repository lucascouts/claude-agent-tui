// Story 020 / Task 3.2 — verify the PLAN/ExitPlanMode PATH renders end-to-end as a coherent stream
// through the REUSED, unmodified translator (`toAcpNotifications` + `tools.ts` `planEntries` +
// `toolInfoFromToolUse`). This is the §7 plan-row END-TO-END coherence/ordering test (R3.2): a single
// assistant event whose `content` is `[TodoWrite tool_use, ExitPlanMode tool_use]` must emit, IN
// ORDER, the full-list `plan` update AND the `ExitPlanMode` `tool_call {kind:'switch_mode'}`, with no
// throw. `toAcpNotifications` iterates the content array and emits one notification per block; its
// tool_use arm routes by name — `TodoWrite`→`{sessionUpdate:'plan', entries: planEntries(input)}`
// (acp-agent.ts:2947-2954), `ExitPlanMode`→the `else` arm→one `tool_call` whose `kind` comes from
// `toolInfoFromToolUse` (= 'switch_mode', acp-agent.ts:2964-3047) — so content order is preserved as
// [plan, tool_call{kind:'switch_mode'}].
//
// KIND VALUE — asserted HERE on purpose (distinct from sub-task 3.1): unlike 3.1 (which pins only the
// emission and the kind KEY), R3.2 is the ORDERED, COHERENT plan+tool_call stream and tasks.md
// explicitly requires asserting `tool_call {kind:'switch_mode'}` in the ordered stream. The
// switch_mode kind-MAP itself remains story 019's unit; this file's concern is the ordered coherence
// of the full plan-path stream, and it reads the kind off the emitted tool_call to prove that.
//
// DRIFT NOTES (carry-over from Task 2 — user-confirmed: lock the REAL runtime, do NOT patch tools.ts):
//   1. `priority` is HARDCODED "medium" by `planEntries` (NOT sourced from the todo).
//   2. `activeForm` is CARRIED for an in-progress item since the #974 port (upstream v0.67.0):
//      `status === "in_progress" && activeForm ? activeForm : content`. Asserted below on both
//      sides of that branch — the in-progress todo renders "Implementing", the pending one
//      keeps its `content`.
//
// REGRESSION GUARD over already-delivered runtime (story 011 translator + story 019 kind wiring): the
// §7 translator is kept byte-for-byte; this story only WIRES the seam and asserts. EXPECTED to PASS on
// first run — a failure is a real regression: STOP, do not patch `src/`.
//
// node:test runner: `node --experimental-strip-types --test test/translate-plan-path.test.ts`
// (run `npm run build` first — the behavioral imports resolve against ../dist).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { classifyEvent } from "../dist/event-switch.js";
import { toAcpNotifications, planEntries } from "../dist/lib.js";

const here = dirname(fileURLToPath(import.meta.url));

// Only the tool_use arm touches the cache/client; minimal read-only stubs suffice (seam decision 4).
const logger = { log() {}, error() {} } as any;
const client = {} as any;

/** Compose the Degrau-1 read seam exactly as 018/019: event → classifyEvent → reused translator. */
function translate(event: unknown, cache: any) {
  const c: any = classifyEvent(event as any);
  return toAcpNotifications(c.content, c.role, "sess-020", cache, client, logger, {
    registerHooks: false,
  });
}

// The fixture: ONE assistant event carrying the plan-path sequence as TWO content blocks — the
// cleanest ordered assertion (content-array order is the emission order). The TodoWrite plan update
// (Task 2) is followed by the ExitPlanMode tool_use (the plan/ExitPlanMode path, R3.2).
const TODOS = [
  { content: "Implement", status: "in_progress", activeForm: "Implementing" },
  { content: "Review", status: "pending", activeForm: "Reviewing" },
];
function planPathEvent() {
  return {
    uuid: "pp1",
    type: "assistant",
    userType: "external",
    message: {
      role: "assistant",
      content: [
        { type: "tool_use", id: "toolu_todo", name: "TodoWrite", input: { todos: TODOS } },
        { type: "tool_use", id: "toolu_exit", name: "ExitPlanMode", input: { plan: "ship it" } },
      ],
    },
  };
}

test("plan/ExitPlanMode path renders end-to-end as a coherent stream, no throw", () => {
  let notifs: any;
  assert.doesNotThrow(() => {
    notifs = translate(planPathEvent(), {});
  }, "routing the TodoWrite+ExitPlanMode plan path through the reused translator must NOT throw");

  // Exactly TWO notifications, IN ORDER: the plan update first, then the tool_call.
  assert.equal(notifs.length, 2, "the plan-path event emits exactly two notifications (plan + tool_call)");
  assert.equal(
    notifs[0].update.sessionUpdate,
    "plan",
    "the TodoWrite block routes to the `plan` variant and is emitted first",
  );
  assert.equal(
    notifs[1].update.sessionUpdate,
    "tool_call",
    "the ExitPlanMode block routes to the `else` arm `tool_call` and is emitted second",
  );
});

test("the `plan` is the FULL todo list: length 2, each {content,status,priority:'medium'} (activeForm carried when in_progress)", () => {
  const notifs: any = translate(planPathEvent(), {});
  const entries = notifs[0].update.entries;

  // R3.2 — the full-list plan update: one entry per todo item, in order.
  assert.ok(Array.isArray(entries), "the `plan` update carries an `entries` array");
  assert.equal(entries.length, 2, "one plan entry per todo item (the full list)");
  // {content,status} from the matching todo; `priority` is the HARDCODED "medium" (DRIFT 1). The
  // in-progress entry renders its `activeForm` and the pending one its `content` (DRIFT 2,
  // post-#974) — deepEqual pins both sides of the branch at once.
  assert.deepEqual(entries[0], { content: "Implementing", status: "in_progress", priority: "medium" });
  assert.deepEqual(entries[1], { content: "Review", status: "pending", priority: "medium" });

  // Direct-reuse cross-check: the emitted entries ARE the reused planEntries output (no local re-impl).
  assert.deepEqual(
    entries,
    planEntries({ todos: TODOS as any }),
    "the `plan` entries ARE the reused planEntries output",
  );
});

test("the `tool_call` is the ExitPlanMode one with kind 'switch_mode' (R3.2 — asserted here)", () => {
  const notifs: any = translate(planPathEvent(), {});
  const u = notifs[1].update;

  // The tool_call reuses the ExitPlanMode tool_use.id verbatim (019 first-use contract)...
  assert.equal(u.toolCallId, "toolu_exit", "toolCallId reuses the ExitPlanMode tool_use.id byte-for-byte");
  // ...and carries the switch_mode kind from the reused toolInfoFromToolUse. R3.2 asserts this VALUE
  // (the ordered coherence of the plan+switch_mode stream) — distinct from sub-task 3.1.
  assert.equal(u.kind, "switch_mode", "the ExitPlanMode tool_call carries kind 'switch_mode'");
});

test("order/coherence: the `plan` precedes the `tool_call` — the §7 plan row closes coherently", () => {
  const notifs: any = translate(planPathEvent(), {});
  // The plan update is at index 0, the switch_mode tool_call at index 1 — content order preserved.
  const planIdx = notifs.findIndex((n: any) => n.update.sessionUpdate === "plan");
  const callIdx = notifs.findIndex(
    (n: any) => n.update.sessionUpdate === "tool_call" && n.update.kind === "switch_mode",
  );
  assert.equal(planIdx, 0, "the full-list `plan` is emitted first");
  assert.equal(callIdx, 1, "the `switch_mode` `tool_call` is emitted second");
  assert.ok(planIdx < callIdx, "the `plan` precedes the `tool_call` — the plan path is coherent and in order");
});

test("reuse self-guard: no local re-implementation of the translator, plan mapper, or kind resolver", () => {
  // ONLY the established 018/019 precedent's check: assert this file does not LOCALLY re-implement any
  // reused function. NB (avoids the 3.1 pitfall): we do NOT scan the source for an assertion string
  // like `kind === 'switch_mode'` — a regex cannot tell an assertion from a comment/test-name that
  // quotes it, and that exact source-scan cost sub-task 3.1 a failed run. It is omitted by design.
  const self = readFileSync(join(here, "translate-plan-path.test.ts"), "utf8");
  assert.ok(
    !/function\s+toAcpNotifications\b/.test(self),
    "must not re-implement the translator locally (reuse the upstream lib export)",
  );
  assert.ok(
    !/function\s+planEntries\b/.test(self),
    "must not re-implement the plan mapper locally (reuse the upstream lib export)",
  );
  assert.ok(
    !/function\s+toolInfoFromToolUse\b/.test(self),
    "must not re-implement the kind resolver locally (reuse the upstream lib export)",
  );
});
