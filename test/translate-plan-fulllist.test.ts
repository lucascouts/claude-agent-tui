// Story 020 / Task 2.2 — assert the §7 FULL-LIST resend: each successive `TodoWrite` update
// re-builds the plan from the COMPLETE current todo list (a snapshot), NEVER a delta of only the
// changed items. Two successive updates flow through the REUSED, unmodified `toAcpNotifications` +
// `tools.ts` `planEntries`; the second update (one item flips `status` AND a new item is added)
// must carry EVERY current item so Zed replaces the plan wholesale (not merge a diff).
//
// REGRESSION GUARD over already-delivered runtime: the §7 translator (`toAcpNotifications` +
// `tools.ts` `planEntries`, story 011) is kept byte-for-byte; this story only WIRES the seam and
// asserts (R2.2 — NO `planEntries`/translator source change). The full-list property is INHERENT
// in the runtime: `TodoWrite.input.todos` is snapshot-style (the SDK always re-sends the complete
// list, never a delta), and `planEntries` maps every element → one `PlanEntry`. The composition
// mirrors the Degrau-1 read path: typed JSONL event → `classifyEvent` (story 016, §6 content
// normalisation) → the unmodified translator → its `TodoWrite` arm (acp-agent.ts:2947-2954) →
// the reused `planEntries`. Two updates share ONE cache to mirror a live session (the `plan`
// branch does not read the cache, but a shared cache keeps the seam faithful to production).
//
// DRIFT NOTES (§7 doc / tasks.md vs the reused runtime) — carried from sub-task 2.1; user-confirmed
// policy: lock the REAL runtime and record the drift, do NOT patch `tools.ts`:
//   1. `priority` is HARDCODED to "medium". The input has NO `priority`; `planEntries` synthesizes
//      `priority:"medium"` for every entry. The assertions pin the runtime's "medium".
//   2. `activeForm` is CARRIED for an in-progress item — changed by the #974 port (upstream
//      v0.67.0). `planEntries` now reads `status === "in_progress" && activeForm ? activeForm :
//      content`, so an in-progress todo renders in its active voice ("Wiring seam") and every
//      other status still renders its imperative `content`. This note previously recorded the
//      field as DROPPED; the assertions below pin the new rule on BOTH sides of the branch.
//   3. `taskStateToPlanEntries` is the headless Task*/TaskCreate path (a `TaskState` mapper), NOT
//      the TodoWrite path, and is NOT exported from `dist/lib.js` (do not import it). The TodoWrite
//      row uses `planEntries` ONLY — this test imports nothing from the Task* path.
//
// node:test runner: `node --experimental-strip-types --test test/translate-plan-fulllist.test.ts`
// (run `npm run build` first — the behavioral imports resolve against ../dist).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { classifyEvent } from "../dist/event-switch.js";
import { toAcpNotifications } from "../dist/lib.js";

// Only the tool_use arm touches the cache/client; minimal stubs suffice (§7 reuse, read-only):
// the TodoWrite arm emits the `plan` update synchronously and never feeds ACP-side input back in.
const logger = { log() {}, error() {} } as any;
const client = {} as any;
const here = dirname(fileURLToPath(import.meta.url));

/**
 * Compose the Degrau-1 read seam exactly as production would: event → classifyEvent → translator.
 * The SAME `cache` is threaded across the two successive updates so seen-id state survives — a
 * faithful mirror of a live session. `registerHooks:false` keeps the unit synchronous (the
 * PostToolUse hook needs a live client and is irrelevant to the synchronous `plan` update).
 */
function translate(event: unknown, cache: any) {
  const c: any = classifyEvent(event as any);
  return toAcpNotifications(c.content, c.role, "sess-020", cache, client, logger, {
    registerHooks: false,
  });
}

// A `TodoWrite` assistant event with a given tool_use id and the COMPLETE todo snapshot.
function todoWriteEvent(id: string, todos: unknown[]) {
  return {
    uuid: "fl-" + id,
    type: "assistant",
    userType: "external",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id, name: "TodoWrite", input: { todos } }],
    },
  };
}

