// Story 020 / Task 2.1 — route a `TodoWrite` tool_use input through the REUSED, unmodified
// `tools.ts` `planEntries` (via `toAcpNotifications`) and lock the §7 plan variant: a `TodoWrite`
// whose `input.todos` is an array → exactly one ACP `plan {entries:[{content,priority,status}]}`
// whose entries carry the `content`/`status` of every todo item (NOT a `tool_call`).
//
// REGRESSION GUARD over already-delivered runtime: the §7 translator (`toAcpNotifications` +
// `tools.ts` `planEntries`, story 011) is kept byte-for-byte; this story only WIRES the seam and
// asserts (R2.3 — NO `planEntries` source change). The composition mirrors the Degrau-1 read path:
// a typed JSONL event → `classifyEvent` (story 016, §6 content normalisation) → the unmodified
// translator → its `TodoWrite` arm (acp-agent.ts:2947-2954) → the reused `planEntries`.
//
// DRIFT NOTES (§7 doc / tasks.md vs the reused runtime) — user-confirmed policy: lock the REAL
// runtime and record the drift, do NOT patch `tools.ts` (story 020 Constraints / R2.1, R2.3):
//   1. `priority` is HARDCODED to "medium". The input `ClaudePlanEntry` has NO `priority` field;
//      `planEntries` synthesizes `priority:"medium"` for every entry. §7/R2.1 lists
//      `{content,priority,status}`, but `priority` is NOT sourced from the todo — the assertions
//      below pin the runtime's "medium", they do not invent a per-item priority.
//   2. `activeForm` is CARRIED for an in-progress item — changed by the #974 port (upstream
//      v0.67.0). `planEntries` now reads `status === "in_progress" && activeForm ? activeForm :
//      content`, so an in-progress todo renders in its active voice ("Wiring seam") and every
//      other status still renders its imperative `content`. This note previously recorded the
//      field as DROPPED; the assertions below pin the new rule on BOTH sides of the branch.
//   3. `taskStateToPlanEntries` is the headless Task*/TaskCreate path (a `TaskState` mapper), NOT
//      the TodoWrite path, and is NOT exported from `dist/lib.js` (importing it would resolve to
//      `undefined`). The TodoWrite row uses `planEntries` ONLY — this test imports `planEntries`.
//
// node:test runner: `node --experimental-strip-types --test test/translate-plan.test.ts`
// (run `npm run build` first — the behavioral imports resolve against ../dist).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { classifyEvent } from "../dist/event-switch.js";
import { toAcpNotifications, planEntries } from "../dist/lib.js";

// Only the tool_use arm touches the cache/client; minimal stubs suffice (§7 reuse, read-only):
// the TodoWrite arm emits the `plan` update synchronously and never feeds ACP-side input back in.
const logger = { log() {}, error() {} } as any;
const client = {} as any;
const here = dirname(fileURLToPath(import.meta.url));

/**
 * Compose the Degrau-1 read seam exactly as production would: event → classifyEvent → translator.
 * `registerHooks:false` keeps the unit synchronous — the PostToolUse hook (which needs a live
 * client) is irrelevant to the synchronous `plan` notification this story asserts.
 */
function translate(event: unknown, cache: any) {
  const c: any = classifyEvent(event as any);
  return toAcpNotifications(c.content, c.role, "sess-020", cache, client, logger, {
    registerHooks: false,
  });
}

function assistantToolUse(block: unknown) {
  return {
    uuid: "p1",
    type: "assistant",
    userType: "external",
    message: { role: "assistant", content: [block] },
  };
}

// A fixture TodoWrite with THREE todos spanning every status — the full list must be covered.
const TODOS = [
  { content: "Write tests", status: "pending", activeForm: "Writing tests" },
  { content: "Wire seam", status: "in_progress", activeForm: "Wiring seam" },
  { content: "Commit", status: "completed", activeForm: "Committing" },
];
function todoWriteBlock() {
  return { type: "tool_use", id: "toolu_todo1", name: "TodoWrite", input: { todos: TODOS } };
}

test("TodoWrite tool_use → exactly one `plan` notification (NOT a tool_call) via the reused planEntries", () => {
  const notifs: any = translate(assistantToolUse(todoWriteBlock()), {});

  assert.equal(notifs.length, 1, "a TodoWrite tool_use emits exactly one notification");
  const u = notifs[0].update;
  // §7 plan variant: the TodoWrite arm emits the `plan` SessionUpdate, never `tool_call`.
  assert.equal(u.sessionUpdate, "plan", "TodoWrite routes to the `plan` variant, not `tool_call`");
  assert.ok(Array.isArray(u.entries), "the `plan` update carries an `entries` array");
});

test("plan entries cover EVERY todo item: length 3, each {content,status,priority:'medium'} matches", () => {
  const notifs: any = translate(assistantToolUse(todoWriteBlock()), {});
  const entries = notifs[0].update.entries;

  // R2.1 — every todo item is covered (the full list, in order).
  assert.equal(entries.length, 3, "one plan entry per todo item (all three covered)");

  // Each entry maps {content,status} from the matching todo; `priority` is the HARDCODED "medium"
  // (DRIFT 1 — not sourced from the todo). The in-progress entry carries its `activeForm`
  // ("Wiring seam") and the other two keep their `content` (DRIFT 2, post-#974) — the three
  // deepEquals pin both sides of that branch at once.
  assert.deepEqual(entries[0], { content: "Write tests", status: "pending", priority: "medium" });
  assert.deepEqual(entries[1], { content: "Wiring seam", status: "in_progress", priority: "medium" });
  assert.deepEqual(entries[2], { content: "Commit", status: "completed", priority: "medium" });
});

test("R2.3 direct-reuse cross-check: planEntries(input) deep-equals update.entries (no local re-impl)", () => {
  const notifs: any = translate(assistantToolUse(todoWriteBlock()), {});
  // Call the exported, unmodified `planEntries` directly on the SAME input — the `plan` variant
  // emitted through the translator must be byte-for-byte what the reused function produces.
  const direct = planEntries({ todos: TODOS as any });
  assert.deepEqual(notifs[0].update.entries, direct, "the `plan` entries ARE the reused planEntries output");
});

test("the translator + planEntries are REUSED unmodified (no local re-implementation in this story)", () => {
  // The behavioral imports are the upstream public exports — real functions, not local stand-ins.
  assert.equal(typeof toAcpNotifications, "function", "toAcpNotifications must be the reused lib export");
  assert.equal(typeof planEntries, "function", "planEntries must be the reused lib export");
  // R2.3 — this story authors NO production translator/mapper: its own test must not re-declare one.
  const self = readFileSync(join(here, "translate-plan.test.ts"), "utf8");
  assert.ok(
    !/function\s+planEntries\b/.test(self),
    "the story must not re-implement planEntries locally",
  );
  assert.ok(
    !/function\s+toAcpNotifications\b/.test(self),
    "the story must not re-implement the translator locally",
  );
});
