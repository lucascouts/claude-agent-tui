// Story 054 / Group 1 (tasks 1.1 + 1.2) — the NEW pure module `subagent-gate.ts` that turns the
// pump's already-sourced sidechain rows into the gate correlator's feed.
//
//   1.1 collectSidechainToolUses(rows): walk each `type==='assistant'` sidechain row's
//       `message.content`, emit one SidechainToolUse {id, parentId, toolName, toolInput} per
//       `tool_use` block. `parentId` is the row's `parent_tool_use_id` (the spawning Task/Agent id);
//       a row with no parent field → `parentId === null` (orphan).
//   1.2 registerSidechainGateToolUses(uses, correlator, registered, parentMap): register each
//       use.id into the correlator EXACTLY ONCE (per-session dedup Set), populate parentMap, and be
//       idempotent — a second call over the same rows registers nothing new and leaves every clean
//       id `isCleanMatch === true` (a second register would mark it a duplicate → fail-closed).
//
// Authored from design.md "Design Contracts" + Testing Strategy only (no ToDo). Pure module, no I/O.
// node:test runner (build first):
//   node --experimental-strip-types --test test/subagent-gate.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectSidechainToolUses,
  registerSidechainGateToolUses,
  type SidechainToolUse,
} from "../dist/subagent-gate.js";
import { ToolUseCorrelator } from "../dist/permissions/request-permission.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "..", "fixtures", "lin-live-subagent.jsonl");

/** Parse the JSONL fixture into rows (the reduced SessionMessage[] shape the pump hands the helper). */
function fixtureRows(): unknown[] {
  return readFileSync(FIXTURE, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

/** A sidechain assistant row carrying one tool_use block under a given parent (or no parent → orphan). */
function sidechainToolUseRow(opts: {
  uuid: string;
  parentId: string | null;
  toolId: string;
  toolName: string;
  toolInput: unknown;
}) {
  const row: Record<string, unknown> = {
    uuid: opts.uuid,
    type: "assistant",
    isSidechain: true,
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: opts.toolId, name: opts.toolName, input: opts.toolInput }],
    },
  };
  if (opts.parentId !== null) row.parent_tool_use_id = opts.parentId;
  return row;
}

// === 1.1 collectSidechainToolUses ==================================================================

test("1.1 collect extracts one SidechainToolUse per tool_use block, carrying id/parentId/name/input", () => {
  const rows = [
    sidechainToolUseRow({
      uuid: "sb1",
      parentId: "toolu_task_1",
      toolId: "toolu_inner_bash",
      toolName: "Bash",
      toolInput: { command: "ls -la" },
    }),
  ];

  const uses = collectSidechainToolUses(rows as never);

  assert.equal(uses.length, 1, "one tool_use block → one SidechainToolUse");
  const u = uses[0];
  assert.equal(u.id, "toolu_inner_bash", "id is the inner tool_use.id (the correlation key)");
  assert.equal(u.parentId, "toolu_task_1", "parentId is the spawning Task tool_use id");
  assert.equal(u.toolName, "Bash", "toolName is the inner tool name");
  assert.deepEqual(u.toolInput, { command: "ls -la" }, "toolInput is the raw inner input (R7)");
});

test("1.1 a sidechain tool_use with NO parent field yields parentId === null (orphan)", () => {
  const rows = [
    sidechainToolUseRow({
      uuid: "sb-orphan",
      parentId: null,
      toolId: "toolu_orphan_inner",
      toolName: "Bash",
      toolInput: { command: "whoami" },
    }),
  ];

  const uses = collectSidechainToolUses(rows as never);

  assert.equal(uses.length, 1);
  assert.equal(uses[0].parentId, null, "a row with no parent_tool_use_id → parentId is null, not undefined");
});

test("1.1 multiple tool_use blocks across rows are all collected; non-tool_use content is ignored", () => {
  const rows = [
    {
      uuid: "sb-text",
      type: "assistant",
      isSidechain: true,
      parent_tool_use_id: "toolu_task_1",
      message: { role: "assistant", content: [{ type: "text", text: "thinking" }] },
    },
    sidechainToolUseRow({
      uuid: "sb-a",
      parentId: "toolu_task_1",
      toolId: "toolu_a",
      toolName: "Read",
      toolInput: { file_path: "/x" },
    }),
    {
      uuid: "sb-multi",
      type: "assistant",
      isSidechain: true,
      parent_tool_use_id: "toolu_task_1",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "and also" },
          { type: "tool_use", id: "toolu_b", name: "Bash", input: { command: "pwd" } },
        ],
      },
    },
  ];

  const uses = collectSidechainToolUses(rows as never);

  assert.deepEqual(
    uses.map((u: SidechainToolUse) => u.id),
    ["toolu_a", "toolu_b"],
    "every tool_use block across rows is collected, in order; the text-only row contributes nothing",
  );
});

