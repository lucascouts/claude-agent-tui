// Story 018 / Task 1.2 — route `thinking` blocks through the REUSED, unmodified `toAcpNotifications`
// to `agent_thought_chunk`, sourcing the prose from the §6 `thinking` field — NOT `text`.
//
// The named risk (§7 / tasks.md): a `thinking` block carries its prose in `thinking`, not `text`;
// mis-reading it as `text` SILENTLY DROPS the thinking content. The decoy test below pins exactly
// that — it fails if the translator ever reads `text`. REGRESSION GUARD: translator kept intact,
// seam = event → `classifyEvent` (story 016) → translator. No translator source is changed.
//
// node:test runner: `node --experimental-strip-types --test test/translate-thinking.test.ts`
// (run `npm run build` first — the behavioral imports resolve against ../dist).
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyEvent } from "../dist/event-switch.js";
import { toAcpNotifications } from "../dist/lib.js";

const logger = { log() {}, error() {} } as any;
const client = {} as any;

function translate(event: unknown) {
  const c: any = classifyEvent(event as any);
  return toAcpNotifications(c.content, c.role, "sess-018", {}, client, logger);
}

test("thinking: one block → one agent_thought_chunk whose text is the `thinking` field", () => {
  const notifs: any = translate({
    uuid: "t1",
    type: "assistant",
    userType: "external",
    message: { role: "assistant", content: [{ type: "thinking", thinking: "let me reason" }] },
  });
  assert.equal(notifs.length, 1, "one thought chunk per thinking block");
  assert.equal(notifs[0].update.sessionUpdate, "agent_thought_chunk");
  assert.deepEqual(notifs[0].update.content, { type: "text", text: "let me reason" });
});

test("thinking: the `text` field is NOT read — only `thinking` carries the prose (silent-drop guard)", () => {
  // A block with BOTH a decoy `text` and the real `thinking`: the chunk MUST use `thinking`.
  const notifs: any = translate({
    uuid: "t2",
    type: "assistant",
    userType: "external",
    message: {
      role: "assistant",
      content: [{ type: "thinking", thinking: "real thought", text: "DECOY must not be read" }],
    },
  });
  assert.equal(notifs[0].update.content.text, "real thought");
  assert.notEqual(notifs[0].update.content.text, "DECOY must not be read");
});

test("thinking: a block carrying a `signature` is handled without throwing", () => {
  assert.doesNotThrow(() => {
    const notifs: any = translate({
      uuid: "t3",
      type: "assistant",
      userType: "external",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "signed", signature: "sig-abc123" }],
      },
    });
    assert.equal(notifs[0].update.sessionUpdate, "agent_thought_chunk");
    assert.equal(notifs[0].update.content.text, "signed");
  });
});
