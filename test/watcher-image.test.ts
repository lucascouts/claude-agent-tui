// Story 015 / Task 4.2 — lazy-load/skip heavy image base64 blocks to avoid backpressure.
//
// A typed event whose `message.content` array carries an `image` block with a heavy base64
// `source.data` (~630 KB/PNG) must have that payload SKIPPED so it does not back-pressure the
// streaming read, while PRESERVING the block's other props (type / source.type / source.media_type)
// + a size hint, and preserving all OTHER content blocks (e.g. text) and the universal fields
// (R7.1, R7.2). A small inline image stays. A raw-string content is left untouched.
// node:test runner: `node --experimental-strip-types --test test/watcher-image.test.ts`
// (run `npm run build` first — behavioral imports resolve against ../dist).
import { test } from "node:test";
import assert from "node:assert/strict";
import { projectEvent, stripHeavyImages, DEFAULT_IMAGE_SKIP_BYTES } from "../dist/jsonl.js";

/** A ~630 KB base64 payload (mirrors the heavy PNG the partial-append test uses). */
const HEAVY_DATA = "x".repeat(630 * 1024);
/** A small inline image payload (well under the default ~64 KB threshold). */
const SMALL_DATA = "y".repeat(128);

/** An event with a heavy image block AND a text block, in the empirical getSessionMessages shape. */
function eventWithHeavyImage() {
  return {
    uuid: "img-uuid-1",
    type: "user",
    timestamp: "2026-06-03T12:00:00.000Z",
    session_id: "sess-img",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [
        { type: "text", text: "see attached screenshot" },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: HEAVY_DATA },
        },
      ],
    },
  };
}

test("projectEvent: heavy image data is skipped; text block + universal fields survive (R7.1, R7.2)", () => {
  const event = projectEvent(eventWithHeavyImage());

  // Universal fields survive the strip.
  assert.equal(event.uuid, "img-uuid-1");
  assert.equal(event.type, "user");
  assert.equal(event.sessionId, "sess-img");
  assert.equal(event.userType, "external");

  const content = (event.message as { content: Array<Record<string, unknown>> }).content;
  assert.equal(content.length, 2, "both blocks preserved");

  // The text block is untouched.
  assert.deepEqual(content[0], { type: "text", text: "see attached screenshot" });

  // The image block: payload skipped, shape + size hint preserved.
  const image = content[1] as {
    type: string;
    source: { type: string; media_type: string; data: string; skipped?: boolean; bytes?: number };
  };
  assert.equal(image.type, "image"); // block type preserved
  assert.equal(image.source.type, "base64"); // source.type preserved
  assert.equal(image.source.media_type, "image/png"); // media_type preserved
  assert.notEqual(image.source.data, HEAVY_DATA, "heavy base64 payload must be dropped");
  assert.equal(image.source.data, "", "skipped data replaced by empty marker");
  assert.equal(image.source.skipped, true, "skip marker present");
  assert.equal(
    image.source.bytes,
    Buffer.byteLength(HEAVY_DATA, "utf8"),
    "byte-size hint preserved",
  );
});

test("stripHeavyImages: a SMALL inline image is kept inline (below threshold)", () => {
  const message = {
    role: "user",
    content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: SMALL_DATA } },
    ],
  };
  const out = stripHeavyImages(message) as {
    content: Array<{ source: { data: string; skipped?: boolean } }>;
  };
  assert.equal(out.content[0].source.data, SMALL_DATA, "small image kept inline");
  assert.equal(out.content[0].source.skipped, undefined, "small image not marked skipped");
});

test("stripHeavyImages: configurable threshold — Infinity keeps the heavy image inline", () => {
  const event = projectEvent(eventWithHeavyImage(), { imageSkipBytes: Infinity });
  const content = (event.message as { content: Array<Record<string, unknown>> }).content;
  const image = content[1] as { source: { data: string; skipped?: boolean } };
  assert.equal(image.source.data, HEAVY_DATA, "Infinity threshold keeps all image data inline");
  assert.equal(image.source.skipped, undefined);
});

test("stripHeavyImages: configurable threshold — a low threshold skips even a small image", () => {
  const message = {
    role: "user",
    content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: SMALL_DATA } },
    ],
  };
  const out = stripHeavyImages(message, 16) as {
    content: Array<{ source: { data: string; skipped?: boolean; bytes?: number } }>;
  };
  assert.equal(out.content[0].source.data, "");
  assert.equal(out.content[0].source.skipped, true);
  assert.equal(out.content[0].source.bytes, Buffer.byteLength(SMALL_DATA, "utf8"));
});

test("stripHeavyImages: raw STRING content is left untouched", () => {
  const message = { role: "assistant", content: "a plain string, not blocks" };
  const out = stripHeavyImages(message);
  assert.equal(out, message, "string content returns the same object reference");
});

test("stripHeavyImages: non-image blocks and non-base64 sources pass through unchanged", () => {
  const message = {
    role: "user",
    content: [
      { type: "text", text: "hi" },
      // image with a non-base64 source — left alone (only base64 source.data is a strip target).
      { type: "image", source: { type: "url", url: "https://example.com/a.png" } },
    ],
  };
  const out = stripHeavyImages(message);
  // Nothing heavy/base64 → original message returned untouched (same reference).
  assert.equal(out, message);
});

test("stripHeavyImages: does NOT mutate the input message/blocks in place", () => {
  const message = eventWithHeavyImage().message;
  const before = JSON.stringify(message);
  const out = stripHeavyImages(message);
  // Original heavy data still present on the INPUT (only the returned clone is stripped).
  assert.equal(JSON.stringify(message), before, "input not mutated");
  assert.notEqual(out, message, "a clone is returned when something was stripped");
});

test("DEFAULT_IMAGE_SKIP_BYTES is a sane ~64 KB default", () => {
  assert.equal(DEFAULT_IMAGE_SKIP_BYTES, 64 * 1024);
});
