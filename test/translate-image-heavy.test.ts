// Story 020 / Task 1.2 — lazy-load/skip heavy image base64 WITHOUT carrying it twice, while the
// surrounding content + universal fields survive the streaming translation (R1.2, R1.3).
//
// ARCHITECTURAL NOTE (the reason no translator source changes): the heavy-image skip is NOT in the
// §7 translator (`toAcpNotifications`, story 011) — that arm carries whatever `source.data` it is
// handed. The skip lives UPSTREAM, in story 015's projection: `projectEvent` (src/jsonl.ts) DEFAULTS
// to calling `stripHeavyImages`, which replaces a heavy `image` block's base64 `source.data` with an
// empty marker (`data:""`, `skipped:true`, `bytes:<original utf8 length>`) BEFORE the translator ever
// sees it. Because the strip is composed once, upstream, the ~630 KB payload is never eagerly carried
// twice (consistent with the watcher's lazy-skip). This test therefore COMPOSES the already-shipped
// runtime — it authors/modifies NOTHING under src/ — and is a REGRESSION GUARD expected to pass on
// first run: a real failure here means stories 011/015 regressed, not that this test needs patching.
//
// Seam (production read path): raw getSessionMessages message → `projectEvent` (story 015 strips heavy
// images) → `classifyEvent` (story 016 — §6 content normalisation) → `toAcpNotifications` (story 011,
// unchanged). Mirrors translate-image.test.ts / translate-shape.test.ts; the projectEvent import
// mirrors watcher-fields.test.ts.
//
// node:test runner (NOT vitest): `node --experimental-strip-types --test test/translate-image-heavy.test.ts`
// (run `npm run build` first — the behavioral imports resolve against ../dist).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { projectEvent, DEFAULT_IMAGE_SKIP_BYTES } from "../dist/jsonl.js";
import { classifyEvent } from "../dist/event-switch.js";
import { toAcpNotifications } from "../dist/lib.js";

// On the image/text arms `toAcpNotifications` never touches (client, logger, toolUseCache) — only the
// tool_use arm calls the client / registers hooks — so minimal stubs suffice (read-only reuse).
const logger = { log() {}, error() {} } as any;
const client = {} as any;
const here = dirname(fileURLToPath(import.meta.url));

/** A heavy base64 payload, comfortably over the ~64 KB default threshold (~630 KB/PNG in production). */
const HEAVY_DATA = "A".repeat(70 * 1024);
/** A small inline image payload, well under the default ~64 KB threshold. */
const SMALL_DATA = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC";

/** A real getSessionMessages-shaped event: a heavy `image` block PLUS an adjacent `text` caption. */
function rawHeavyImageEvent() {
  return {
    uuid: "img-heavy-1",
    type: "user",
    timestamp: "2026-06-04T12:00:00.000Z",
    session_id: "sess-020",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [
        { type: "text", text: "caption" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: HEAVY_DATA } },
      ],
    },
  };
}

/** A getSessionMessages-shaped event carrying a SMALL inline image (kept inline by the projection). */
function rawSmallImageEvent() {
  return {
    uuid: "img-small-1",
    type: "user",
    timestamp: "2026-06-04T12:00:01.000Z",
    session_id: "sess-020",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: SMALL_DATA } }],
    },
  };
}

/** Compose the Degrau-1 read seam exactly as production would: raw → project (strip) → classify → translate. */
function translateRaw(rawMessage: unknown) {
  const event: any = projectEvent(rawMessage);
  const c: any = classifyEvent(event);
  return { event, notifs: toAcpNotifications(c.content, c.role, "sess-020", {}, client, logger) };
}

test("projection strips the heavy image payload (R1.2): data emptied, skip marker + size hint, media_type kept", () => {
  const event: any = projectEvent(rawHeavyImageEvent());
  const content = event.message.content as Array<any>;
  assert.equal(content.length, 2, "both blocks preserved through the strip");

  const image = content[1];
  // The ~630 KB-class payload is NOT carried inline — it is replaced by the empty skip marker.
  assert.notEqual(image.source.data, HEAVY_DATA, "heavy base64 payload must NOT be carried inline");
  assert.equal(image.source.data, "", "skipped data replaced by the empty marker");
  assert.equal(image.source.skipped, true, "skip marker present");
  assert.ok(
    image.source.bytes > DEFAULT_IMAGE_SKIP_BYTES,
    "byte-size hint exceeds the default skip threshold",
  );
  assert.equal(image.source.bytes, Buffer.byteLength(HEAVY_DATA, "utf8"), "byte-size hint is the original utf8 length");
  // Structural fields stay so the block is still a representable image downstream.
  assert.equal(image.type, "image", "block type preserved");
  assert.equal(image.source.type, "base64", "source.type preserved");
  assert.equal(image.source.media_type, "image/png", "source.media_type preserved");
});

