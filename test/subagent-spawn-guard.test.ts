// Story 044 / Task 3.1 (R2.2) — the spawn guard exported from subagent-source.ts.
//
// Option B's watcher and the pump's arm/teardown decision both need the main-chain spawn signal:
//   - `hasSubagentSpawn(mainChain)` — story 041's module-private probe, now EXPORTED (reuse over
//     re-implementation): true iff any main-chain row carries a `Task`/`Agent` `tool_use` block.
//   - `spawnIdsOpen(mainChain)` — NEW small helper: true iff at least one `Task`/`Agent` `tool_use`
//     id has NO matching `tool_result` (`tool_use_id === id`) in the same chain — i.e. a sub-agent
//     is (possibly) still in flight, so the watcher must stay armed; false once every spawn id is
//     closed, which is the pump's teardown gate (R2.2).
//
// NOTE (tasks.md): this is a type/reuse-only slice — the runtime behavior of `hasSubagentSpawn` is
// already delivered and pinned by story 041 (`test/subagent-source.test.ts` cheap-path spy). The
// cases here are regression guards over the newly-exported surface, validated alongside tsc.
//
// node:test runner: `node --experimental-strip-types --test test/subagent-spawn-guard.test.ts`
// (run `npm run build` first — imports resolve against ../dist/subagent-source.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { hasSubagentSpawn, spawnIdsOpen } from "../dist/subagent-source.js";

/** Reduced-shape main-chain row with arbitrary content blocks. */
const row = (uuid: string, type: string, content: unknown) => ({
  uuid,
  type,
  message: { role: type, content },
});

/** An assistant row whose `tool_use` spawns a sub-agent via `name` (Task/Agent). */
const spawn = (uuid: string, id: string, name: string) =>
  row(uuid, "assistant", [{ type: "tool_use", id, name, input: {} }]);

/** A user row whose `tool_result` closes the spawning `tool_use` id. */
const close = (uuid: string, id: string) =>
  row(uuid, "user", [{ type: "tool_result", tool_use_id: id, content: "done" }]);

test("hasSubagentSpawn: true on a Task or Agent tool_use, false otherwise (R2.2)", () => {
  assert.equal(hasSubagentSpawn([spawn("m1", "t1", "Task")] as never), true, "Task spawn → true");
  assert.equal(hasSubagentSpawn([spawn("m1", "t1", "Agent")] as never), true, "Agent spawn → true");
  assert.equal(
    hasSubagentSpawn([row("m1", "assistant", [{ type: "text", text: "hi" }])] as never),
    false,
    "text-only chain → false",
  );
  assert.equal(
    hasSubagentSpawn([spawn("m1", "t1", "Bash")] as never),
    false,
    "a non-Task/Agent tool_use (Bash) → false",
  );
  assert.equal(hasSubagentSpawn([] as never), false, "empty chain → false");
  assert.equal(
    hasSubagentSpawn([row("m1", "assistant", "plain string content")] as never),
    false,
    "tolerant of the reduced shape: string content is skipped, not crashed on",
  );
});

test("spawnIdsOpen: true while a spawn id is unclosed, false once every spawn id is closed (R2.2)", () => {
  const open = [spawn("m1", "toolu_T", "Task")];
  assert.equal(spawnIdsOpen(open as never), true, "spawn with no tool_result → open");

  const closed = [spawn("m1", "toolu_T", "Task"), close("m2", "toolu_T")];
  assert.equal(spawnIdsOpen(closed as never), false, "the matching tool_result closes the spawn");

  const twoOneOpen = [
    spawn("m1", "toolu_A", "Task"),
    spawn("m2", "toolu_B", "Agent"),
    close("m3", "toolu_A"),
  ];
  assert.equal(spawnIdsOpen(twoOneOpen as never), true, "one of two spawns still open → open");

  const twoBothClosed = [...twoOneOpen, close("m4", "toolu_B")];
  assert.equal(spawnIdsOpen(twoBothClosed as never), false, "every spawn id closed → not open");
});

test("spawnIdsOpen: no spawn at all → false (the no-subagent turn never arms the watcher) (R2.2)", () => {
  assert.equal(spawnIdsOpen([] as never), false, "empty chain → false");
  assert.equal(
    spawnIdsOpen([row("m1", "assistant", [{ type: "text", text: "hi" }])] as never),
    false,
    "no Task/Agent tool_use → false",
  );
  assert.equal(
    spawnIdsOpen([spawn("m1", "t1", "Bash"), close("m2", "other")] as never),
    false,
    "an ordinary tool_use (Bash) is not a spawn — never holds the watcher armed",
  );
});

test("spawnIdsOpen: an unrelated tool_result does not close a spawn (id must match) (R2.2)", () => {
  const mismatch = [spawn("m1", "toolu_T", "Task"), close("m2", "toolu_OTHER")];
  assert.equal(spawnIdsOpen(mismatch as never), true, "a non-matching tool_use_id leaves the spawn open");
});
