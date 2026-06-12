// Story 030 / Task 1.3 — image/audio/blob ignored + malformed-block skip.
// image/audio/blob-resource emit no PTY bytes and never throw (R4.1). A malformed/unknown block
// is SKIPPED and RECORDED via the engine logger while the remaining valid blocks still map — one
// bad block never aborts the whole prompt (R1.3). The malformed fixture `{type:"resource"}` (no
// `.resource`) currently makes the `"text" in chunk.resource` check throw, aborting the prompt —
// that is the behavior gap this sub-task closes.
// node:test runner: `node --experimental-strip-types --test test/prompt-ignored-media.test.ts`
// (run `npm run build` first — the behavioral import resolves against ../dist)
import { test } from "node:test";
import assert from "node:assert/strict";
import { promptToClaude } from "../dist/acp-agent.js";

const req = (...blocks: any[]) => ({ sessionId: "s-030", prompt: blocks }) as any;

/** Fake Logger ({log,error}) recording every skip record. */
function fakeLogger() {
  const records: string[] = [];
  const sink = (...a: any[]) => { records.push(a.map(String).join(" ")); };
  return { log: sink, error: sink, records };
}

const image = { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" };
const audio = { type: "audio", data: "QQ==", mimeType: "audio/wav" };
const blobResource = {
  type: "resource",
  resource: { uri: "file:///p/x.bin", blob: "QUJD", mimeType: "application/octet-stream" },
};

test("R4.1 — an image block emits no PTY bytes and does not throw", () => {
  const out = promptToClaude(req(image));
  assert.equal(out, "", "image block contributes nothing to the payload");
});

test("R4.1 — an audio block emits no PTY bytes and does not throw", () => {
  const out = promptToClaude(req(audio));
  assert.equal(out, "", "audio block contributes nothing to the payload");
});

test("R4.1 — a blob (binary) embedded resource emits no PTY bytes and does not throw", () => {
  const out = promptToClaude(req(blobResource));
  assert.equal(out, "", "blob resource contributes nothing to the payload");
});

test("R4.1 — a media-only prompt assembles to an empty payload (no stray bytes)", () => {
  const out = promptToClaude(req(image, audio, blobResource));
  assert.equal(out, "", "a prompt made only of ignored media yields an empty payload");
});

test("R1.3 — a block whose mapping throws is isolated (skipped + recorded); valid blocks still map", () => {
  const logger = fakeLogger();
  // A block that throws when its `type` is read: mapping it aborts the WHOLE prompt unless each
  // block is isolated. Forces per-block try/catch + recording (R1.3), not just a silent no-op.
  const evil: any = { get type() { throw new Error("boom"); } };
  const out = promptToClaude(req({ type: "text", text: "keep me" }, evil), logger);
  assert.ok(out.includes("keep me"), "a valid block still maps despite a throwing sibling (no abort)");
  assert.ok(logger.records.length > 0, "the skipped block was recorded via the logger");
});
