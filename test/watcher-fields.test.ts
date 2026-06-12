// Story 015 / Task 4.1 — project the universal message-event fields into a typed JsonlEvent.
//
// EMPIRICAL SDK REALITY: `getSessionMessages` returns objects with EXACTLY
//   { uuid, type, timestamp, session_id, message, parent_tool_use_id }
// (verified against 174 real messages). `projectEvent` maps those onto a typed event, hardcodes
// userType:'external' (the story asserts it is always external), and DEFENSIVELY passes through any
// optional universal field / per-type extra that happens to be present on the input — else leaves
// it undefined (R6.1, R6.2, R6.3). It accepts `message.content` as an ARRAY or a raw STRING (R6.4).
// node:test runner: `node --experimental-strip-types --test test/watcher-fields.test.ts`
// (run `npm run build` first — behavioral imports resolve against ../dist).
import { test } from "node:test";
import assert from "node:assert/strict";
import { projectEvent } from "../dist/jsonl.js";

/** An assistant message in the EMPIRICAL getSessionMessages shape (array content). */
function assistantFixture() {
  return {
    uuid: "asst-uuid-1",
    type: "assistant",
    timestamp: "2026-06-03T12:00:00.000Z",
    session_id: "sess-abc",
    parent_tool_use_id: null,
    message: {
      role: "assistant",
      id: "msg_123",
      model: "claude-opus-4-8",
      type: "message",
      content: [{ type: "text", text: "hello world" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  };
}

/** A user message in the EMPIRICAL getSessionMessages shape (array content). */
function userFixture() {
  return {
    uuid: "user-uuid-1",
    type: "user",
    timestamp: "2026-06-03T11:59:00.000Z",
    session_id: "sess-abc",
    parent_tool_use_id: "toolu_parent_9",
    message: {
      role: "user",
      content: [{ type: "text", text: "do the thing" }],
    },
  };
}

test("projectEvent: assistant — carries available universal fields + userType 'external'", () => {
  const event = projectEvent(assistantFixture());

  // Fields getSessionMessages provides, mapped to the typed names.
  assert.equal(event.uuid, "asst-uuid-1");
  assert.equal(event.type, "assistant");
  assert.equal(event.timestamp, "2026-06-03T12:00:00.000Z");
  assert.equal(event.sessionId, "sess-abc"); // from session_id
  assert.equal(event.parentToolUseId, null); // from parent_tool_use_id

  // The story asserts the user type is always 'external' (hardcoded, not read from input).
  assert.equal(event.userType, "external");

  // The message object is carried through (content array preserved here — no image to strip).
  assert.ok(event.message && typeof event.message === "object");
  const msg = event.message as { content: Array<{ type: string; text: string }> };
  assert.deepEqual(msg.content, [{ type: "text", text: "hello world" }]);

  // Absent universal fields / extras are left undefined (REUSE-live source lacks them).
  assert.equal(event.parentUuid, undefined);
  assert.equal(event.cwd, undefined);
  assert.equal(event.gitBranch, undefined);
  assert.equal(event.version, undefined);
  assert.equal(event.isSidechain, undefined);
  assert.equal(event.entrypoint, undefined);
  assert.equal(event.requestId, undefined);
  assert.equal(event.promptId, undefined);
  assert.equal(event.permissionMode, undefined);
});

test("projectEvent: user — maps session_id + parent_tool_use_id, userType 'external'", () => {
  const event = projectEvent(userFixture());

  assert.equal(event.uuid, "user-uuid-1");
  assert.equal(event.type, "user");
  assert.equal(event.sessionId, "sess-abc");
  assert.equal(event.parentToolUseId, "toolu_parent_9"); // non-null parent carried through
  assert.equal(event.userType, "external");
  assert.equal(event.timestamp, "2026-06-03T11:59:00.000Z");
});

test("projectEvent: per-type extras passed through when PRESENT on the input (defensive)", () => {
  // A raw-shaped fixture that DOES carry the optional fields → they must pass through (R6.1–R6.3).
  const assistantWithExtras = {
    ...assistantFixture(),
    requestId: "req_assistant_42",
    parentUuid: "parent-uuid-7",
    cwd: "/home/otaku/project",
    gitBranch: "main",
    version: "2.1.159",
    isSidechain: false,
    entrypoint: "cli",
  };
  const a = projectEvent(assistantWithExtras);
  assert.equal(a.requestId, "req_assistant_42");
  assert.equal(a.parentUuid, "parent-uuid-7");
  assert.equal(a.cwd, "/home/otaku/project");
  assert.equal(a.gitBranch, "main");
  assert.equal(a.version, "2.1.159");
  assert.equal(a.isSidechain, false);
  assert.equal(a.entrypoint, "cli");

  const userWithExtras = {
    ...userFixture(),
    promptId: "prompt_99",
    toolUseResult: { ok: true, items: [1, 2, 3] },
    permissionMode: "acceptEdits",
  };
  const u = projectEvent(userWithExtras);
  assert.equal(u.promptId, "prompt_99");
  assert.deepEqual(u.toolUseResult, { ok: true, items: [1, 2, 3] });
  assert.equal(u.permissionMode, "acceptEdits");
});

test("projectEvent: accepts message.content as a raw STRING without error (R6.4)", () => {
  const stringContent = {
    uuid: "str-uuid-1",
    type: "assistant",
    session_id: "sess-xyz",
    parent_tool_use_id: null,
    message: { role: "assistant", content: "just a plain string body" },
  };
  // Must NOT throw, and must leave the string content untouched.
  const event = projectEvent(stringContent);
  assert.equal(event.uuid, "str-uuid-1");
  assert.equal(event.userType, "external");
  const msg = event.message as { content: unknown };
  assert.equal(msg.content, "just a plain string body");
});

test("projectEvent: tolerates unusual input — non-object, missing uuid, absent message", () => {
  // Non-object input → empty uuid/type, undefined message; no throw (per design notes).
  const fromNull = projectEvent(undefined);
  assert.equal(fromNull.uuid, "");
  assert.equal(fromNull.type, "");
  assert.equal(fromNull.message, undefined);
  assert.equal(fromNull.userType, "external");

  // Object missing uuid → uuid falls back to empty string, type still carried.
  const noUuid = projectEvent({ type: "system", message: { content: "x" } });
  assert.equal(noUuid.uuid, "");
  assert.equal(noUuid.type, "system");

  // Object with no `message` at all → message is undefined, still no throw.
  const noMessage = projectEvent({ uuid: "u", type: "user" });
  assert.equal(noMessage.uuid, "u");
  assert.equal(noMessage.message, undefined);
});

test("projectEvent: does NOT mutate the input message in place", () => {
  const input = assistantFixture();
  const before = JSON.stringify(input);
  projectEvent(input);
  // The input (and its content array) must be untouched — the watcher may hold references.
  assert.equal(JSON.stringify(input), before);
});
