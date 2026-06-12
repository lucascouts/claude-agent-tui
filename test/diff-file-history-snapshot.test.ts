// Story 021 / Task 1.1 — `file-history-snapshot` is NOT a diff source (doc §12, design D1).
//
// Verified over 568 real `file-history-snapshot` events: they carry ONLY {backupFileName, version,
// backupTime} — no inline file content — and ≈55% have `backupFileName:null` (a new file). They
// reference backups but never the bytes, so they cannot reconstruct a diff. The real diff source is
// the `user` event's `toolUseResult.structuredPatch`+`originalFile` (Edit) / `content` (Write),
// covered by Task 2. This test pins D1: the diff-source classifier rejects a file-history-snapshot
// shape, and such an event is excluded at the §6 type-routing layer (`classifyEvent` → lifecycle),
// so it is never reached as a diff source in the first place.
//
// node:test runner: `node --experimental-strip-types --test test/diff-file-history-snapshot.test.ts`
// (run `npm run build` first — the behavioural import resolves against ../dist).
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyDiffSource } from "../dist/diff-source.js";
import { classifyEvent } from "../dist/event-switch.js";

// A verified `file-history-snapshot` payload — exactly the three keys, no diff-source fields.
const fhs = { backupFileName: "/abs/x.ts.bak", version: 3, backupTime: "2026-06-03T12:00:00.000Z" };
// The ≈55% case: a new file snapshot with a null backup reference — yields no recoverable content.
const fhsNullBackup = { backupFileName: null, version: 1, backupTime: "2026-06-03T12:00:01.000Z" };

test("file-history-snapshot carries only {backupFileName,version,backupTime} — no inline diff content", () => {
  assert.deepEqual(Object.keys(fhs).sort(), ["backupFileName", "backupTime", "version"]);
  // None of the fields the diff source needs are present.
  assert.equal("originalFile" in fhs, false);
  assert.equal("content" in fhs, false);
  assert.equal("structuredPatch" in fhs, false);
});

test("classifyDiffSource rejects a file-history-snapshot payload as not-a-diff-source", () => {
  const r = classifyDiffSource(undefined, fhs);
  assert.equal(r.kind, "not-a-diff-source");
});

test("a backupFileName:null file-history-snapshot (new file, ~55% of corpus) yields no recoverable content", () => {
  assert.equal(fhsNullBackup.backupFileName, null);
  const r = classifyDiffSource(undefined, fhsNullBackup);
  assert.equal(r.kind, "not-a-diff-source");
  // No diff content is fabricated from a contentless snapshot.
  assert.equal("content" in r, false);
  assert.equal("newText" in r, false);
});

test("classifyEvent routes a file-history-snapshot event to the non-content lifecycle path (excluded at classification)", () => {
  const c = classifyEvent({ uuid: "fhs-1", type: "file-history-snapshot", message: null });
  assert.equal(c.class, "lifecycle");
  // A lifecycle event never carries a normalised content-block array to a §7 translator.
  assert.equal("content" in c, false);
});
