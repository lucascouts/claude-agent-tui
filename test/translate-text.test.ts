// Story 018 / Task 1.1 — route assistant/user `text` blocks through the REUSED, unmodified
// `toAcpNotifications` and lock the §7 variants: text(assistant) → agent_message_chunk,
// text(user) → user_message_chunk, exactly one chunk per block (no token-by-token split).
//
// REGRESSION GUARD over already-delivered runtime: the §7 translator (`toAcpNotifications`,
// story 011) is kept byte-for-byte; this story only WIRES the seam and asserts. The composition
// mirrors the Degrau-1 read path: a typed JSONL event → `classifyEvent` (story 016 — §6 content
// normalisation, array-OR-string) → the unmodified translator. No translator source is changed.
//
// node:test runner: `node --experimental-strip-types --test test/translate-text.test.ts`
// (run `npm run build` first — the behavioral imports resolve against ../dist).
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyEvent } from "../dist/event-switch.js";
import { toAcpNotifications } from "../dist/lib.js";

// On the text/thinking arms `toAcpNotifications` never touches (client, logger, toolUseCache) —
// only tool_use registers hooks / calls the client — so minimal stubs suffice (§7 reuse, decision 4
// read-only: no ACP-side input is fed into the translator).
const logger = { log() {}, error() {} } as any;
const client = {} as any;

/** Compose the Degrau-1 read seam exactly as production would: event → classifyEvent → translator. */
function translate(event: unknown) {
  const c: any = classifyEvent(event as any);
  return toAcpNotifications(c.content, c.role, "sess-018", {}, client, logger);
}

test("text(assistant): one block → one agent_message_chunk {content:{type:'text',text}}", () => {
  const notifs: any = translate({
    uuid: "a1",
    type: "assistant",
    userType: "external",
    message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
  });
  assert.equal(notifs.length, 1, "exactly one chunk per text block (no token-by-token)");
  assert.equal(notifs[0].update.sessionUpdate, "agent_message_chunk");
  assert.deepEqual(notifs[0].update.content, { type: "text", text: "hello" });
});

test("text(user): one block → one user_message_chunk {content:{type:'text',text}}", () => {
  const notifs: any = translate({
    uuid: "u1",
    type: "user",
    userType: "external",
    message: { role: "user", content: [{ type: "text", text: "hi back" }] },
  });
  assert.equal(notifs.length, 1);
  assert.equal(notifs[0].update.sessionUpdate, "user_message_chunk");
  assert.deepEqual(notifs[0].update.content, { type: "text", text: "hi back" });
});

test("text: two text blocks → exactly two chunks (one per block, never token-split)", () => {
  const notifs: any = translate({
    uuid: "a2",
    type: "assistant",
    userType: "external",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
    },
  });
  assert.equal(notifs.length, 2, "one chunk per block — `streamEventToAcpNotifications` stays unwired");
  assert.deepEqual(
    notifs.map((n: any) => n.update.sessionUpdate),
    ["agent_message_chunk", "agent_message_chunk"],
  );
  assert.deepEqual(
    notifs.map((n: any) => n.update.content.text),
    ["first", "second"],
  );
});
