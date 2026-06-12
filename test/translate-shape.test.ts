// Story 018 / Task 1.3 — confirm the §7 contract that needs NO translator source change:
//   (a) each emitted variant is a FLAT `SessionUpdate` — the `sessionUpdate` discriminator and the
//       payload fields sit on the SAME object (the 0.22.1 union shape), with no nested wrapper;
//   (b) the boot `initialize` response advertises `protocolVersion` as the INTEGER 1 (not "1");
//   (c) the translator is REUSED from the public lib surface — this story re-implements nothing,
//       and the kept §6 `thinking` arm still sources prose from the `thinking` field.
//
// REGRESSION GUARD over already-delivered runtime (toAcpNotifications + initialize, story 011).
// Seam: event → `classifyEvent` (story 016) → the unmodified translator. No source change.
//
// node:test runner: `node --experimental-strip-types --test test/translate-shape.test.ts`
// (run `npm run build` first — the behavioral imports resolve against ../dist).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { classifyEvent } from "../dist/event-switch.js";
import { toAcpNotifications, ClaudeAcpAgent } from "../dist/lib.js";

const logger = { log() {}, error() {} } as any;
const client = {} as any;
const here = dirname(fileURLToPath(import.meta.url));
const forkRoot = join(here, "..");

function translate(event: unknown) {
  const c: any = classifyEvent(event as any);
  return toAcpNotifications(c.content, c.role, "sess-018", {}, client, logger);
}

test("shape: all three variants are FLAT SessionUpdates (discriminator + payload on one object)", () => {
  const assistant: any = translate({
    uuid: "s1",
    type: "assistant",
    userType: "external",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "t" },
        { type: "thinking", thinking: "k" },
      ],
    },
  });
  const user: any = translate({
    uuid: "s2",
    type: "user",
    userType: "external",
    message: { role: "user", content: [{ type: "text", text: "u" }] },
  });

  const updates = [...assistant, ...user].map((n: any) => n.update);
  assert.deepEqual(
    updates.map((u: any) => u.sessionUpdate),
    ["agent_message_chunk", "agent_thought_chunk", "user_message_chunk"],
  );
  for (const u of updates) {
    // The discriminator and payload are flattened onto the SAME object — matching the frozen
    // 0.22.1 discriminated union — with no nested `update` wrapper inside the SessionUpdate.
    assert.equal(typeof u.sessionUpdate, "string", "discriminator sits on the update object");
    assert.ok("content" in u, "payload (content) is flattened onto the same object");
    assert.ok(!("update" in u), "no nested `update` wrapper inside the SessionUpdate");
  }
});

test("shape: initialize advertises protocolVersion as the integer 1 (rejects the string '1')", async () => {
  const agent = new ClaudeAcpAgent({}, console);
  const res: any = await agent.initialize({
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
  });
  assert.equal(typeof res.protocolVersion, "number", "protocolVersion must be a number, not a string");
  assert.ok(Number.isInteger(res.protocolVersion), "protocolVersion must be an integer");
  assert.equal(res.protocolVersion, 1, "protocolVersion must be exactly 1");
});

test("shape: the translator is REUSED unmodified (no local re-implementation in this story)", () => {
  // The behavioral import is the upstream public export — a real function, not a local stand-in.
  assert.equal(typeof toAcpNotifications, "function", "toAcpNotifications must be the reused lib export");
  // This story authors NO production translator: its own test must not re-declare one.
  const self = readFileSync(join(here, "translate-shape.test.ts"), "utf8");
  assert.ok(
    !/function\s+toAcpNotifications\b/.test(self),
    "the story must not re-implement the translator locally",
  );
  // And the kept §6 `thinking` arm still sources prose from the `thinking` field (reuse intact).
  const src = readFileSync(join(forkRoot, "src", "acp-agent.ts"), "utf8");
  assert.ok(
    /text:\s*chunk\.thinking/.test(src),
    "the reused translator must still source thinking from the `thinking` field",
  );
});
