// Story 058 / Task 1.1 — image-input materialize seam + promptToClaude image wiring.
//
// extFor maps mimeType → extension (.png/.jpg/.gif/.webp, else .img, tolerant of `;` params).
// materializeImage decodes base64 → a uuid-named temp file under os.tmpdir() and returns its path.
// promptToClaude turns each `image` block into `@<path>` + exactly ONE Read-inducing directive, and
// pushes each temp path into the optional `materializedSink`. audio + blob-resource make NO temp file.
// node:test runner: `node --experimental-strip-types --test test/image-input.test.ts`
// (run `npm run build` first — the behavioral imports resolve against ../dist)
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { extFor, materializeImage, MATERIALIZED_IMAGE_PREFIX } from "../dist/image-input.js";
import { promptToClaude } from "../dist/acp-agent.js";

const req = (...blocks: any[]) => ({ sessionId: "s-058", prompt: blocks }) as any;

/** rm every temp path a test collected, ignoring already-gone paths. */
function cleanup(paths: string[]) {
  for (const p of paths) rmSync(p, { force: true });
}

// Distinct byte payloads per format so we can assert exact decoded bytes round-trip to disk.
const PAYLOADS: Record<string, Buffer> = {
  png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // PNG signature
  jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), // JPEG SOI + APP0
  gif: Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]), // "GIF89a"
  webp: Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]), // RIFF…WEBP
};
const b64 = (b: Buffer) => b.toString("base64");

test("extFor maps known image mime types to extensions; everything else → .img", () => {
  assert.equal(extFor("image/png"), ".png");
  assert.equal(extFor("image/jpeg"), ".jpg");
  assert.equal(extFor("image/gif"), ".gif");
  assert.equal(extFor("image/webp"), ".webp");
  // unknown / missing / empty → .img
  assert.equal(extFor("image/bmp"), ".img");
  assert.equal(extFor("application/octet-stream"), ".img");
  assert.equal(extFor(undefined), ".img");
  assert.equal(extFor(null), ".img");
  assert.equal(extFor(""), ".img");
});

test("extFor tolerates `;`-parameterized and mixed-case mime types", () => {
  assert.equal(extFor("image/png; charset=binary"), ".png");
  assert.equal(extFor("IMAGE/JPEG"), ".jpg");
  assert.equal(extFor("image/webp ; q=1"), ".webp");
});

test("materializeImage writes correct decoded bytes + extension for png/jpeg/gif/webp", () => {
  const cases: Array<[string, string, Buffer]> = [
    ["image/png", ".png", PAYLOADS.png],
    ["image/jpeg", ".jpg", PAYLOADS.jpeg],
    ["image/gif", ".gif", PAYLOADS.gif],
    ["image/webp", ".webp", PAYLOADS.webp],
  ];
  const made: string[] = [];
  try {
    for (const [mime, ext, bytes] of cases) {
      const p = materializeImage(b64(bytes), mime);
      made.push(p);
      assert.ok(p.endsWith(ext), `${mime} → ${ext} (got ${p})`);
      assert.ok(p.includes(MATERIALIZED_IMAGE_PREFIX), "temp file uses the fork-acp-img- prefix");
      assert.ok(existsSync(p), "temp file exists on disk");
      assert.deepEqual(readFileSync(p), bytes, `${mime} bytes round-trip to disk intact`);
    }
  } finally {
    cleanup(made);
  }
});

test("materializeImage falls back to .img for unknown/missing mimeType", () => {
  const made: string[] = [];
  try {
    const a = materializeImage(b64(PAYLOADS.png), "image/bmp");
    const b = materializeImage(b64(PAYLOADS.png), undefined);
    const c = materializeImage(b64(PAYLOADS.png), null);
    made.push(a, b, c);
    for (const p of [a, b, c]) {
      assert.ok(p.endsWith(".img"), `unknown/missing mime → .img (got ${p})`);
      assert.ok(existsSync(p), "temp file exists on disk");
    }
  } finally {
    cleanup(made);
  }
});

