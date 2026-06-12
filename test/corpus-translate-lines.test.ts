// Story 036 / Task 3.1 (R4.1, R4.2, R4.3) — per-line JSONL→update assertions, sidechain
// linearization vs the story-017 reference transcript, and content string/array equivalence.
//
// Drives each corpus line through the REUSED Degrau-1 read seam (event → classifyEvent → the
// unmodified toAcpNotifications) and asserts it maps to the expected session/update for its
// event/block type (R4.1). Asserts the sidechain parentUuid graph linearizes (via the shared
// readOrderedTurns seam) to the recorded story-017 reference (R4.2). Asserts the content-as-string
// and content-as-array user fixtures yield EQUIVALENT updates (R4.3). Any line the translator does
// not accept is recorded as a drift note — the translator is NEVER patched (consolidation-only).
//
// node:test runner: `node --experimental-strip-types --test test/corpus-translate-lines.test.ts`
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classifyEvent } from "../dist/event-switch.js";
import { toAcpNotifications } from "../dist/lib.js";
import { readOrderedTurns } from "../dist/linearize.js";

const logger = { log() {}, error() {} } as any;
const client = {} as any;

function loadJsonl(url: URL): Array<Record<string, unknown>> {
  return readFileSync(url, "utf8")
    .trim()
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

const CORPUS = loadJsonl(new URL("./fixtures/corpus-all-types.jsonl", import.meta.url));

/** Translate ONE event through the shared cache (so tool_result finds its primed tool_use). */
function translate(event: Record<string, unknown>, cache: Record<string, unknown>) {
  const c: any = classifyEvent(event as any, { onDrift: () => {} });
  if (c.class !== "content") return { class: c.class, notifs: [] as any[] };
  const notifs = toAcpNotifications(c.content, c.role, "sess-corpus", cache, client, logger, {
    registerHooks: false,
  }) as any[];
  return { class: c.class, notifs };
}

/**
 * The §7 EXPECTED first-update discriminator per corpus uuid (R4.1). Lifecycle/metadata events map to
 * NO update (the translator never sees them); only content events produce session/update notifications.
 */
const EXPECTED_FIRST_UPDATE: Record<string, string | null> = {
  // lifecycle / metadata — no session/update
  "c-sys": null,
  "c-started": null,
  "c-mode": null,
  "c-permmode": null,
  "c-fhs": null,
  "c-attach": null,
  "c-queue": null,
  "c-lastprompt": null,
  "c-aititle": null,
  "c-prlink": null,
  "c-agentname": null,
  "c-result": null,
  "c-summary": null,
  // content events — each block's §7 update
  "c-user-text": "user_message_chunk", // text(user)
  "c-user-strcontent": "user_message_chunk", // string content normalised → text(user)
  "c-asst-thinking": "agent_thought_chunk", // thinking
  "c-asst-text": "agent_message_chunk", // text(assistant)
  "c-asst-tooluse": "tool_call", // tool_use first-seen
  "c-toolresult": "tool_call_update", // tool_result (primed below)
  "c-image": "user_message_chunk", // image(user) → user_message_chunk (the chunk discriminator follows the role)
  "c-asst-agent": "agent_message_chunk", // text + Task tool_use (first notif is the text)
  "c-side1": "agent_message_chunk", // sidechain text
  "c-side-result": "tool_call_update", // sidechain tool_result
  "c-asst-final": "agent_message_chunk", // final text
};

// === R4.1 — each corpus line maps to its expected session/update (or none, for lifecycle) =======

test("per-line: each corpus event maps to its expected first session/update discriminator (R4.1)", () => {
  // ONE shared cache primes tool_use ids so the tool_result lines resolve (production order).
  const cache: Record<string, unknown> = {};
  const driftNotes: string[] = [];

  for (const event of CORPUS) {
    const uuid = String(event.uuid);
    const expected = EXPECTED_FIRST_UPDATE[uuid];
    assert.ok(
      Object.prototype.hasOwnProperty.call(EXPECTED_FIRST_UPDATE, uuid),
      `corpus line ${uuid} has no expected mapping — add one`,
    );
    const { class: cls, notifs } = translate(event, cache);

    if (expected === null) {
      assert.notEqual(cls, "content", `${uuid} (${event.type}) is lifecycle/metadata — must NOT be a content event`);
      continue;
    }
    if (cls !== "content") {
      // a content line the translator declined → drift note, never a patch (consolidation-only).
      driftNotes.push(`${uuid}: expected content→${expected} but classifyEvent returned ${cls}`);
      continue;
    }
    assert.ok(notifs.length >= 1, `${uuid} (${event.type}) must produce >=1 session/update`);
    assert.equal(
      notifs[0].update.sessionUpdate,
      expected,
      `${uuid} first update must be ${expected}, got ${notifs[0].update.sessionUpdate}`,
    );
  }

  // Consolidation-only: drift is RECORDED (and surfaces as a clear failure), never silently patched.
  assert.deepEqual(driftNotes, [], `translator drift notes (NOT patched): ${driftNotes.join("; ")}`);
});

test("per-line: the image block routes to an image content update via the unmodified translator (R4.1)", () => {
  const cache: Record<string, unknown> = {};
  const image = CORPUS.find((e) => e.uuid === "c-image")!;
  const { notifs } = translate(image, cache);
  assert.equal(notifs.length, 1, "one chunk per image block");
  assert.equal(notifs[0].update.content.type, "image", "image block → content {type:'image'}");
  assert.equal(notifs[0].update.content.mimeType, "image/png", "source.media_type → mimeType");
});

test("per-line: the first-seen tool_use maps to a tool_call keyed by tool_use.id verbatim (R4.1)", () => {
  const cache: Record<string, unknown> = {};
  const toolUse = CORPUS.find((e) => e.uuid === "c-asst-tooluse")!;
  const { notifs } = translate(toolUse, cache);
  assert.equal(notifs[0].update.sessionUpdate, "tool_call");
  assert.equal(notifs[0].update.toolCallId, "toolu_read_1", "toolCallId reuses tool_use.id");
  assert.equal(notifs[0].update.kind, "read", "kind resolved via the upstream tools.ts map");
});

// === R4.2 — the sidechain parentUuid graph linearizes to the story-017 reference ================

test("the story-017 reference transcript linearizes to its recorded expected order (R4.2)", async () => {
  // The story-017 reference lives at fork/fixtures/ (the linearization owner's authoritative location).
  const refUrl = new URL("../fixtures/lin-task-sidechain.jsonl", import.meta.url);
  const expUrl = new URL("../fixtures/lin-task-sidechain.expected.json", import.meta.url);
  const messages = loadJsonl(refUrl);
  const expected = JSON.parse(readFileSync(expUrl, "utf8"));

  const turns = await readOrderedTurns("sess-ref", "/proj", { getMessages: () => messages });
  const projected = turns.map((t: any) => ({
    orderKey: t.orderKey,
    uuid: t.uuid,
    role: t.role,
    nested: (t.nested ?? []).map((m: any) => m.uuid),
  }));
  assert.deepEqual(projected, expected, "reference transcript must linearize to the recorded expected order");
});

test("the corpus sidechain branch nests under its spawning turn through the same readOrderedTurns seam (R4.2)", async () => {
  const turns = await readOrderedTurns("sess-corpus", "/proj", { getMessages: () => CORPUS });
  // the sidechain row c-side1 must NOT appear as a top-level rendered turn — it nests on its parent.
  const topLevelUuids = turns.map((t: any) => t.uuid);
  assert.ok(!topLevelUuids.includes("c-side1"), "sidechain c-side1 must not be a top-level turn (it nests)");
  // it must appear nested under the assistant turn that spawned the Task tool_use (c-asst-agent).
  const spawningTurn = turns.find((t: any) => t.uuid === "c-asst-agent");
  assert.ok(spawningTurn, "the Task-spawning assistant turn is present");
  const nestedUuids = (spawningTurn!.nested ?? []).map((m: any) => m.uuid);
  assert.ok(nestedUuids.includes("c-side1"), "c-side1 nests under its spawning turn c-asst-agent");
});

// === R4.3 — content-as-string and content-as-array yield equivalent session/update ==============

test("content-string and content-array user fixtures yield EQUIVALENT session/update output (R4.3)", () => {
  const arrayEvent = CORPUS.find((e) => e.uuid === "c-user-text")!; // content: [{type:'text',text}]
  const stringEvent = CORPUS.find((e) => e.uuid === "c-user-strcontent")!; // content: "<same text>"
  const fromArray = translate(arrayEvent, {}).notifs;
  const fromString = translate(stringEvent, {}).notifs;

  // both shapes must produce the SAME normalised update (the §6 string→[{text}] normalisation).
  assert.equal(fromArray.length, fromString.length, "string and array shapes emit the same number of updates");
  assert.deepEqual(
    fromString.map((n: any) => ({ kind: n.update.sessionUpdate, content: n.update.content })),
    fromArray.map((n: any) => ({ kind: n.update.sessionUpdate, content: n.update.content })),
    "string-content and array-content normalise to equivalent updates",
  );
});
