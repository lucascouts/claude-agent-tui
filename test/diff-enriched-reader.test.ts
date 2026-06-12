// Story 043 / Task 1.1 (R1.1, R1.2, R1.3, R4.2) — the diff-enriched reduced-shape reader.
//
// The reader WRAPS a base `getSessionMessages`-shaped reader and hydrates each returned message's
// `toolUseResult` from the raw JSONL transcript, matched by `uuid`. The hydration is a pure fs read
// (R4.2 billing-free — NO SDK call) with a graceful fallback to the plain reduced messages when the
// transcript cannot be read/parsed (R1.3) and NEVER a fabricated patch when `toolUseResult` is absent.
//
// The unit under test is resolved against ../dist/diff-enriched-reader.js — an INTERNAL fork module
// imported DIRECTLY, NOT via lib.ts (whose public surface is frozen to upstream v0.39.0). Run with
// `npm run build` first, then `node --experimental-strip-types --test test/diff-enriched-reader.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toolUseResultMap,
  createDiffEnrichedReader,
} from "../dist/diff-enriched-reader.js";
import type { SessionMessage } from "../dist/engine-watcher.js";

// A raw JSONL line carrying a uuid (+ optionally a toolUseResult), as the transcript stores it.
const line = (rec: Record<string, unknown>): string => JSON.stringify(rec);

// === toolUseResultMap — only records with a string uuid AND a defined toolUseResult enter ==========

test("toolUseResultMap: indexes only records with a string uuid AND a defined toolUseResult (R1.2)", () => {
  const raw = [
    line({ uuid: "a", toolUseResult: { structuredPatch: [] } }), // ✓ enters
    line({ uuid: "b" }), // ✗ no toolUseResult → not indexed
    line({ toolUseResult: { structuredPatch: [] } }), // ✗ no string uuid → not indexed
    line({ uuid: 7, toolUseResult: { x: 1 } }), // ✗ uuid not a string → not indexed
  ];
  const map = toolUseResultMap(raw);
  assert.equal(map.size, 1, "exactly one record qualifies (uuid 'a')");
  assert.ok(map.has("a"), "uuid 'a' (has toolUseResult) is indexed");
  assert.deepEqual(map.get("a"), { structuredPatch: [] }, "the exact toolUseResult value is stored");
  assert.ok(!map.has("b"), "a record without toolUseResult is NOT indexed (returned unchanged later)");
});

test("toolUseResultMap: empty lines and malformed JSON are skipped without throwing (robustness)", () => {
  const raw = [
    "", // empty → skipped
    "   ", // whitespace-only → skipped
    "{ not json", // malformed → skipped, no throw
    line({ uuid: "z", toolUseResult: { content: "x" } }), // ✓ the only valid carrier
  ];
  let map!: Map<string, unknown>;
  assert.doesNotThrow(() => {
    map = toolUseResultMap(raw);
  }, "malformed/empty lines must not throw");
  assert.equal(map.size, 1, "only the one valid toolUseResult-carrying record is indexed");
  assert.deepEqual(map.get("z"), { content: "x" });
});

// === createDiffEnrichedReader — pure hydration by uuid, never fabricated (R1.1, R1.2, R4.2) ========

test("createDiffEnrichedReader: hydrates the matched uuid; leaves unmatched messages UNCHANGED (R1.1/R4.2)", async () => {
  const base = (): SessionMessage[] => [{ uuid: "a" }, { uuid: "b" }];
  const reader = createDiffEnrichedReader(base, {
    findTranscript: () => ["/fake.jsonl"],
    // raw transcript carries a toolUseResult for 'a' ONLY
    readRawLines: () => [line({ uuid: "a", toolUseResult: { structuredPatch: [] } }), line({ uuid: "b" })],
  });

  const result = await reader("sess-1");
  assert.equal(result.length, 2, "ordering/identity come from base (2 messages)");

  const a = result.find((m) => m.uuid === "a")!;
  const b = result.find((m) => m.uuid === "b")!;

  assert.deepEqual(a.toolUseResult, { structuredPatch: [] }, "message 'a' gains its toolUseResult by uuid");
  // R4.2: 'b' has no raw toolUseResult → it must pass through with NO such key (never fabricated).
  assert.ok(!("toolUseResult" in b), "message 'b' is returned UNCHANGED — no fabricated toolUseResult (R4.2)");
});

