// Story 019 / Task 1.1 — route a first-seen `tool_use` id through the REUSED, unmodified
// `toAcpNotifications` + `tools.ts` (`toolInfoFromToolUse`) and lock the §7 first-use variant:
// an unseen id → exactly one `tool_call` whose `toolCallId` reuses `tool_use.id` (`toolu_…`)
// verbatim, with `rawInput` = the block's `input` and the `kind`/`locations` from the upstream map.
//
// REGRESSION GUARD over already-delivered runtime: the §7 translator (`toAcpNotifications` +
// `tools.ts`, story 011) is kept byte-for-byte; this story only WIRES the seam and asserts.
// Seam, mirroring the Degrau-1 read path: typed JSONL event → `classifyEvent` (story 016, §6
// content normalisation) → the unmodified translator. No translator source is changed.
//
// DRIFT NOTE (§7 doc vs reused runtime) — user-confirmed policy: lock the REAL runtime and record
// the drift, do NOT patch the byte-for-byte translator (story 019 Constraints / R1.1):
//   • first-seen status — IMPLEMENTACAO-FORK-ACP.md §7 / tasks.md R1.1 spec `status:'in_progress'`;
//     the reused `toAcpNotifications` emits `status:'pending'` on first encounter (acp-agent.ts, the
//     `!alreadyCached` arm). The test below pins the runtime's `'pending'`, not the §7 wording.
//
// node:test runner: `node --experimental-strip-types --test test/translate-tool-call-first.test.ts`
// (run `npm run build` first — the behavioral imports resolve against ../dist).
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyEvent } from "../dist/event-switch.js";
import { toAcpNotifications } from "../dist/lib.js";

// Only the tool_use arm touches the cache/client; minimal stubs suffice (read-only, decision 4).
const logger = { log() {}, error() {} } as any;
const client = {} as any;

/**
 * Compose the Degrau-1 read seam exactly as production would: event → classifyEvent → translator.
 * `toolUseCache` is passed IN so seen-id state survives across calls (the first/repeat distinction
 * in 1.2/1.3); `registerHooks:false` keeps the unit synchronous — the PostToolUse hook (which needs a
 * live client) is irrelevant to the synchronous `tool_call` notification this story asserts.
 */
function translate(event: unknown, cache: any) {
  const c: any = classifyEvent(event as any);
  return toAcpNotifications(c.content, c.role, "sess-019", cache, client, logger, {
    registerHooks: false,
  });
}

function assistantToolUse(block: unknown) {
  return {
    uuid: "e1",
    type: "assistant",
    userType: "external",
    message: { role: "assistant", content: [block] },
  };
}

test("first-seen tool_use(Read) → exactly one tool_call; toolCallId === id verbatim; kind 'read'", () => {
  const cache = {};
  const notifs: any = translate(
    assistantToolUse({
      type: "tool_use",
      id: "toolu_01ABCdef",
      name: "Read",
      input: { file_path: "/repo/src/x.ts", offset: 10 },
    }),
    cache,
  );

  assert.equal(notifs.length, 1, "an unseen tool_use id emits exactly one tool_call");
  const u = notifs[0].update;
  assert.equal(u.sessionUpdate, "tool_call");
  assert.equal(
    u.toolCallId,
    "toolu_01ABCdef",
    "toolCallId reuses tool_use.id byte-for-byte (never minted)",
  );
  assert.equal(u.kind, "read", "kind resolved via the upstream tools.ts map (no local re-impl)");
  assert.deepEqual(
    u.rawInput,
    { file_path: "/repo/src/x.ts", offset: 10 },
    "rawInput === tool_use.input",
  );
});

test("first-seen status: reused translator emits 'pending' (DRIFT vs §7 'in_progress')", () => {
  const cache = {};
  const notifs: any = translate(
    assistantToolUse({ type: "tool_use", id: "toolu_S", name: "Read", input: { file_path: "/a" } }),
    cache,
  );
  // The byte-for-byte translator is NOT edited to satisfy §7; the test locks its REAL output.
  assert.equal(notifs[0].update.status, "pending");
});

test("first-seen carries `locations` from toolInfoFromToolUse (Read → [{path, line:offset}])", () => {
  const cache = {};
  const notifs: any = translate(
    assistantToolUse({
      type: "tool_use",
      id: "toolu_L",
      name: "Read",
      input: { file_path: "/repo/a.ts", offset: 42 },
    }),
    cache,
  );
  assert.deepEqual(notifs[0].update.locations, [{ path: "/repo/a.ts", line: 42 }]);
});
