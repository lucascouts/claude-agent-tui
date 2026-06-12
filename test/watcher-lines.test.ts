// Story 015 / Task 2.1 — newline-atomic line reader: forward only `\n`-terminated COMPLETE lines,
// withhold the trailing partial fragment in a residue buffer until a later flush completes it
// (R2.1, R2.2, R2.3).
// node:test runner: `node --experimental-strip-types --test test/watcher-lines.test.ts`
// (run `npm run build` first — behavioral imports resolve against ../dist).
//
// The crux: a non-atomic append (a flush that ends mid-line, or a ~630 KB image line split across
// two writes) MUST NOT be parsed until its terminating `\n` is observed, so a torn write can never
// corrupt parsing. These scenarios drive createLineReader DIRECTLY (and inspect `.residue`) because
// a live tail must hold a partial residue back — unlike `feedChunks`, which is a closed sequence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createLineReader, feedChunks, tailTranscript } from "../dist/jsonl.js";

test("createLineReader: a flush ending mid-line is buffered as residue, NOT forwarded (R2.2)", () => {
  const forwarded: unknown[] = [];
  const reader = createLineReader((r) => forwarded.push(r));

  // One complete line followed by a partial fragment with NO trailing `\n`.
  reader.push(`${JSON.stringify({ type: "user", n: 1 })}\n` + `{"type":"assistant","n":2`);

  assert.equal(forwarded.length, 1, "only the one complete line is forwarded on the partial flush");
  assert.deepEqual(forwarded[0], { type: "user", n: 1 }, "the complete line's record is forwarded");
  assert.equal(
    reader.residue,
    `{"type":"assistant","n":2`,
    "the partial fragment sits in residue, unparsed",
  );
});

test("createLineReader: the completing flush forwards EXACTLY the one now-complete line (R2.2)", () => {
  const forwarded: unknown[] = [];
  const reader = createLineReader((r) => forwarded.push(r));

  reader.push(`{"type":"assistant","n":2`); // partial — withheld
  assert.equal(forwarded.length, 0, "partial fragment forwards nothing");
  assert.equal(reader.residue, `{"type":"assistant","n":2`, "partial fragment buffered");

  reader.push(`,"done":true}\n`); // completes the prior fragment with its `\n`

  assert.equal(forwarded.length, 1, "exactly the one now-complete line is forwarded");
  assert.deepEqual(
    forwarded[0],
    { type: "assistant", n: 2, done: true },
    "the completed record is the joined fragments",
  );
  assert.equal(reader.residue, "", "residue is drained once the line completes");
});

test("createLineReader: a ~630 KB image line split across two writes forwards ONCE, only after the closing `\\n` (R2.3)", () => {
  const forwarded: unknown[] = [];
  const reader = createLineReader((r) => forwarded.push(r));

  // Build a single ~630 KB base64-ish `image` line, then split it at an arbitrary mid-point so the
  // record straddles two non-atomic writes (the realistic torn-write hazard for big image events).
  const bigData = "x".repeat(630 * 1024); // ~645 120 chars of "base64" payload
  const imageLine = JSON.stringify({
    type: "user",
    message: { content: [{ type: "image", data: bigData }] },
  });
  assert.ok(imageLine.length > 630 * 1024, "the assembled image line is indeed ~630 KB+");

  const splitAt = Math.floor(imageLine.length / 2);
  const firstWrite = imageLine.slice(0, splitAt); // no `\n` — torn mid-line
  const secondWrite = imageLine.slice(splitAt) + "\n"; // remainder + the terminating newline

  reader.push(firstWrite);
  assert.equal(
    forwarded.length,
    0,
    "the half-written image line forwards NOTHING (withheld until `\\n`)",
  );
  assert.equal(
    reader.residue.length,
    firstWrite.length,
    "the entire first write is buffered as residue",
  );

  reader.push(secondWrite);
  assert.equal(
    forwarded.length,
    1,
    "the image line is forwarded exactly ONCE, after the closing `\\n`",
  );
  assert.deepEqual(
    forwarded[0],
    { type: "user", message: { content: [{ type: "image", data: bigData }] } },
    "the reassembled record is byte-for-byte the original image event",
  );
  assert.equal(reader.residue, "", "no residue remains after the line completes");
});