test("1.1 over the live fixture: text-only sidechain rows produce no tool_use entries (orphan parent has no inner tool)", () => {
  // lin-live-subagent.jsonl's sidechain rows (incl. the toolu_missing_99 orphan) are text-only:
  // collect must not invent tool_use entries from text content.
  const uses = collectSidechainToolUses(fixtureRows() as never);
  assert.deepEqual(uses, [], "no sidechain tool_use blocks in the fixture → empty collection");
});

// === 1.2 registerSidechainGateToolUses =============================================================

test("1.2 register feeds each inner id into the correlator once and populates parentMap", () => {
  const correlator = new ToolUseCorrelator();
  const registered = new Set<string>();
  const parentMap = new Map<string, SidechainToolUse>();
  const uses: SidechainToolUse[] = [
    { id: "toolu_x", parentId: "toolu_task_1", toolName: "Bash", toolInput: { command: "ls" } },
    { id: "toolu_y", parentId: "toolu_task_1", toolName: "Read", toolInput: { file_path: "/y" } },
  ];

  registerSidechainGateToolUses(uses, correlator, registered, parentMap);

  assert.equal(correlator.isCleanMatch("toolu_x"), true, "toolu_x registered exactly once → clean match");
  assert.equal(correlator.isCleanMatch("toolu_y"), true, "toolu_y registered exactly once → clean match");
  assert.deepEqual([...registered].sort(), ["toolu_x", "toolu_y"], "both ids recorded in the dedup Set");
  assert.equal(parentMap.get("toolu_x")?.parentId, "toolu_task_1", "parentMap maps inner id → its use entry");
  assert.equal(parentMap.get("toolu_y")?.toolName, "Read", "parentMap entry carries the inner tool detail");
});

test("1.2 a SECOND call over the same rows registers nothing new and leaves isCleanMatch TRUE (exactly-once dedup)", () => {
  const correlator = new ToolUseCorrelator();
  const registered = new Set<string>();
  const parentMap = new Map<string, SidechainToolUse>();
  const uses: SidechainToolUse[] = [
    { id: "toolu_dup", parentId: "toolu_task_1", toolName: "Bash", toolInput: { command: "ls" } },
  ];

  registerSidechainGateToolUses(uses, correlator, registered, parentMap);
  assert.equal(correlator.isCleanMatch("toolu_dup"), true, "after the first feed the id is a clean match");

  // The pump re-reads overlapping rows; a naive re-register would call correlator.register twice →
  // the id becomes a DUPLICATE → fail-closed deny. The dedup Set must prevent that.
  registerSidechainGateToolUses(uses, correlator, registered, parentMap);
  assert.equal(
    correlator.isCleanMatch("toolu_dup"),
    true,
    "a second feed over the same rows must NOT double-register — the id stays a clean match",
  );
});

test("1.2 ids NOT already in the dedup Set register; ids already in it are skipped (idempotent merge)", () => {
  const correlator = new ToolUseCorrelator();
  const registered = new Set<string>(["toolu_old"]);
  correlator.register("toolu_old"); // already fed on a prior pump pass
  const parentMap = new Map<string, SidechainToolUse>();
  const uses: SidechainToolUse[] = [
    { id: "toolu_old", parentId: "toolu_task_1", toolName: "Bash", toolInput: {} },
    { id: "toolu_new", parentId: "toolu_task_1", toolName: "Read", toolInput: {} },
  ];

  registerSidechainGateToolUses(uses, correlator, registered, parentMap);

  assert.equal(correlator.isCleanMatch("toolu_old"), true, "the already-registered id was NOT re-registered");
  assert.equal(correlator.isCleanMatch("toolu_new"), true, "the new id was registered exactly once");
  assert.equal(registered.has("toolu_new"), true, "the new id joined the dedup Set");
});
