// Story 015 / Task 2 regression — a multi-byte UTF-8 char split across an fs.watch read boundary
// must NOT corrupt the byte offset or the parsed value (R2.3). Guards the StringDecoder fix in
// jsonl.ts `defaultReadSlice` (a naive `buf.toString('utf8')` would emit U+FFFD for the partial
// bytes, whose 3-byte re-encode then desynchronizes the offset and silently skips file bytes).
// Runner: node --experimental-strip-types --test test/watcher-utf8.test.ts (run `npm run build` first).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tailTranscript } from "../dist/jsonl.js";

test("tailTranscript: a multi-byte UTF-8 char split across read boundaries is re-read intact, not corrupted (R2.3)", () => {
  const dir = mkdtempSync(join(tmpdir(), "watcher-utf8-"));
  const file = join(dir, "t.jsonl");
  try {
    // Empty file: tail-F starts the offset at the current size (0), so it forwards bytes appended next.
    writeFileSync(file, "");

    const records: unknown[] = [];
    let fire: () => void = () => {};
    // Inject ONLY the watch seam (capture the change callback so we drive it deterministically); use
    // the DEFAULT readSlice/fileSize so this exercises the real byte-offset fs reads under test.
    const tail = tailTranscript(file, {
      onRecord: (r) => records.push(r),
      watch: (_p, onChange) => {
        fire = onChange;
        return { close() {} };
      },
    });

    // A JSON line whose value carries multi-byte chars: CJK '中文' (3 bytes each) + an emoji (4 bytes).
    const line = JSON.stringify({ k: "a中文🌟b" }) + "\n";
    const bytes = Buffer.from(line, "utf8");
    // Cut ONE byte into the first multi-byte char ('中' = e4 b8 ad): the JSON prefix `{"k":"a` is
    // ASCII (7 bytes), so cutting at 8 lands mid-'中' — a naive decode would corrupt here.
    const cut = Buffer.byteLength('{"k":"a', "utf8") + 1;

    appendFileSync(file, bytes.subarray(0, cut));
    fire(); // partial flush — the incomplete '中' must be withheld, offset must NOT over-advance
    appendFileSync(file, bytes.subarray(cut));
    fire(); // completing flush — the line is now whole

    tail.stop();
    assert.equal(records.length, 1, "exactly one complete line is forwarded");
    assert.deepEqual(
      records[0],
      { k: "a中文🌟b" },
      "the multi-byte value round-trips intact (no U+FFFD, no skipped file bytes)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tailTranscript: a 4-byte emoji split one byte at a time stays intact across many tiny flushes (R2.3)", () => {
  const dir = mkdtempSync(join(tmpdir(), "watcher-utf8b-"));
  const file = join(dir, "t.jsonl");
  try {
    writeFileSync(file, "");
    const records: unknown[] = [];
    let fire: () => void = () => {};
    const tail = tailTranscript(file, {
      onRecord: (r) => records.push(r),
      watch: (_p, onChange) => {
        fire = onChange;
        return { close() {} };
      },
    });

    const bytes = Buffer.from(JSON.stringify({ e: "🌟" }) + "\n", "utf8");
    // Append ONE byte per flush — every multi-byte boundary is exercised; none may corrupt.
    for (let i = 0; i < bytes.length; i++) {
      appendFileSync(file, bytes.subarray(i, i + 1));
      fire();
    }

    tail.stop();
    assert.equal(
      records.length,
      1,
      "the line is forwarded exactly once, after its closing newline",
    );
    assert.deepEqual(
      records[0],
      { e: "🌟" },
      "the 4-byte emoji is reassembled byte-by-byte without corruption",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