test("materializeImage produces a unique path per call", () => {
  const made: string[] = [];
  try {
    const a = materializeImage(b64(PAYLOADS.png), "image/png");
    const b = materializeImage(b64(PAYLOADS.png), "image/png");
    made.push(a, b);
    assert.notEqual(a, b, "two materializations yield distinct temp paths");
  } finally {
    cleanup(made);
  }
});

test("R1.3 — materialized path is shell-safe (uuid basename; hostile mimeType can't inject)", () => {
  const made: string[] = [];
  try {
    // Even a mimeType laden with shell metacharacters yields a closed-set extension: extFor strips
    // `;`-params and matches a fixed table, so nothing user-supplied reaches the filename. And the
    // prompt is delivered via bracketed-paste (not `bash -lc`), so `@<path>` is never shell-parsed.
    const p = materializeImage(b64(PAYLOADS.png), 'image/png"; rm -rf / #');
    made.push(p);
    const base = p.slice(p.lastIndexOf("/") + 1);
    assert.match(base, /^fork-acp-img-[0-9a-f-]+\.\w+$/, `uuid-only basename (got ${base})`);
    assert.ok(!/["$`\\;&|<>(){}\s]/.test(base), "no shell-metacharacters in the materialized basename");
    // The `"` sits before the `;`, so the media token is `image/png"` — it does NOT match the fixed
    // table and falls back to the closed-set `.img`: nothing from the hostile mimeType reaches the name.
    assert.ok(base.endsWith(".img"), "an unmatched hostile mimeType falls back to the closed-set .img");
  } finally {
    cleanup(made);
  }
});

test("promptToClaude: one image → @<path> in output + ONE directive + sink receives the path", () => {
  const sink: string[] = [];
  try {
    const out = promptToClaude(req({ type: "image", data: b64(PAYLOADS.png), mimeType: "image/png" }), console, sink);
    assert.equal(sink.length, 1, "exactly one temp file materialized");
    assert.ok(existsSync(sink[0]), "the materialized file exists");
    assert.ok(out.includes(`@${sink[0]}`), "@<path> is in the payload");
    const directives = out.match(/Read the attached image/gi) ?? [];
    assert.equal(directives.length, 1, "exactly one Read-inducing directive");
  } finally {
    cleanup(sink);
  }
});

test("promptToClaude: TWO images → 2 temp files + 2 distinct @refs + exactly ONE directive", () => {
  const sink: string[] = [];
  try {
    const out = promptToClaude(
      req(
        { type: "image", data: b64(PAYLOADS.png), mimeType: "image/png" },
        { type: "image", data: b64(PAYLOADS.jpeg), mimeType: "image/jpeg" },
      ),
      console,
      sink,
    );
    assert.equal(sink.length, 2, "two temp files materialized");
    assert.notEqual(sink[0], sink[1], "the two temp paths are distinct");
    for (const p of sink) {
      assert.ok(existsSync(p), "each materialized file exists");
      assert.ok(out.includes(`@${p}`), `payload references ${p} by @<path>`);
    }
    const directives = out.match(/Read the attached image/gi) ?? [];
    assert.equal(directives.length, 1, "exactly ONE directive regardless of image count");
  } finally {
    cleanup(sink);
  }
});

test("promptToClaude: an audio block produces NO temp file and empty output", () => {
  const sink: string[] = [];
  try {
    const out = promptToClaude(req({ type: "audio", data: "QQ==", mimeType: "audio/wav" }), console, sink);
    assert.equal(sink.length, 0, "audio materializes nothing");
    assert.equal(out, "", "audio contributes nothing to the payload");
  } finally {
    cleanup(sink);
  }
});

test("promptToClaude: a blob resource produces NO temp file and empty output", () => {
  const sink: string[] = [];
  try {
    const out = promptToClaude(
      req({ type: "resource", resource: { uri: "file:///p/x.bin", blob: "QUJD", mimeType: "application/octet-stream" } }),
      console,
      sink,
    );
    assert.equal(sink.length, 0, "blob resource materializes nothing");
    assert.equal(out, "", "blob resource contributes nothing to the payload");
  } finally {
    cleanup(sink);
  }
});
