import { test } from "node:test";
import assert from "node:assert/strict";
import { toUsageUpdate } from "../dist/usage.js";

// Story 025 / Task 3.2 (R3.2) — toUsageUpdate maps a JSONL message-event
// usage.{input,output}_tokens into the UNSTABLE usage_update SessionUpdate (SDK 0.22.1:
// { sessionUpdate: "usage_update", size, used }). Pure, total, best-effort (§1): no usage
// tokens -> no notification; never throws on a partial/absent usage block; never
// fabricates counts. Whether the user's Zed ACCEPTS the notification is the empirical R8
// probe recorded in FORK.md (Task 3.3) — not asserted here.

test("toUsageUpdate: maps input+output tokens to the UNSTABLE usage_update shape (R3.2)", () => {
  const u = toUsageUpdate({ usage: { input_tokens: 100, output_tokens: 30 } });
  assert.ok(u, "a message with usage tokens must produce a notification");
  assert.equal(u.sessionUpdate, "usage_update");
  assert.equal(u.used, 130, "used = input_tokens + output_tokens");
  assert.equal(typeof u.size, "number", "size must be a number");
});

test("toUsageUpdate: uses the supplied contextWindowSize as `size` when given (R3.2)", () => {
  const u = toUsageUpdate(
    { usage: { input_tokens: 100, output_tokens: 30 } },
    { contextWindowSize: 200000 },
  );
  assert.ok(u);
  assert.equal(u.size, 200000, "size comes from the supplied context window");
  assert.equal(u.used, 130);
});

test("toUsageUpdate: absent/null usage yields no notification (best-effort skip, §1)", () => {
  assert.equal(toUsageUpdate({}), undefined);
  assert.equal(toUsageUpdate({ usage: null }), undefined);
  assert.equal(toUsageUpdate({ usage: {} }), undefined);
  assert.equal(toUsageUpdate({ usage: { input_tokens: null, output_tokens: null } }), undefined);
});

test("toUsageUpdate: partial usage is total — counts only present tokens, never throws", () => {
  const onlyInput = toUsageUpdate({ usage: { input_tokens: 50 } });
  assert.ok(onlyInput);
  assert.equal(onlyInput.used, 50);
  const onlyOutput = toUsageUpdate({ usage: { output_tokens: 20 } });
  assert.ok(onlyOutput);
  assert.equal(onlyOutput.used, 20);
});
