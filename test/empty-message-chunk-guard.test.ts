// Story 074 / Task 2.1 (#841) — an empty full-string assistant content block must
// emit NO agent_message_chunk (return []), mirroring the empty-thinking guard (#793,
// story 056). A non-empty string still emits exactly one agent_message_chunk carrying
// its text. The `case "text"`/`text_delta` block path is DEAD in the fork (no
// content_block_delta source, story 034), so #841 lands only on the full-string path.
//
// Build first — imports resolve against ../dist:
//   node --experimental-strip-types --test test/empty-message-chunk-guard.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { toAcpNotifications } from "../dist/lib.js";

const logger = { log() {}, error() {} } as any;
const client = {} as any;

function translateString(content: string, role: "assistant" | "user" = "assistant"): any[] {
  return toAcpNotifications(content, role, "sess-074-841", {}, client, logger, {
    registerHooks: false,
  }) as any[];
}

const messageChunks = (notifs: any[]) =>
  notifs.filter((n) => n?.update?.sessionUpdate === "agent_message_chunk");

test("2.1 an empty string assistant content emits NO agent_message_chunk (#841)", () => {
  const notifs = translateString("");
  // Load-bearing: BEFORE the guard this emitted exactly one EMPTY agent_message_chunk.
  assert.equal(
    messageChunks(notifs).length,
    0,
    `an empty string content must emit no message chunk, got: ${JSON.stringify(notifs)}`,
  );
  assert.deepEqual(notifs, [], "the notification list is empty for empty content");
});

test("2.2 a non-empty string assistant content emits exactly one agent_message_chunk (unchanged)", () => {
  const notifs = translateString("hello world");
  const chunks = messageChunks(notifs);
  assert.equal(chunks.length, 1, "a non-empty string emits exactly one message chunk");
  assert.equal(chunks[0].update.content.type, "text");
  assert.equal(chunks[0].update.content.text, "hello world", "the text is carried verbatim");
});