test("surrounding content + universal fields survive the skip (R1.3)", () => {
  const event: any = projectEvent(rawHeavyImageEvent());

  // The adjacent text block is untouched — the turn keeps its caption.
  const content = event.message.content as Array<any>;
  assert.deepEqual(content[0], { type: "text", text: "caption" }, "adjacent text block survives intact");

  // Universal fields survive so the turn is still representable/attributable downstream.
  assert.equal(event.uuid, "img-heavy-1", "universal field uuid survives the strip");
  assert.equal(event.sessionId, "sess-020", "universal field sessionId (from session_id) survives the strip");
  assert.equal(event.type, "user", "universal field type survives the strip");
  assert.equal(event.timestamp, "2026-06-04T12:00:00.000Z", "universal field timestamp survives the strip");
});

test("translation does NOT re-carry the heavy payload: text chunk + image content with empty data", () => {
  const { notifs } = translateRaw(rawHeavyImageEvent());
  assert.equal(notifs.length, 2, "one chunk per surviving block (text + image)");

  // The caption survives all the way to an emitted user_message_chunk.
  const text: any = notifs[0].update;
  assert.equal(text.sessionUpdate, "user_message_chunk", "text → user_message_chunk");
  assert.equal(text.content.type, "text");
  assert.equal(text.content.text, "caption", "the surrounding text content survives translation");

  // The image is still emitted as an image variant, but the heavy payload is gone (data === "").
  const image: any = notifs[1].update;
  assert.equal(image.content.type, "image", "image block still emits an image content variant");
  assert.equal(image.content.mimeType, "image/png", "mimeType still mapped from source.media_type");
  assert.equal(image.content.data, "", "translator emits empty data — the heavy payload is NOT re-carried");
  assert.notEqual(image.content.data, HEAVY_DATA, "the ~630 KB payload is never inlined into the notification");
});

test("a SMALL image is still emitted with its data intact (R1.2 boundary)", () => {
  // The projection keeps a sub-threshold image inline (no skip marker).
  const event: any = projectEvent(rawSmallImageEvent());
  const projectedImage = (event.message.content as Array<any>)[0];
  assert.equal(projectedImage.source.data, SMALL_DATA, "small image data kept inline by the projection");
  assert.equal(projectedImage.source.skipped, undefined, "small image not marked skipped");

  // And it translates to an image content with its data present.
  const { notifs } = translateRaw(rawSmallImageEvent());
  assert.equal(notifs.length, 1, "one chunk for the single small-image block");
  const image: any = notifs[0].update;
  assert.equal(image.content.type, "image");
  assert.equal(image.content.mimeType, "image/png", "small image mimeType mapped from source.media_type");
  assert.equal(image.content.data, SMALL_DATA, "small image data is emitted intact (byte-for-byte)");
});

test("reuse self-guard: the skip + translator are COMPOSED, not re-implemented locally", () => {
  // The behavioral imports are the upstream public exports — real functions, not local stand-ins.
  assert.equal(typeof projectEvent, "function", "projectEvent must be the reused jsonl export");
  assert.equal(typeof toAcpNotifications, "function", "toAcpNotifications must be the reused lib export");

  // This story authors NO production code: its own test must not re-declare the strip or the translator
  // (mirrors translate-shape.test.ts ~76-91 / translate-image.test.ts ~105-122).
  const self = readFileSync(join(here, "translate-image-heavy.test.ts"), "utf8");
  assert.ok(
    !/function\s+stripHeavyImages\b/.test(self),
    "the story must not re-implement the heavy-image strip locally",
  );
  assert.ok(
    !/function\s+toAcpNotifications\b/.test(self),
    "the story must not re-implement the translator locally",
  );
});
