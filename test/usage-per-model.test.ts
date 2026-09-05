// Task 3.1 (R5.1, R5.3) — group token usage per model, keyed by the JSONL's
// per-turn `assistant.message.model`.
//
// Authored test-first from the requirement. FLAT in test/ on purpose: the runner
// globs `test/*.test.ts`, so a file one directory down is skipped silently while
// the suite still reports green.
//
// CONTRACT (invented here — nothing in the design pins a signature; the executor
// may rename it, but not weaken it):
//   usageByModel(carriers) → Map<string | null, number>
//     key   the turn's `assistant.message.model`, or `null` for a turn that
//           carries no model tag
//     value the tokens used by that key's turns (input + output), summed
//
// Grouping is an identity rule — two turns are the SAME model or they are not —
// so the hostile fixtures come first, in both directions:
//   1. WRONGLY COLLAPSED: two model ids that differ only by a suffix
//      (`claude-opus-4-8` vs `claude-opus-4-8[1m]`) are DIFFERENT models with
//      different windows. A prefix/startsWith match, or a normalisation that
//      strips the bracket, merges two models' spend into one row.
//   2. WRONGLY SPLIT: the same model across two turns is ONE row. Keying by
//      anything that varies per turn (uuid, timestamp, the usage block itself)
//      passes case 1 and produces one row per turn.
//   3. THE THIRD KEY — the untagged bucket is a key this port INVENTS; the
//      requirement names only `assistant.message.model`, so no wording in it
//      points at what an untagged turn is filed under. A turn literally tagged
//      "unknown" must therefore not land in the same bucket as a turn with no
//      tag at all, or two unrelated things read as one model in the total.
// Only then the benign fixture.
//
// node:test (build first):
//   npm test   —  or  node --experimental-strip-types --test test/usage-per-model.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { usageByModel } from "../dist/usage.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** One JSONL turn's `assistant.message` — the carrier the pump already hands to
 *  the usage mapping, plus the model tag story 066 established is on it. */
const turn = (model: string | null | undefined, input: number, output: number) => ({
  ...(model === undefined ? {} : { model }),
  usage: { input_tokens: input, output_tokens: output },
});

/** Read one key's total, tolerating a Map or a plain-object grouping. */
function total(grouped: any, key: string | null): number | undefined {
  if (grouped instanceof Map) return grouped.get(key);
  return grouped?.[key === null ? "null" : key];
}

function keyCount(grouped: any): number {
  return grouped instanceof Map ? grouped.size : Object.keys(grouped ?? {}).length;
}

test("3.1 near-identical model ids stay APART (hostile: wrongly collapsed) (R5.1)", () => {
  const grouped = usageByModel([
    turn("claude-opus-4-8", 100, 10),
    turn("claude-opus-4-8[1m]", 7, 3),
  ]);
  assert.equal(keyCount(grouped), 2, "two model ids, two rows — a suffix is not a spelling");
  assert.equal(total(grouped, "claude-opus-4-8"), 110);
  assert.equal(total(grouped, "claude-opus-4-8[1m]"), 10);
});

test("3.1 the SAME model across two turns comes TOGETHER (hostile: wrongly split) (R5.1)", () => {
  const grouped = usageByModel([
    turn("claude-sonnet-4-5", 100, 10),
    turn("claude-sonnet-4-5", 5, 5),
  ]);
  assert.equal(keyCount(grouped), 1, "one model, one row, however many turns it spans");
  assert.equal(total(grouped, "claude-sonnet-4-5"), 120);
});

test("3.1 a turn tagged 'unknown' is NOT the untagged bucket (hostile: the third key) (R5.1)", () => {
  const grouped = usageByModel([turn(undefined, 1, 1), turn("unknown", 40, 2)]);
  assert.equal(keyCount(grouped), 2, "an untagged turn and a turn tagged 'unknown' are two things");
  assert.equal(total(grouped, null), 2, "the untagged turn keeps its own total");
  assert.equal(total(grouped, "unknown"), 42, "a model literally named 'unknown' is a model");
});

test("3.1 an empty model tag counts as untagged, not as the model named '' (R5.1)", () => {
  // The tree's own convention on the live path (acp-agent.ts: `length > 0`).
  const grouped = usageByModel([turn("", 3, 4)]);
  assert.equal(total(grouped, null), 7);
  assert.equal(total(grouped, ""), undefined);
});

test("3.1 two turns on different models produce two totals (R5.1)", () => {
  const grouped = usageByModel([
    turn("claude-sonnet-4-5", 100, 10),
    turn("claude-haiku-4-5", 20, 5),
  ]);
  assert.equal(keyCount(grouped), 2);
  assert.equal(total(grouped, "claude-sonnet-4-5"), 110);
  assert.equal(total(grouped, "claude-haiku-4-5"), 25);
});

test("3.1 a turn with no model tag falls back to the ungrouped total (R5.1)", () => {
  const grouped = usageByModel([turn("claude-sonnet-4-5", 10, 10), turn(undefined, 1, 2)]);
  assert.equal(total(grouped, null), 3, "untagged tokens are counted, never dropped");
  assert.equal(total(grouped, "claude-sonnet-4-5"), 20, "and never attributed to a model");
});

test("3.1 the module states what the port does not deliver (R5.3)", () => {
  // D4: the port is knowingly unconsumed. Saying so in the code is the whole
  // difference between a port and a claim of parity.
  const source = readFileSync(join(HERE, "..", "src", "usage.ts"), "utf8");
  assert.ok(
    /no current client renders|unconsumed/i.test(source),
    "usage.ts must say no current client renders per-model usage",
  );
  assert.ok(
    /publish|bump/i.test(source),
    "usage.ts must say nothing here publishes or bumps the package",
  );
});
