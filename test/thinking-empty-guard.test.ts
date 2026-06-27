// Story 056 / Task 4.2 (#793) — a signature-only thinking block (thinking.display "omitted") carries
// EMPTY text; the translator must SUPPRESS the agent_thought_chunk rather than emit an empty one. A
// thinking block with real text still emits exactly one agent_thought_chunk carrying that text.
//
// The fix guards the `case "thinking"` emit in `toAcpNotifications` with `if (chunk.thinking.length > 0)`
// so an empty block leaves `update` null → no push at the `if (update)` guard.
//
// Routes a real assistant event through classifyEvent → the reused toAcpNotifications (mirrors
// translate-tool-result.test.ts). Build first — imports resolve against ../dist:
//   node --experimental-strip-types --test test/thinking-empty-guard.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyEvent } from "../dist/event-switch.js";
import { toAcpNotifications } from "../dist/lib.js";

const logger = { log() {}, error() {} } as any;
const client = {} as any;

function translate(block: unknown): any[] {
  const event = {
    uuid: "th",
    type: "assistant",
    userType: "external",
    message: { role: "assistant", content: [block] },
  };
  const c: any = classifyEvent(event as any);
  return toAcpNotifications(c.content, c.role, "sess-056-793", {}, client, logger, {
    registerHooks: false,
  }) as any[];
}

const thoughtChunks = (notifs: any[]) =>
  notifs.filter((n) => n?.update?.sessionUpdate === "agent_thought_chunk");

test("4.2 a signature-only thinking block (empty text) emits NO agent_thought_chunk (#793)", () => {
  const notifs = translate({ type: "thinking", thinking: "", signature: "sig-abc" });
  // Load-bearing: BEFORE the fix this emitted exactly one EMPTY agent_thought_chunk.
  assert.equal(
    thoughtChunks(notifs).length,
    0,
    `an empty thinking block must emit no thought chunk, got: ${JSON.stringify(notifs)}`,
  );
});

test("4.2 a non-empty thinking block emits exactly one agent_thought_chunk with its text (unchanged)", () => {
  const notifs = translate({ type: "thinking", thinking: "deep thought", signature: "sig-xyz" });
  const chunks = thoughtChunks(notifs);
  assert.equal(chunks.length, 1, "a non-empty thinking block still emits exactly one thought chunk");
  assert.equal(chunks[0].update.content.type, "text");
  assert.equal(chunks[0].update.content.text, "deep thought", "the thinking text is carried verbatim");
});
