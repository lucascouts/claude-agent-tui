// Story 017 / Task 1.1 — Read ordered messages via getSessionMessages (REUSE-live).
//
// `readOrderedMessages` is the thin SOURCE wrapper: it calls the injected `getSessionMessages`
// seam and returns its `SessionMessage[]` in the SAME chronological order the SDK produced — it
// performs NO reordering and NO file I/O of its own (the mock proves both). If the SDK call throws
// (binary/version drift), the wrapper surfaces the error WITH the resolved sessionId/dir rather than
// silently returning [].
//
// RECONCILIATION NOTE (orchestrator decision, Option 1): the real `getSessionMessages` return is the
// reduced shape { type, uuid, session_id, message, parent_tool_use_id } (story 015, jsonl.ts:467) —
// it already builds the parentUuid chain INTERNALLY and returns only the filtered main chain in
// chronological order (E5: "4 main-chain messages", sidechain/meta filtered). So this wrapper's whole
// job is to adopt that order verbatim.
//
// node:test runner: `node --experimental-strip-types --test test/lin-source.test.ts`
// (run `npm run build` first — the behavioral import resolves against ../dist).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readOrderedMessages } from "../dist/linearize.js";

/** A reduced-shape SDK SessionMessage, exactly as `getSessionMessages` returns it. */
function sm(type: string, uuid: string, parentToolUseId: string | null = null) {
  return { type, uuid, session_id: "sess", message: { content: [] }, parent_tool_use_id: parentToolUseId };
}

test("readOrderedMessages preserves SDK chronological order with no reordering", async () => {
  const fixture = [sm("user", "u1"), sm("assistant", "a1"), sm("user", "u2"), sm("assistant", "a2")];
  let calledWith: { sessionId: string; opts?: { dir?: string } } | undefined;
  const getMessages = (sessionId: string, opts?: { dir?: string }) => {
    calledWith = { sessionId, opts };
    return fixture;
  };

  const out = await readOrderedMessages("sess-id", "/run/dir", { getMessages });

  // Same order, same elements — the wrapper neither reorders nor drops.
  assert.deepEqual(
    out.map((m) => m.uuid),
    ["u1", "a1", "u2", "a2"],
  );
  assert.deepEqual(out, fixture);
  // It delegated to the seam (no file I/O of its own) and forwarded sessionId + { dir }.
  assert.equal(calledWith?.sessionId, "sess-id");
  assert.deepEqual(calledWith?.opts, { dir: "/run/dir" });
});

test("readOrderedMessages surfaces SDK errors with sessionId/dir context (no silent [])", async () => {
  const getMessages = () => {
    throw new Error("binary version drift");
  };
  await assert.rejects(
    () => readOrderedMessages("sess-id", "/run/dir", { getMessages }),
    /sessionId="sess-id"[\s\S]*dir="\/run\/dir"[\s\S]*binary version drift/,
  );
});

test("readOrderedMessages awaits an async seam (real SDK is async)", async () => {
  const fixture = [sm("user", "u1")];
  const getMessages = async () => fixture;
  const out = await readOrderedMessages("sess-id", undefined, { getMessages });
  assert.deepEqual(out, fixture);
});