test("createDiffEnrichedReader: a read/parse failure falls back to the plain reduced array (R1.3)", async () => {
  const reduced: SessionMessage[] = [{ uuid: "a" }, { uuid: "b" }];
  const reader = createDiffEnrichedReader(() => reduced, {
    findTranscript: () => ["/fake.jsonl"],
    readRawLines: () => {
      throw new Error("EACCES: simulated unreadable transcript");
    },
  });

  let result!: SessionMessage[];
  await assert.doesNotReject(async () => {
    result = await reader("sess-1");
  }, "a transcript read failure must NEVER crash the pump (R1.3)");
  assert.deepEqual(result, reduced, "falls back to the plain reduced messages (graceful no-op diff)");
});

test("createDiffEnrichedReader: an empty transcript glob returns the reduced messages unchanged (R1.3)", async () => {
  const reduced: SessionMessage[] = [{ uuid: "a" }];
  let readCalled = false;
  const reader = createDiffEnrichedReader(() => reduced, {
    findTranscript: () => [], // not found → no path
    readRawLines: () => {
      readCalled = true;
      return [];
    },
  });

  const result = await reader("sess-1");
  assert.deepEqual(result, reduced, "no transcript path → reduced messages, no fabrication");
  assert.equal(readCalled, false, "with no path resolved, the raw reader is never invoked");
});

// === billing-free (R4.2) — exactly one base call, no other reader/SDK call ==========================

test("createDiffEnrichedReader: invokes base exactly once per call and makes no other reader call (R4.2)", async () => {
  // R4.2 (billing-free) ledger: the ONLY two reads the enriched reader may perform per call are (1) the
  // base reader — the single billed/SDK source of truth — and (2) the injected `readRawLines`, a pure fs
  // read of the transcript. We tally EVERY invocation of both seams into one ordered ledger and assert it
  // is EXACTLY [base, readRawLines]: one base call + one fs read, and NO third reader/SDK call. There is no
  // other seam through which the reader could bill, so an exact-match ledger is a genuine "fs-only, no SDK
  // billing beyond base" proof (not just two independent counters that could each be > intended).
  const reads: string[] = [];
  let baseCalls = 0;
  let rawReads = 0;
  const base = (sessionId: string): SessionMessage[] => {
    reads.push("base");
    baseCalls += 1;
    assert.equal(sessionId, "sess-1", "the sessionId is forwarded to base verbatim");
    return [{ uuid: "a" }];
  };
  const reader = createDiffEnrichedReader(base, {
    findTranscript: () => ["/fake.jsonl"],
    readRawLines: () => {
      reads.push("readRawLines");
      rawReads += 1;
      return [line({ uuid: "a", toolUseResult: { content: "x" } })];
    },
  });

  await reader("sess-1");
  assert.equal(baseCalls, 1, "base is the SINGLE source of truth — invoked exactly once (no double-read)");
  assert.equal(rawReads, 1, "the enrichment is a single fs read (no SDK / no extra reader call) (R4.2)");
  // R4.2 made explicit: the COMPLETE set of reads is exactly the base reader followed by the fs read —
  // there is NO additional (SDK/billed) reader call. The hydration adds an fs read and nothing billable.
  assert.deepEqual(
    reads,
    ["base", "readRawLines"],
    "the enriched reader performs ONLY [base, fs readRawLines] — no extra/SDK billed reader call (R4.2)",
  );
});

test("createDiffEnrichedReader: forwards the reader opts ({ dir }) through to base", async () => {
  let seenOpts: { dir?: string } | undefined;
  const base = (_sessionId: string, opts?: { dir?: string }): SessionMessage[] => {
    seenOpts = opts;
    return [{ uuid: "a" }];
  };
  const reader = createDiffEnrichedReader(base, {
    findTranscript: () => [],
    readRawLines: () => [],
  });

  await reader("sess-1", { dir: "/work/cwd" });
  assert.deepEqual(seenOpts, { dir: "/work/cwd" }, "the { dir } opts are forwarded to base unchanged");
});
