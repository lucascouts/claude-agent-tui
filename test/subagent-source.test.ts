// Story 041 / Group 1 (task 1.1) — sourceSubagentRows guards the SDK listSubagents call behind a
// main-chain Task/Agent tool_use probe (R5.2 cheap path) and otherwise sources the merged subagent
// rows via two injectable seams (listSubagents → agentIds, getSubagentMessages → rows per agent).
// node:test runner: `node --experimental-strip-types --test test/subagent-source.test.ts` (build first).
import { test } from "node:test";
import assert from "node:assert/strict";
import { sourceSubagentRows } from "../dist/subagent-source.js";

// A main-chain assistant turn carrying a Task tool_use block (the only thing that should arm sourcing).
function taskTurn(toolId: string) {
  return {
    uuid: "m-task",
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: toolId, name: "Task", input: { description: "sub" } }],
    },
  };
}

// A plain text main-chain turn (no Task/Agent tool_use → must NOT trigger listSubagents).
function textTurn(text: string) {
  return {
    uuid: "m-text",
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
  };
}

test("no Task/Agent tool_use in the main chain → returns [] WITHOUT invoking listSubagents (R5.2)", async () => {
  let listCalls = 0;
  let getCalls = 0;
  const listSubagents = async () => {
    listCalls++;
    return ["agent-never"];
  };
  const getSubagentMessages = async () => {
    getCalls++;
    return [{ uuid: "x" }] as never;
  };

  const rows = await sourceSubagentRows("sess", [textTurn("hi"), textTurn("bye")] as never, {
    dir: "/w",
    listSubagents,
    getSubagentMessages,
  });

  assert.deepEqual(rows, [], "no main-chain Task/Agent → empty rows");
  assert.equal(listCalls, 0, "R5.2 cheap path: listSubagents is never invoked when no Task/Agent present");
  assert.equal(getCalls, 0, "getSubagentMessages is never invoked either");
});

test("a Task tool_use in the main chain → seams ARE invoked; returns the concatenated subagent rows", async () => {
  const listArgs: Array<[string, { dir?: string } | undefined]> = [];
  const getArgs: Array<[string, string, { dir?: string } | undefined]> = [];
  const listSubagents = async (sessionId: string, opts?: { dir?: string }) => {
    listArgs.push([sessionId, opts]);
    return ["agent-1"];
  };
  const subRows = [{ uuid: "s1" }, { uuid: "s2" }];
  const getSubagentMessages = async (sessionId: string, agentId: string, opts?: { dir?: string }) => {
    getArgs.push([sessionId, agentId, opts]);
    return subRows as never;
  };

  const rows = await sourceSubagentRows("sess", [textTurn("hi"), taskTurn("toolu_T")] as never, {
    dir: "/w",
    listSubagents,
    getSubagentMessages,
  });

  assert.deepEqual(listArgs, [["sess", { dir: "/w" }]], "listSubagents invoked once with (sessionId, { dir })");
  assert.deepEqual(getArgs, [["sess", "agent-1", { dir: "/w" }]], "getSubagentMessages invoked per agentId with (sessionId, agentId, { dir })");
  assert.deepEqual(rows, subRows, "rows are exactly the sourced subagent rows");
});

test("multiple agentIds → rows from ALL agents are aggregated (concatenated in agentId order)", async () => {
  const listSubagents = async () => ["agent-1", "agent-2", "agent-3"];
  const perAgent: Record<string, unknown[]> = {
    "agent-1": [{ uuid: "a1-r1" }, { uuid: "a1-r2" }],
    "agent-2": [{ uuid: "a2-r1" }],
    "agent-3": [{ uuid: "a3-r1" }, { uuid: "a3-r2" }],
  };
  const getSubagentMessages = async (_sessionId: string, agentId: string) =>
    perAgent[agentId] as never;

  const rows = await sourceSubagentRows("sess", [taskTurn("toolu_T")] as never, {
    dir: "/w",
    listSubagents,
    getSubagentMessages,
  });

  assert.deepEqual(
    (rows as Array<{ uuid?: string }>).map((r) => r.uuid),
    ["a1-r1", "a1-r2", "a2-r1", "a3-r1", "a3-r2"],
    "all agents' rows concatenated in agentId order",
  );
});

test("an Agent tool_use (alias of Task) also arms sourcing", async () => {
  let listCalls = 0;
  const listSubagents = async () => {
    listCalls++;
    return ["agent-1"];
  };
  const getSubagentMessages = async () => [{ uuid: "s1" }] as never;
  const agentTurn = {
    uuid: "m-agent",
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_A", name: "Agent", input: {} }],
    },
  };

  const rows = await sourceSubagentRows("sess", [agentTurn] as never, {
    dir: "/w",
    listSubagents,
    getSubagentMessages,
  });

  assert.equal(listCalls, 1, "an Agent tool_use also triggers sourcing");
  assert.deepEqual((rows as Array<{ uuid?: string }>).map((r) => r.uuid), ["s1"]);
});
