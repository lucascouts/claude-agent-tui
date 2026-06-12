// Story 015 / Task 2.2 — corrupt-line tolerance: a complete line that fails JSON.parse is caught,
// skipped, and the read continues; a transiently-truncated line is re-presented and ingested on the
// next complete flush (R3.1, R3.2).
// node:test runner: `node --experimental-strip-types --test test/watcher-corrupt.test.ts`
// (run `npm run build` first — behavioral imports resolve against ../dist).
//
// The crux: one malformed top-level line must NEVER derail the rest, and a line that was momentarily
// incomplete (held in the residue buffer from 2.1) gets a second chance once its `\n` arrives — so a
// torn write is recovered, not lost.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createLineReader, feedChunks } from "../dist/jsonl.js";

test("createLineReader: a malformed JSON line between two valid lines is skipped; both valid lines still process (R3.1)", () => {
  const forwarded: unknown[] = [];
  const reader = createLineReader((r) => forwarded.push(r));

  // valid, then GARBAGE (unparseable), then valid — all three are `\n`-terminated COMPLETE lines.
  assert.doesNotThrow(() => {
    reader.push(
      `${JSON.stringify({ type: "user", n: 1 })}\n` +
        `{ this is not json at all \n` + // malformed complete line
        `${JSON.stringify({ type: "assistant", n: 2 })}\n`,
    );
  }, "a corrupt line must NOT throw");

  assert.equal(forwarded.length, 2, "the malformed line is skipped; both valid lines process");
  assert.deepEqual(forwarded, [
    { type: "user", n: 1 },
    { type: "assistant", n: 2 },
  ]);
  assert.equal(reader.residue, "", "no residue — every fed line was newline-terminated");
});

test("createLineReader: a truncated line then its completion parses on the LATER flush (R3.2)", () => {
  const forwarded: unknown[] = [];
  const reader = createLineReader((r) => forwarded.push(r));

  // A line arrives truncated (no `\n`): it is unparseable AND incomplete, so it must be withheld in
  // residue — NOT skipped — so it can be completed later. This is the 2.1 residue buffer enabling
  // the 2.2 recovery: a transient truncation is recovered, not dropped.
  reader.push(`{"type":"user","cwd":"/home/user/a_b"`); // truncated mid-record, no `\n`
  assert.equal(forwarded.length, 0, "the truncated line forwards nothing yet");
  assert.equal(
    reader.residue,
    `{"type":"user","cwd":"/home/user/a_b"`,
    "truncated line waits in residue (not skipped)",
  );

  // The remainder + terminating `\n` arrives on a later flush — now the line is complete and parses.
  reader.push(`,"id":42}\n`);
  assert.equal(forwarded.length, 1, "the completed line is ingested on the later flush");
  assert.deepEqual(
    forwarded[0],
    { type: "user", cwd: "/home/user/a_b", id: 42 },
    "the re-presented line parses to the full reassembled record",
  );
  assert.equal(reader.residue, "", "residue drained after completion");
});

test("createLineReader: a genuinely corrupt COMPLETE line is skipped for good; later valid lines still flow (R3.1 vs R3.2)", () => {
  const forwarded: unknown[] = [];
  const reader = createLineReader((r) => forwarded.push(r));

  // Unlike the truncated case, this corrupt line IS `\n`-terminated — so it is complete-but-garbage
  // and is skipped permanently (it never re-presents). A subsequent valid line must still process.
  reader.push(`{ "broken": , }\n`); // complete (has `\n`) but invalid JSON → skipped for good
  assert.equal(forwarded.length, 0, "the complete-but-corrupt line is skipped");
  assert.equal(
    reader.residue,
    "",
    "nothing withheld — the corrupt line was complete, not truncated",
  );

  reader.push(`${JSON.stringify({ ok: true })}\n`);
  assert.equal(forwarded.length, 1, "a later valid line still processes after a permanent skip");
  assert.deepEqual(forwarded[0], { ok: true });
});

// VALIDATION (2.2): a fixture with one malformed line among valid lines processes the valid lines and
// NEVER throws — exercised end-to-end through feedChunks (a closed sequence flushes its last record).
test("feedChunks: one malformed line among valid lines → valid lines process, never throws", () => {
  const forwarded: unknown[] = [];
  const lines = [
    `${JSON.stringify({ type: "summary", id: "a" })}\n`,
    `<<< not json >>>\n`, // the malformed line
    `${JSON.stringify({ type: "user", id: "b" })}\n`,
    `${JSON.stringify({ type: "assistant", id: "c" })}`, // last record, no trailing `\n` (closed-seq flush)
  ];

  assert.doesNotThrow(() => {
    feedChunks(lines, (r) => forwarded.push(r));
  }, "a malformed line in the stream must never throw");

  assert.equal(
    forwarded.length,
    3,
    "all three valid records process; only the malformed line is skipped",
  );
  assert.deepEqual(forwarded, [
    { type: "summary", id: "a" },
    { type: "user", id: "b" },
    { type: "assistant", id: "c" },
  ]);
});
