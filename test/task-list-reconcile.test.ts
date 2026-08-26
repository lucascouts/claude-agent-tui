// Upstream #974 (v0.67.0), ported in part — the Task* plan survives a resumed or compacted
// session, and an in-progress entry renders in its active voice.
//
// THREE THINGS ARE PINNED HERE, and the first is a fix, not a port:
//
//   1. The Task* parsers read the STRUCTURED `toolUseResult` first and the model-facing text
//      second. Measured against the local corpus at port time: of 186 Task* tool_use/tool_result
//      pairs, EVERY structured object sits in `toolUseResult`, while `content` carries a short
//      sentence ("Task #1 created successfully: <subject>"). The previous parser tried
//      `JSON.parse` on `content` alone, so it returned `undefined` for every real TaskCreate and
//      `applyTaskCreate` silently did nothing — on a resumed session, where the TaskCreated hook
//      never fires, the plan came out EMPTY. `parse-empty-plan` below is that regression.
//
//   2. `applyTaskList` reconciles the accumulated state against the SDK's authoritative snapshot.
//      This is the half of #974 that repairs history the replay no longer holds: entries the
//      snapshot omits were deleted and must disappear; `activeForm`/`description`, which the
//      snapshot does not carry, are preserved from the previous entry.
//
//   3. A TaskUpdate that failed LOGICALLY (unknown task id, `success: false`) is not applied even
//      though the tool_result is not flagged `is_error`.
//
// NOT ported, and deliberately: #974's republish-across-prompt-boundaries half. This fork keeps
// `taskState` per SESSION (created once in `createSession`), not per prompt loop, so a plan
// already survives a prompt boundary by construction — there is nothing to republish.
//
// node:test runner: `node --experimental-strip-types --test test/task-list-reconcile.test.ts`
// (run `npm run build` first — the behavioral imports resolve against ../dist).
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyEvent } from "../dist/event-switch.js";
import { toAcpNotifications } from "../dist/lib.js";
import {
  applyTaskList,
  parseTaskCreateOutput,
  parseTaskListOutput,
  parseTaskUpdateOutput,
  taskStateToPlanEntries,
  type TaskState,
} from "../dist/tools.js";

const logger = { log() {}, error() {} } as any;
const client = {} as any;

// The exact payloads the local transcripts carry, copied from the measurement.
const REAL_CREATE_TEXT = "Task #1 created successfully: Fase 1 — story.md (requisitos EARS)";
const REAL_CREATE_STRUCTURED = { task: { id: "1", subject: "Fase 1 — story.md (requisitos EARS)" } };
const REAL_LIST_TEXT = "#1 [completed] Grupo 1 — The view model\n#6 [pending] Grupo 6 — Wiring";
const REAL_LIST_STRUCTURED = {
  tasks: [
    { id: "1", subject: "Grupo 1 — The view model", status: "completed", blockedBy: [] },
    { id: "6", subject: "Grupo 6 — Wiring", status: "pending", blockedBy: [] },
  ],
};

// ------------------------------------------------------------------------- parsers

test("parse-empty-plan regression: the REAL TaskCreate text now parses (it returned undefined before)", () => {
  const parsed: any = parseTaskCreateOutput(REAL_CREATE_TEXT);
  assert.equal(parsed?.task?.id, "1");
  assert.equal(parsed?.task?.subject, "Fase 1 — story.md (requisitos EARS)");
});

test("parseTaskCreateOutput accepts the structured toolUseResult object directly", () => {
  const parsed: any = parseTaskCreateOutput(REAL_CREATE_STRUCTURED);
  assert.equal(parsed?.task?.id, "1");
});

test("parseTaskCreateOutput still reads a JSON payload wrapped in text blocks", () => {
  const parsed: any = parseTaskCreateOutput([
    { type: "text", text: JSON.stringify(REAL_CREATE_STRUCTURED) },
  ]);
  assert.equal(parsed?.task?.id, "1");
});

