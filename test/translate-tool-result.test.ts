// Story 019 / Task 1.3 — route a `tool_result` block through the REUSED, unmodified
// `toAcpNotifications` + `tools.ts` (`toolUpdateFromToolResult`) and lock the §7 result variant:
// a `tool_call_update` keyed by `tool_use_id`, `status:'failed'` when `is_error` is truthy and
// `'completed'` otherwise — treating `is_error===null` as NOT an error (§7) — with `content`
// carried whether it is a raw STRING or an ARRAY (incl. the `tool_reference` sub-block, §6).
//
// REGRESSION GUARD over already-delivered runtime: the §7 translator (`toAcpNotifications` +
// `tools.ts`, story 011) is kept byte-for-byte; this story only WIRES the seam and asserts.
// Seam: typed JSONL event → `classifyEvent` (story 016) → the unmodified translator. No src change.
//
// RUNTIME ORDER (not a drift, a composition fact): the reused translator only emits a result update
// when the matching `tool_use` is already in the shared `toolUseCache` (acp-agent.ts logs-and-skips an
// untracked result). The live read path satisfies this naturally; here each test PRIMES the cache with
// the tool_use before the tool_result, sharing one cache object — mirroring production order.
//
// node:test runner: `node --experimental-strip-types --test test/translate-tool-result.test.ts`
// (run `npm run build` first — the behavioral imports resolve against ../dist).
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyEvent } from "../dist/event-switch.js";
import { toAcpNotifications } from "../dist/lib.js";

const logger = { log() {}, error() {} } as any;
const client = {} as any;

function translate(event: unknown, cache: any) {
  const c: any = classifyEvent(event as any);
  return toAcpNotifications(c.content, c.role, "sess-019", cache, client, logger, {
    registerHooks: false,
  });
}

const asAssistant = (block: unknown) => ({
  uuid: "tu",
  type: "assistant",
  userType: "external",
  message: { role: "assistant", content: [block] },
});
const asUser = (block: unknown) => ({
  uuid: "tr",
  type: "user",
  userType: "external",
  message: { role: "user", content: [block] },
});

/**
 * Prime the cache with `toolUse`, then translate `toolResult` through the SAME cache and return the
 * result notifications. `toolUse` defaults to a `Read` matching `toolResult.tool_use_id`.
 */
function resultFor(toolResult: any, toolUse?: any) {
  const cache = {};
  const tu = toolUse ?? {
    type: "tool_use",
    id: toolResult.tool_use_id,
    name: "Read",
    input: { file_path: "/a.ts" },
  };
  translate(asAssistant(tu), cache); // prime: without this the result is logged-and-dropped
  return translate(asUser(toolResult), cache) as any;
}

test("tool_result(success, is_error absent) → tool_call_update {toolCallId:tool_use_id, status:'completed'}", () => {
  const notifs = resultFor({ type: "tool_result", tool_use_id: "toolu_OK", content: "file contents" });
  assert.equal(notifs.length, 1);
  const u = notifs[0].update;
  assert.equal(u.sessionUpdate, "tool_call_update");
  assert.equal(u.toolCallId, "toolu_OK", "update keyed by tool_use_id verbatim");
  assert.equal(u.status, "completed");
});

test("tool_result(is_error:true) → status 'failed'", () => {
  const notifs = resultFor({
    type: "tool_result",
    tool_use_id: "toolu_ERR",
    content: "boom",
    is_error: true,
  });
  assert.equal(notifs[0].update.status, "failed");
});

test("tool_result(is_error:null) → treated as NOT an error → status 'completed' (NOT failed)", () => {
  const notifs = resultFor({
    type: "tool_result",
    tool_use_id: "toolu_NULL",
    content: "ok",
    is_error: null,
  });
  assert.equal(
    notifs[0].update.status,
    "completed",
    "is_error===null is not-error per §7 → completed",
  );
});

test("tool_result string content → carried through without throwing", () => {
  let notifs: any;
  assert.doesNotThrow(() => {
    notifs = resultFor({ type: "tool_result", tool_use_id: "toolu_STR", content: "plain string output" });
  });
  assert.equal(
    notifs[0].update.rawOutput,
    "plain string output",
    "raw string content carried verbatim (no array shape assumed)",
  );
});

test("tool_result array content incl. tool_reference sub-block → carried, neither dropped nor thrown", () => {
  const content = [
    { type: "text", text: "ok" },
    { type: "tool_reference", tool_name: "Read" },
  ];
  let notifs: any;
  assert.doesNotThrow(() => {
    notifs = resultFor(
      { type: "tool_result", tool_use_id: "toolu_ARR", content },
      // a non-Read/Bash tool_use → toolUpdateFromToolResult's default arm (toAcpContentUpdate),
      // which maps the array element-by-element incl. the tool_reference case.
      { type: "tool_use", id: "toolu_ARR", name: "Glob", input: { pattern: "*" } },
    );
  });
  const u = notifs[0].update;
  assert.deepEqual(u.rawOutput, content, "array content (with tool_reference) carried verbatim as rawOutput");
  assert.ok(
    Array.isArray(u.content) && u.content.length === 2,
    "the tool_reference sub-block is mapped through, not dropped",
  );
});
