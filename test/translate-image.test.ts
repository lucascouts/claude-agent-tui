// Story 020 / Task 1.1 — route an `image` content block through the REUSED, unmodified
// `toAcpNotifications` and lock the §7 image variant: an `image` block
// `{source:{type:'base64',media_type,data}}` → exactly one ACP `content {type:'image',mimeType,data}`,
// mapping `source.media_type`→`mimeType` and `source.data`→`data`.
//
// REGRESSION GUARD over already-delivered runtime: the §7 translator (`toAcpNotifications`,
// story 011) is kept byte-for-byte; this story only WIRES the seam and asserts (R1.4 — NO translator
// source change). The composition mirrors the Degrau-1 read path: a typed JSONL event →
// `classifyEvent` (story 016 — §6 content normalisation, array-OR-string) → the unmodified translator.
//
// node:test runner: `node --experimental-strip-types --test test/translate-image.test.ts`
// (run `npm run build` first — the behavioral imports resolve against ../dist).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { classifyEvent } from "../dist/event-switch.js";
import { toAcpNotifications } from "../dist/lib.js";

// On the image arm `toAcpNotifications` never touches (client, logger, toolUseCache) — only tool_use
// registers hooks / calls the client — so minimal stubs suffice (§7 reuse, decision 4 read-only:
// no ACP-side input is fed into the translator).
const logger = { log() {}, error() {} } as any;
const client = {} as any;
const here = dirname(fileURLToPath(import.meta.url));
const forkRoot = join(here, "..");

/** Compose the Degrau-1 read seam exactly as production would: event → classifyEvent → translator. */
function translate(event: unknown) {
  const c: any = classifyEvent(event as any);
  return toAcpNotifications(c.content, c.role, "sess-020", {}, client, logger);
}

// A user-attached image is the natural source for a base64 block; the arm is role-generic, so the
// emitted `content` shape is identical for either role (only the chunk discriminator differs).
const B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC";

test("image(base64): one block → one content {type:'image',mimeType,data} via the unmodified translator", () => {
  const notifs: any = translate({
    uuid: "img1",
    type: "user",
    userType: "external",
    message: {
      role: "user",
      content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: B64 } }],
    },
  });

  assert.equal(notifs.length, 1, "exactly one chunk per image block");
  const content = notifs[0].update.content;
  // §7 image variant: discriminator + the two base64-sourced fields.
  assert.equal(content.type, "image", "emitted content must be the `image` variant");
  // R1.1 — `source.media_type` is mapped onto `mimeType` (NOT carried as `media_type`).
  assert.equal(content.mimeType, "image/png", "source.media_type must be mapped onto mimeType");
  // R1.1 — `source.data` (the base64 payload) is mapped onto `data` verbatim.
  assert.equal(content.data, B64, "source.data base64 must be mapped onto data, byte-for-byte");
});

test("image(base64): NEGATIVE — no literal `media_type` key, and the base64 routes to `data` (not `source`)", () => {
  const notifs: any = translate({
    uuid: "img2",
    type: "user",
    userType: "external",
    message: {
      role: "user",
      content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: B64 } }],
    },
  });

  const content = notifs[0].update.content;
  // The mapping is a RENAME, not a passthrough: the emitted content must NOT echo the JSONL
  // `source.media_type` key, and must NOT nest the `source` envelope.
  assert.ok(!("media_type" in content), "emitted content must not carry a literal `media_type` key");
  assert.ok(!("source" in content), "emitted content must not echo the JSONL `source` envelope");
  // And the rename actually landed: the value lives under `mimeType` / `data`.
  assert.equal(content.mimeType, "image/jpeg", "media_type→mimeType rename must land");
  assert.equal(content.data, B64, "source.data→data must land");
});

test("image(base64): the emitted variant flattens the SessionUpdate; `uri` is undefined for base64", () => {
  // Documented runtime reality (src/acp-agent.ts image arm): the §7 arm is SHARED with the `url`
  // source variant, so for a base64 source the kept translator emits `uri: undefined` (the KEY is
  // present, its value undefined). A bare deepEqual against {type,data,mimeType} would therefore
  // fail under node's strict equality — so we pin the contract field-by-field instead.
  const notifs: any = translate({
    uuid: "img3",
    type: "user",
    userType: "external",
    message: {
      role: "user",
      content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: B64 } }],
    },
  });

  const update = notifs[0].update;
  // FLAT SessionUpdate — discriminator + payload on the same object, no nested `update` wrapper.
  assert.equal(update.sessionUpdate, "user_message_chunk", "user-attached image → user_message_chunk");
  assert.ok("content" in update, "payload (content) is flattened onto the same object");
  assert.ok(!("update" in update), "no nested `update` wrapper inside the SessionUpdate");
  // For a base64 source there is no URI — the shared arm leaves it undefined.
  assert.equal(update.content.uri, undefined, "base64 source carries no uri (shared url/base64 arm)");
});

test("the translator is REUSED unmodified (no local re-implementation; image arm maps media_type→mimeType)", () => {
  // The behavioral import is the upstream public export — a real function, not a local stand-in.
  assert.equal(typeof toAcpNotifications, "function", "toAcpNotifications must be the reused lib export");
  // R1.4 — this story authors NO production translator: its own test must not re-declare one.
  const self = readFileSync(join(here, "translate-image.test.ts"), "utf8");
  assert.ok(
    !/function\s+toAcpNotifications\b/.test(self),
    "the story must not re-implement the translator locally",
  );
  // And the kept §7 image arm still maps `source.media_type`→`mimeType` (reuse intact). We anchor on
  // the base64 mapping expression specifically — a bare `media_type` grep would also match the
  // unrelated INBOUND arm (acp-agent.ts:2830, `media_type: chunk.mimeType`).
  const src = readFileSync(join(forkRoot, "src", "acp-agent.ts"), "utf8");
  assert.ok(
    /mimeType:\s*chunk\.source\.type === "base64" \? chunk\.source\.media_type/.test(src),
    "the reused translator must still map source.media_type onto mimeType for base64",
  );
});
