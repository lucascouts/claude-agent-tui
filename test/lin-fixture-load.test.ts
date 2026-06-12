// Story 017 / Task 4.3 — Build the real Task/sidechain reference fixture.
//
// The fixture mirrors the OBSERVED corpus shape (see .draft/deviations.yaml): a main session with an
// `Agent` subagent-spawning tool_use (kind `think`, §7 Task/Agent map) plus subagent rows carrying
// `isSidechain: true`. Content is SYNTHESIZED — the real transcript is a client project and is not
// committable; the field shapes (isSidechain, agentId, parentToolUseId, parentUuid, summary anchor)
// are faithful to the corpus (subagents/agent-*.jsonl). This test asserts the fixture loads and
// contains at least one isSidechain event and one subagent-spawning tool_use (R5.1).
//
// node:test runner: `node --experimental-strip-types --test test/lin-fixture-load.test.ts`
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const FIXTURE_URL = new URL("../fixtures/lin-task-sidechain.jsonl", import.meta.url);

function loadFixture(): Array<Record<string, unknown>> {
  return readFileSync(FIXTURE_URL, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

test("the reference fixture loads and parses every line", () => {
  const rows = loadFixture();
  assert.ok(rows.length >= 4, "fixture should have several rows");
  for (const r of rows) assert.equal(typeof r.uuid, "string");
});

test("the fixture contains at least one isSidechain event", () => {
  const rows = loadFixture();
  const sidechains = rows.filter((r) => r.isSidechain === true);
  assert.ok(sidechains.length >= 1, "fixture must contain >= 1 isSidechain row");
});

test("the fixture contains at least one subagent-spawning tool_use (Agent/Task, §7 think)", () => {
  const rows = loadFixture();
  let found = false;
  for (const r of rows) {
    const m = r.message as { content?: unknown } | undefined;
    if (m && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (
          b &&
          typeof b === "object" &&
          (b as { type?: string }).type === "tool_use" &&
          ["Agent", "Task"].includes((b as { name?: string }).name ?? "")
        ) {
          found = true;
        }
      }
    }
  }
  assert.ok(found, "fixture must contain >= 1 Agent/Task tool_use");
});