// Update 1: the initial snapshot — two pending items.
const SNAPSHOT_1 = [
  { content: "A", status: "pending", activeForm: "A" },
  { content: "B", status: "pending", activeForm: "B" },
];
// Update 2: the COMPLETE new snapshot — A flips to in_progress, B unchanged, and a NEW item C.
// This is what the SDK actually re-sends (the full list), NOT a 2-item delta of {A-flipped, C-new}.
const SNAPSHOT_2 = [
  { content: "A", status: "in_progress", activeForm: "A" },
  { content: "B", status: "pending", activeForm: "B" },
  { content: "C", status: "pending", activeForm: "C" },
];

// Helper: extract the single `plan` update emitted for one TodoWrite event.
function planFor(id: string, todos: unknown[], cache: any) {
  const notifs: any = translate(todoWriteEvent(id, todos), cache);
  assert.equal(notifs.length, 1, "a TodoWrite tool_use emits exactly one notification");
  const u = notifs[0].update;
  assert.equal(u.sessionUpdate, "plan", "TodoWrite routes to the `plan` variant, not `tool_call`");
  return u;
}

test("two successive TodoWrite updates: update 1 → plan of 2, update 2 → plan of 3 (full snapshots)", () => {
  const cache = {};
  const plan1 = planFor("toolu_todoA", SNAPSHOT_1, cache);
  const plan2 = planFor("toolu_todoB", SNAPSHOT_2, cache);

  // Update 1 carries the whole initial list (2 items).
  assert.equal(plan1.entries.length, 2, "update 1 emits one plan with both initial items");
  // Update 2 carries the whole NEW list (3 items) — proving it is the full current snapshot, NOT
  // a delta. A delta of "what changed" between snapshots would be 2 entries ({A-flipped, C-new});
  // the runtime instead re-sends ALL THREE so Zed replaces the plan wholesale (§7).
  assert.equal(
    plan2.entries.length,
    3,
    "update 2 re-sends every current item (full list of 3), not a 2-item delta",
  );
});

test("update 2 reflects the flipped status AND retains the unchanged item (wholesale resend)", () => {
  const cache = {};
  planFor("toolu_todoA", SNAPSHOT_1, cache);
  const plan2 = planFor("toolu_todoB", SNAPSHOT_2, cache);

  // The flipped item A carries its UPDATED status (`in_progress`), with the hardcoded "medium"
  // priority (DRIFT 1). This fixture's `activeForm` equals its `content`, so the #974 rule is
  // invisible here by construction — translate-plan.test.ts is where the branch is pinned.
  const a = plan2.entries.find((e: any) => e.content === "A");
  assert.deepEqual(
    a,
    { content: "A", status: "in_progress", priority: "medium" },
    "update 2 carries A with its flipped status",
  );

  // The UNCHANGED item B is STILL present in update 2 — this is the crux of full-list-vs-delta:
  // a diff would omit B (it didn't change); the snapshot resend keeps it.
  const b = plan2.entries.find((e: any) => e.content === "B");
  assert.deepEqual(
    b,
    { content: "B", status: "pending", priority: "medium" },
    "update 2 STILL carries the unchanged item B (proves wholesale resend, not a diff)",
  );
});

test("anti-delta: update 2 entries[].content === every current item [A,B,C] in snapshot order", () => {
  const cache = {};
  planFor("toolu_todoA", SNAPSHOT_1, cache);
  const plan2 = planFor("toolu_todoB", SNAPSHOT_2, cache);

  // The complete set of contents equals the FULL current list — every item, in order. If the
  // runtime emitted a delta, this array would be the changed subset, not the whole snapshot.
  assert.deepEqual(
    plan2.entries.map((e: any) => e.content),
    ["A", "B", "C"],
    "update 2 carries the complete current list (Zed replaces the plan wholesale)",
  );
});

test("the translator + planEntries are REUSED unmodified (no local re-implementation in this story)", () => {
  // The behavioral import is the upstream public export — a real function, not a local stand-in.
  assert.equal(typeof toAcpNotifications, "function", "toAcpNotifications must be the reused lib export");
  // R2.2 — this story authors NO production translator/mapper: its own test must not re-declare one.
  const self = readFileSync(join(here, "translate-plan-fulllist.test.ts"), "utf8");
  assert.ok(
    !/function\s+planEntries\b/.test(self),
    "the story must not re-implement planEntries locally",
  );
  assert.ok(
    !/function\s+toAcpNotifications\b/.test(self),
    "the story must not re-implement the translator locally",
  );
});
