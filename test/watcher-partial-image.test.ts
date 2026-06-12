// Story 015 / Task 3.3 — partial large-image append emits EXACTLY once. Proves the residue buffer
// (Task 2 tailTranscript) and the uuid dedupe (Task 3 watcher) TOGETHER yield exactly-once emit for
// a non-atomically appended ~630 KB base64 image line: the line reader withholds the line until its
// closing `\n`, so NO write signal fires for the partial flush; and the uuid dedupe guards the live
// re-read from re-emitting it on a later overlapping superset (R5.2).
// node:test runner: `node --experimental-strip-types --test test/watcher-partial-image.test.ts`
// (run `npm run build` first — behavioral imports resolve against ../dist).
//
// We drive the REAL tailTranscript (so the genuine residue-withholding logic is exercised), feeding
// it via its injected watch/readSlice/fileSize seams to model partial→complete file growth. The
// getMessages stub returns the image message ONLY once the line is complete (mirroring the SDK,
// whose reader also only surfaces a complete `\n`-terminated record). No real fs.watch / SDK.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createJsonlWatcher } from "../dist/engine-watcher.js";
import { tailTranscript } from "../dist/jsonl.js";
import type { TailOptions } from "../dist/jsonl.js";

/** A controllable debounce scheduler: capture the pending fn; `flush()` fires it synchronously. */
function makeScheduler() {
  let pending: (() => void) | undefined;
  const schedule = (fn: () => void, _ms: number): (() => void) => {
    pending = fn;
    return () => {
      if (pending === fn) pending = undefined;
    };
  };
  const flush = (): void => {
    const fn = pending;
    pending = undefined;
    fn?.();
  };
  return {
    schedule,
    flush,
    get armed() {
      return pending !== undefined;
    },
  };
}

test("a partial ~630 KB image line emits exactly once — never on the partial flush (R5.2)", async () => {
  // Build a single ~630 KB base64-ish `image` JSONL line carrying a uuid, then split it mid-payload
  // so the record straddles two non-atomic writes (the realistic torn-write hazard for big images).
  const imageUuid = "img-uuid-630k";
  const bigData = "x".repeat(630 * 1024); // ~645 120 chars of "base64" payload
  const imageLine =
    JSON.stringify({
      uuid: imageUuid,
      type: "user",
      message: { content: [{ type: "image", data: bigData }] },
    }) + "\n";
  assert.ok(imageLine.length > 630 * 1024, "the assembled image line is indeed ~630 KB+");

  const splitAt = Math.floor(imageLine.length / 2);
  const firstWrite = imageLine.slice(0, splitAt); // no `\n` — torn mid-line
  const secondWrite = imageLine.slice(splitAt); // remainder incl. the terminating `\n`

  // In-memory "file" the REAL tailTranscript reads through its injected seams. Starts empty (the
  // tail attaches its offset at size 0), then grows by two non-atomic writes.
  let fileBytes = Buffer.from("", "utf8");
  let triggerTail: (() => void) | undefined;

  const realTail = (path: string, opts: TailOptions) =>
    tailTranscript(path, {
      onRecord: opts.onRecord, // the watcher's write-signal callback — passed straight through
      watch: (_p, onChange) => {
        triggerTail = onChange;
        return {
          close: () => {
            triggerTail = undefined;
          },
        };
      },
      fileSize: () => fileBytes.length,
      readSlice: (_p, fromByte) => fileBytes.toString("utf8", fromByte),
    });

  // The reader stub mirrors the SDK: the image message is only present in the transcript once the
  // COMPLETE line exists. We gate it on the in-memory file actually containing the closing `\n`.
  const fileHasCompleteImageLine = (): boolean => fileBytes.toString("utf8").includes("\n");
  let getCalls = 0;
  const sched = makeScheduler();
  const emitted: Array<{ uuid?: string }> = [];

  const watcher = createJsonlWatcher({
    sessionId: "sess-img",
    transcriptPath: "/virtual/sess-img.jsonl",
    onEvent: (m) => emitted.push(m),
    getMessages: () => {
      getCalls++;
      return fileHasCompleteImageLine() ? [{ uuid: imageUuid, type: "user" }] : [];
    },
    tail: realTail,
    schedule: sched.schedule,
  });

  // --- Partial flush: the first non-atomic write lands a half-written image line (no `\n`). ---
  fileBytes = Buffer.from(firstWrite, "utf8");
  triggerTail!();
  // The REAL line reader withholds the partial line (no `\n`) → NO write signal → NO debounce armed
  // → NO re-read. This is the residue-buffer guarantee that prevents a re-read seeing a torn line.
  assert.equal(
    sched.armed,
    false,
    "the partial flush fires NO write signal (line withheld in residue) — no debounce armed",
  );
  sched.flush(); // no-op (nothing pending), but assert nothing was emitted regardless.
  await Promise.resolve();
  assert.equal(getCalls, 0, "getSessionMessages is NOT invoked on the partial flush");
  assert.equal(emitted.length, 0, "NOTHING is emitted from the partial flush");

  // --- Completing flush: the second write supplies the remainder + the terminating `\n`. ---
  fileBytes = Buffer.concat([fileBytes, Buffer.from(secondWrite, "utf8")]);
  triggerTail!();
  // Now a complete line exists → the line reader forwards a write SIGNAL → the debounce is armed.
  assert.equal(
    sched.armed,
    true,
    "the completing flush fires a write signal (the now-complete line) — debounce armed",
  );
  sched.flush();
  await Promise.resolve();
  assert.equal(
    emitted.filter((m) => m.uuid === imageUuid).length,
    1,
    "the image line's event is emitted EXACTLY once, only after its closing `\\n` (R5.2)",
  );

  // --- A further overlapping re-read (e.g. an end-of-turn forced re-read) must NOT re-emit it. ---
  watcher.notifyEndOfTurn();
  await Promise.resolve();
  assert.equal(
    emitted.filter((m) => m.uuid === imageUuid).length,
    1,
    "the uuid dedupe guards the forced re-read of the overlapping superset from re-emitting the image",
  );

  watcher.stop();
});
