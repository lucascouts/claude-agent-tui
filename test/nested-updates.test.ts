// Story 041 / sub-task 2.1 — `nestedUpdatesFor` builds the ACP `tool_call_update` that renders ONE
// nested sub-agent row UNDER its spawning Task tool_call. It REUSES the 018/019/020 translators
// (`toAcpNotifications`) for the block→content mapping, then re-targets the result as `tool_call_update`
// content on the PARENT tool_use id (Zed merges by tool_call_id and appends content — ZED-CLIENT-STUDY §Q2).
// node:test runner: `node --experimental-strip-types --test test/nested-updates.test.ts` (build first).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeAcpAgent } from "../dist/acp-agent.js";

function makeAgent() {
  const captured: any[] = [];
  const client = {
    sessionUpdate: async (n: any) => {
      captured.push(n);
    },
    requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    readTextFile: async () => ({ content: "" }),
    writeTextFile: async () => ({}),
  } as never;
  const fakeStartEngine = (args: { sessionId?: string; cwd: string }) => ({
    sessionId: args.sessionId ?? "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    pty: {
      onExit: () => ({ dispose() {} }),
      onData: () => ({ dispose() {} }),
      resize() {},
      write() {},
      kill() {},
    } as never,
    watcher: { stop() {}, notifyEndOfTurn() {} },
    cwd: args.cwd,
  });
  const agent: any = new ClaudeAcpAgent(client, undefined, undefined, {
    startEngine: fakeStartEngine,
    getMessages: async () => [] as never,
  });
  return { agent, captured };
}

// Flatten every ToolCallContent (`type:"content"`) item across all returned notifications into the
// inner ContentBlock list, so a test can look for a translated text/thinking block regardless of how
// the helper batches them into one or several `tool_call_update`s.
function innerContentBlocks(notifications: any[]) {
  const blocks: any[] = [];
  for (const n of notifications) {
    for (const item of n.update?.content ?? []) {
      if (item?.type === "content") blocks.push(item.content);
    }
  }
  return blocks;
}

test("a nested row with text/thinking blocks → tool_call_update(s) on the parent id carrying the translated content", () => {
  const { agent } = makeAgent();
  const parentId = "toolu_PARENT";
  const message = {
    uuid: "s1",
    parent_tool_use_id: parentId,
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "let me think" },
        { type: "text", text: "subagent result" },
      ],
    },
  };

  const out = (agent as any).nestedUpdatesFor("sess-1", message, {});

  assert.ok(Array.isArray(out), "returns an array of SessionNotification");
  assert.ok(out.length >= 1, "emits at least one notification for a non-empty nested row");

  // EVERY emitted notification is a `tool_call_update` targeting the PARENT tool_use id — so Zed
  // merges the rows UNDER the spawning Task tool_call, never as a sibling/top-level call.
  for (const n of out) {
    assert.equal(n.sessionId, "sess-1", "notification carries the session id");
    assert.equal(
      n.update?.sessionUpdate,
      "tool_call_update",
      "nested rows are emitted as tool_call_update, not a message chunk or a fresh tool_call",
    );
    assert.equal(n.update?.toolCallId, parentId, "tool_call_update targets the parent Task tool_use id");
  }

  // The translated text + thinking survive as ContentBlocks inside the parent's content array.
  const texts = innerContentBlocks(out)
    .filter((b) => b?.type === "text")
    .map((b) => b.text);
  assert.ok(texts.includes("subagent result"), "the nested text block is translated and nested under the parent");
  assert.ok(texts.includes("let me think"), "the nested thinking block is translated and nested under the parent");
});

test("a nested row whose content includes the sub-agent's OWN tool_use → summarized markdown under the parent, NOT a top-level tool_call", () => {
  const { agent } = makeAgent();
  const parentId = "toolu_PARENT";
  const message = {
    uuid: "s2",
    parent_tool_use_id: parentId,
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "before tool" },
        { type: "tool_use", id: "toolu_SUB", name: "Bash", input: { command: "ls -la" } },
      ],
    },
  };

  const out = (agent as any).nestedUpdatesFor("sess-1", message, {});

  // NO emission is a top-level `tool_call` (a fresh sibling row) and NONE targets the sub-agent's own id.
  for (const n of out) {
    assert.notEqual(
      n.update?.sessionUpdate,
      "tool_call",
      "the sub-agent's own tool_use must NOT surface as a separate top-level tool_call",
    );
    assert.equal(
      n.update?.toolCallId,
      parentId,
      "everything (incl. the sub-agent's own tool_use) stays addressed to the parent id",
    );
  }
  assert.ok(
    !out.some((n: any) => n.update?.toolCallId === "toolu_SUB"),
    "nothing is addressed to the sub-agent's own tool_use id",
  );

  // The sub-agent's tool_use is summarized as markdown text content within the parent. The Bash
  // command ("ls -la") is surfaced as the summarized title (toolInfoFromToolUse reuse), so it must
  // appear in some nested text block.
  const text = innerContentBlocks(out)
    .filter((b) => b?.type === "text")
    .map((b) => b.text)
    .join("\n");
  assert.ok(text.includes("before tool"), "the leading text block is still nested under the parent");
  assert.ok(text.includes("ls -la"), "the sub-agent's own tool_use is summarized as markdown content under the parent");
});

test("a nested row with missing/null parent_tool_use_id → returns [] (no emission)", () => {
  const { agent } = makeAgent();

  const missing = {
    uuid: "s3",
    message: { role: "assistant", content: [{ type: "text", text: "orphan" }] },
  };
  assert.deepEqual((agent as any).nestedUpdatesFor("sess-1", missing, {}), [], "missing parent_tool_use_id → []");

  const nulled = {
    uuid: "s4",
    parent_tool_use_id: null,
    message: { role: "assistant", content: [{ type: "text", text: "orphan" }] },
  };
  assert.deepEqual((agent as any).nestedUpdatesFor("sess-1", nulled, {}), [], "null parent_tool_use_id → []");
});