test("parseTaskListOutput reads BOTH real shapes — structured object and `#id [status] subject`", () => {
  const structured: any = parseTaskListOutput(REAL_LIST_STRUCTURED);
  const textual: any = parseTaskListOutput(REAL_LIST_TEXT);
  assert.equal(structured.tasks.length, 2);
  assert.equal(textual.tasks.length, 2);
  assert.equal(textual.tasks[0].id, "1");
  assert.equal(textual.tasks[0].status, "completed");
  assert.equal(textual.tasks[0].subject, "Grupo 1 — The view model");
  assert.equal(textual.tasks[1].status, "pending");
});

test("parseTaskListOutput: an empty list is a REAL answer, distinct from an unparseable one", () => {
  assert.deepEqual(parseTaskListOutput("No tasks found"), { tasks: [] });
  assert.equal(parseTaskListOutput("some unrelated tool output"), undefined);
});

test("parseTaskListOutput: one unparseable line rejects the WHOLE text, never a partial plan", () => {
  // A truncated plan reads as complete to the user — worse than no plan at all.
  const mixed = "#1 [completed] Real task\nthis line is not a task listing";
  assert.equal(parseTaskListOutput(mixed), undefined);
});

test("parseTaskUpdateOutput surfaces a LOGICAL failure that is not flagged is_error", () => {
  const structured: any = parseTaskUpdateOutput({
    success: false,
    taskId: "9",
    updatedFields: [],
  });
  assert.equal(structured.success, false);
  const textual: any = parseTaskUpdateOutput("Task #9 not found");
  assert.equal(textual.success, false);
  assert.equal(textual.taskId, "9");
});

// --------------------------------------------------------------------- applyTaskList

test("applyTaskList replaces the list wholesale — a deleted task disappears", () => {
  const state: TaskState = new Map([
    ["1", { subject: "kept", status: "pending" }],
    ["2", { subject: "deleted upstream", status: "pending" }],
  ]);
  applyTaskList(state, { tasks: [{ id: "1", subject: "kept", status: "completed", blockedBy: [] }] });
  assert.deepEqual([...state.keys()], ["1"]);
  assert.equal(state.get("1")?.status, "completed");
});

test("applyTaskList preserves activeForm/description, which the snapshot does not carry", () => {
  const state: TaskState = new Map([
    ["1", { subject: "Fix it", status: "pending", activeForm: "Fixing it", description: "why" }],
  ]);
  applyTaskList(state, {
    tasks: [{ id: "1", subject: "Fix it", status: "in_progress", blockedBy: [] }],
  });
  const entry = state.get("1");
  assert.equal(entry?.status, "in_progress");
  assert.equal(entry?.activeForm, "Fixing it", "activeForm must survive the reconcile");
  assert.equal(entry?.description, "why");
});

test("applyTaskList adds a task the accumulated state never saw (the compacted-history case)", () => {
  const state: TaskState = new Map();
  applyTaskList(state, {
    tasks: [{ id: "7", subject: "Created before the compaction", status: "pending", blockedBy: [] }],
  });
  assert.equal(state.get("7")?.subject, "Created before the compaction");
});

// ------------------------------------------------------------------- activeForm rule

test("taskStateToPlanEntries renders activeForm ONLY for the in-progress entry", () => {
  const state: TaskState = new Map([
    ["1", { subject: "Fix it", status: "in_progress", activeForm: "Fixing it" }],
    ["2", { subject: "Ship it", status: "pending", activeForm: "Shipping it" }],
    ["3", { subject: "Test it", status: "completed", activeForm: "Testing it" }],
  ]);
  assert.deepEqual(taskStateToPlanEntries(state), [
    { content: "Fixing it", status: "in_progress", priority: "medium" },
    { content: "Ship it", status: "pending", priority: "medium" },
    { content: "Test it", status: "completed", priority: "medium" },
  ]);
});