test("createLineReader: multiple complete lines in one flush all forward; blank lines are ignored", () => {
  const forwarded: unknown[] = [];
  const reader = createLineReader((r) => forwarded.push(r));

  // Two complete records, a blank line (double `\n`), then a partial tail.
  reader.push(
    `${JSON.stringify({ a: 1 })}\n` +
      `${JSON.stringify({ b: 2 })}\n` +
      `\n` + // blank line — must NOT be forwarded nor throw
      `{"c":3`, // partial tail
  );

  assert.equal(forwarded.length, 2, "both complete lines forward; the blank line is skipped");
  assert.deepEqual(forwarded, [{ a: 1 }, { b: 2 }]);
  assert.equal(reader.residue, `{"c":3`, "the partial tail is withheld");
});

test("feedChunks: a record straddling two chunks is parsed once, after the join (cross-chunk residue)", () => {
  const forwarded: unknown[] = [];
  // The record is split across two chunks; feedChunks buffers residue across them and (being a
  // CLOSED sequence) flushes the final non-`\n` record at end-of-input.
  feedChunks([`{"type":"user",`, `"n":7}`], (r) => forwarded.push(r));

  assert.equal(forwarded.length, 1, "the straddling record is forwarded exactly once");
  assert.deepEqual(forwarded[0], { type: "user", n: 7 });
});

// VALIDATION (2.1): a synthetic split-append fixture forwards ZERO lines on the partial flush and
// EXACTLY the completed line(s) on the closing flush — driven through tailTranscript's injected
// seams (no real fs.watch timing). Models a transcript that grows by two non-atomic writes.
test("tailTranscript: split-append fixture forwards 0 on the partial flush, then exactly the completed line", () => {
  const forwarded: unknown[] = [];
  let trigger: (() => void) | undefined;

  // In-memory "file": starts empty (offset attaches at size 0), then grows in two writes.
  let fileBytes = Buffer.from("", "utf8");
  const completedLine = `${JSON.stringify({ type: "assistant", text: "hello world" })}\n`;
  const firstWrite = completedLine.slice(0, 10); // partial — no `\n`
  const secondWrite = completedLine.slice(10); // remainder incl. the terminating `\n`

  const tail = tailTranscript("/virtual/sess.jsonl", {
    onRecord: (r) => forwarded.push(r),
    watch: (_path, onChange) => {
      trigger = onChange;
      return {
        close: () => {
          trigger = undefined;
        },
      };
    },
    fileSize: () => fileBytes.length,
    readSlice: (_path, fromByte) => fileBytes.toString("utf8", fromByte),
  });

  // First non-atomic write lands a partial line; signal the watcher.
  fileBytes = Buffer.from(firstWrite, "utf8");
  trigger!();
  assert.equal(forwarded.length, 0, "partial flush forwards ZERO lines (withheld in residue)");

  // Second write completes the line with its `\n`; signal again.
  fileBytes = Buffer.concat([fileBytes, Buffer.from(secondWrite, "utf8")]);
  trigger!();
  assert.equal(forwarded.length, 1, "closing flush forwards EXACTLY the one completed line");
  assert.deepEqual(forwarded[0], { type: "assistant", text: "hello world" });

  tail.stop();
  // After stop(), further (spurious) change events are inert.
  fileBytes = Buffer.concat([
    fileBytes,
    Buffer.from(`${JSON.stringify({ late: true })}\n`, "utf8"),
  ]);
  if (trigger) trigger();
  assert.equal(forwarded.length, 1, "no records forwarded after stop()");
});
