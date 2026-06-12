// Story 019 / Task 1.2 — a `tool_use` id already emitted as a `tool_call` must route to a
// `tool_call_update` (keyed by the same `toolCallId`), NEVER a second `tool_call`. The seen-id
// distinction lives in the shared `toolUseCache`, so the two calls share one cache object.
//
// REGRESSION GUARD over already-delivered runtime: the §7 translator (`toAcpNotifications` +
// `tools.ts`, story 011) is kept byte-for-byte; this story only WIRES the seam and asserts.
// Seam: typed JSONL event → `classifyEvent` (story 016) → the unmodified translator. No src change.
//
// DRIFT NOTE (§7 doc vs reused runtime) — user-confirmed policy: lock the REAL runtime, record the
// drift, do NOT patch the byte-for-byte translator (story 019 Constraints / R2.2):
//   • repeat payload — IMPLEMENTACAO-FORK-ACP.md §7 / tasks.md R2.2 spec "only the changed fields"
//     ("a no-change repeat asserts an empty/minimal update body"). The reused `toAcpNotifications`
//     does NO field-diff: the `alreadyCached` arm (acp-agent.ts) re-emits the FULL `toolInfoFromToolUse`
//     output (kind/title/locations/…) plus `rawInput`. The tests below pin that real, full re-emit.
//
// node:test runner: `node --experimental-strip-types --test test/translate-tool-call-repeat.test.ts`
// (run `npm run build` first — the behavioral imports resolve against ../dist).
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyEvent } from "../dist/event-switch.js";
import { toAcpNotifications } from "../dist/lib.js";

const logger = { log() {}, error() {} } as any;
const client = {} as any;

/** Seam compose. The cache is passed IN so the second call sees the first's id (the repeat path). */
function translate(event: unknown, cache: any) {
  const c: any = classifyEvent(event as any);
  return toAcpNotifications(c.content, c.role, "sess-019", cache, client, logger, {
    registerHooks: false,
  });
}

/** A fresh assistant event carrying one tool_use block — distinct event objects, one shared id. */
function assistantToolUse(uuid: string, block: unknown) {
  return { uuid, type: "assistant", userType: "external", message: { role: "assistant", content: [block] } };
}

const readBlock = () => ({
  type: "tool_use",
  id: "toolu_REPEAT",
  name: "Read",
  input: { file_path: "/a.ts" },
});

test("repeated tool_use id → first a tool_call, second a tool_call_update (same id, NOT a 2nd tool_call)", () => {
  const cache = {};
  const first: any = translate(assistantToolUse("r1", readBlock()), cache);
  const second: any = translate(assistantToolUse("r2", readBlock()), cache);

  assert.equal(first.length, 1);
  assert.equal(first[0].update.sessionUpdate, "tool_call", "first encounter of the id is a tool_call");

  assert.equal(second.length, 1, "the repeat emits a single notification, not a duplicate tool_call");
  assert.equal(
    second[0].update.sessionUpdate,
    "tool_call_update",
    "a repeated id routes to tool_call_update, never a second tool_call",
  );
  assert.equal(
    second[0].update.toolCallId,
    "toolu_REPEAT",
    "the update is keyed by the same toolCallId as the first-seen tool_call",
  );
});

test("repeat update re-emits the FULL toolInfo + rawInput (DRIFT vs §7 'only changed fields')", () => {
  const cache = {};
  // Identical blocks both times → a genuine no-change repeat. §7 would want an empty/minimal body;
  // the reused translator instead re-emits the whole toolInfo. We lock the runtime, not the §7 wording.
  translate(assistantToolUse("f1", readBlock()), cache);
  const second: any = translate(assistantToolUse("f2", readBlock()), cache);
  const u = second[0].update;

  assert.equal(u.kind, "read", "kind re-emitted on the update (not diffed away)");
  assert.deepEqual(u.rawInput, { file_path: "/a.ts" }, "rawInput re-emitted on the update");
  assert.ok(
    !("status" in u),
    "the repeat update carries no `status` — only the first-seen tool_call sets status",
  );
});