test("taskStateToPlanEntries falls back to the subject when in-progress has no activeForm", () => {
  const state: TaskState = new Map([["1", { subject: "Fix it", status: "in_progress" }]]);
  assert.deepEqual(taskStateToPlanEntries(state), [
    { content: "Fix it", status: "in_progress", priority: "medium" },
  ]);
});

// ------------------------------------------------------------------ end-to-end seam

/** Drive a tool_use then its tool_result through the translator, sharing one taskState. */
function runTaskTurn(
  toolUse: { id: string; name: string; input: unknown },
  result: { content: unknown; toolUseResult?: unknown },
  taskState: TaskState,
  cache: Record<string, unknown>,
) {
  const useEvent = {
    uuid: "u",
    type: "assistant",
    userType: "external",
    message: { role: "assistant", content: [{ type: "tool_use", ...toolUse }] },
  };
  const cu: any = classifyEvent(useEvent as any);
  toAcpNotifications(cu.content, cu.role, "sess-974", cache as any, client, logger, {
    registerHooks: false,
    taskState,
  });

  const resEvent = {
    uuid: "r",
    type: "user",
    userType: "external",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUse.id, content: result.content }],
    },
  };
  const cr: any = classifyEvent(resEvent as any);
  return toAcpNotifications(cr.content, cr.role, "sess-974", cache as any, client, logger, {
    registerHooks: false,
    taskState,
    toolUseResult: result.toolUseResult,
  });
}

test("seam: a real TaskCreate round-trip now produces a NON-EMPTY plan", () => {
  const taskState: TaskState = new Map();
  const cache: Record<string, unknown> = {};
  const notifs: any = runTaskTurn(
    { id: "toolu_c1", name: "TaskCreate", input: { subject: "Fase 1", activeForm: "Fazendo a fase 1" } },
    { content: REAL_CREATE_TEXT, toolUseResult: REAL_CREATE_STRUCTURED },
    taskState,
    cache,
  );
  const plan = notifs.find((n: any) => n.update.sessionUpdate === "plan");
  assert.ok(plan, "a TaskCreate result must emit a plan update");
  assert.equal(plan.update.entries.length, 1);
  assert.equal(plan.update.entries[0].content, "Fase 1");
});

test("seam: a TaskList result emits a reconciled plan (it emitted NOTHING before)", () => {
  const taskState: TaskState = new Map([
    ["99", { subject: "stale, deleted upstream", status: "pending" }],
  ]);
  const cache: Record<string, unknown> = {};
  const notifs: any = runTaskTurn(
    { id: "toolu_l1", name: "TaskList", input: {} },
    { content: REAL_LIST_TEXT, toolUseResult: REAL_LIST_STRUCTURED },
    taskState,
    cache,
  );
  const plan = notifs.find((n: any) => n.update.sessionUpdate === "plan");
  assert.ok(plan, "a TaskList result must now emit a plan update");
  assert.deepEqual(
    plan.update.entries.map((e: any) => e.content),
    ["Grupo 1 — The view model", "Grupo 6 — Wiring"],
  );
  assert.ok(
    !plan.update.entries.some((e: any) => e.content.includes("stale")),
    "the stale entry must be gone after the reconcile",
  );
});

test("seam: a logically-failed TaskUpdate does NOT mutate the plan", () => {
  const taskState: TaskState = new Map([["1", { subject: "Fix it", status: "pending" }]]);
  const cache: Record<string, unknown> = {};
  const notifs: any = runTaskTurn(
    { id: "toolu_u1", name: "TaskUpdate", input: { taskId: "1", status: "completed" } },
    {
      content: "Task #1 not found",
      toolUseResult: { success: false, taskId: "1", updatedFields: [] },
    },
    taskState,
    cache,
  );
  assert.equal(taskState.get("1")?.status, "pending", "the rejected mutation must not persist");
  assert.ok(
    !notifs.some((n: any) => n.update.sessionUpdate === "plan"),
    "no plan update is emitted for a rejected TaskUpdate",
  );
});
