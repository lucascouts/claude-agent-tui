// The picker is read from the CLI at runtime (live-model-catalog.ts), replacing the
// hand-curated list. These pin the CONTRACT that made that change worth making:
// the live rows win when they arrive, the static list is the floor when they do not,
// and no failure path can ever hand the picker an empty list.
//
// No spawn and no `claude`: the SDK call is replaced through the `source` seam.
//
// node:test runner (build first):
//   npm run build && node --experimental-strip-types --test test/live-model-catalog.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveModelCatalog,
  resetLiveModelCatalogCache,
  CATALOG_TIMEOUT_MS,
} from "../dist/live-model-catalog.js";
import { MODEL_CATALOG } from "../dist/model-catalog.js";

const row = (value, displayName, resolvedModel) => ({
  value,
  displayName,
  description: "",
  ...(resolvedModel ? { resolvedModel } : {}),
});

// The eleven-row shape measured live on 2026-09-23.
const LIVE = [
  row("default", "Default (recommended)", "claude-opus-5-5"),
  row("opus", "Opus 5.5", "claude-opus-5-5"),
  row("claude-fable-5-1", "Fable 5.1"),
  row("sonnet", "Sonnet 5", "claude-sonnet-5"),
  row("haiku", "Haiku 4.5", "claude-haiku-4-5-20251001"),
  row("claude-opus-5", "Opus 5"),
  row("claude-fable-5", "Fable 5"),
  row("claude-opus-4-8", "Opus 4.8"),
  row("claude-opus-4-7", "Opus 4.7"),
  row("claude-opus-4-6", "Opus 4.6"),
  row("claude-sonnet-4-6", "Sonnet 4.6"),
];

const quiet = { log: () => {} };

test("live rows win, superseded generations removed", async () => {
  resetLiveModelCatalogCache();
  const models = await resolveModelCatalog(quiet, async () => LIVE);
  assert.deepEqual(
    models.map((m) => m.value),
    ["default", "opus", "claude-fable-5-1", "sonnet", "haiku"],
  );
});

test("titles and descriptions are passed through VERBATIM, never rewritten", async () => {
  // The whole point of reading the catalogue is to match what the CLI says. An
  // adapter that reformats the copy re-introduces the drift it set out to remove.
  resetLiveModelCatalogCache();
  const models = await resolveModelCatalog(quiet, async () => LIVE);
  const opus = models.find((m) => m.value === "opus");
  assert.equal(opus.displayName, "Opus 5.5");
  assert.equal(opus.description, "");
});

test("a throwing source falls back to the static catalogue, and REPORTS it once", async () => {
  resetLiveModelCatalogCache();
  const logged = [];
  const sink = { log: (m) => logged.push(String(m)) };
  const boom = async () => {
    throw new Error("no claude on PATH");
  };
  const models = await resolveModelCatalog(sink, boom);
  assert.deepEqual(models, MODEL_CATALOG);
  assert.equal(logged.length, 1, "a silent fallback is how the old bugs stayed invisible");
  assert.match(logged[0], /no claude on PATH/);

  // ONCE PER PROCESS, not once per session. Re-reporting an unchanging condition
  // is noise, and it broke two unrelated suites that assert an exact log count.
  await resolveModelCatalog(sink, boom);
  await resolveModelCatalog(sink, boom);
  assert.equal(logged.length, 1, "the report must not repeat while the process lives");
});

test("the fallback NEVER uses the error channel", async () => {
  // `error` means a human must act. This path recovered on its own, and a truly
  // unreachable CLI raises loudly from the PTY engine moments later anyway.
  resetLiveModelCatalogCache();
  let errors = 0;
  await resolveModelCatalog({ log: () => {}, error: () => errors++ }, async () => {
    throw new Error("boom");
  });
  assert.equal(errors, 0);
});

test("an EMPTY answer is a failure, not an empty picker", async () => {
  resetLiveModelCatalogCache();
  const models = await resolveModelCatalog(quiet, async () => []);
  assert.deepEqual(models, MODEL_CATALOG);
});

test("a non-array answer is a failure too (a vendor may change the shape)", async () => {
  resetLiveModelCatalogCache();
  const models = await resolveModelCatalog(quiet, async () => null);
  assert.deepEqual(models, MODEL_CATALOG);
});

test("a fallback is NEVER cached — the next session retries", async () => {
  // A CLI missing at the first session may be present at the second. Caching the
  // failure would keep the picker stale for the life of the process.
  resetLiveModelCatalogCache();
  let calls = 0;
  const failing = async () => {
    calls++;
    throw new Error("boom");
  };
  await resolveModelCatalog(quiet, failing);
  await resolveModelCatalog(quiet, failing);
  assert.equal(calls, 2, "the failing source must be retried, not memoised");
});

test("a SUCCESS is cached — one CLI spawn, not one per session", async () => {
  resetLiveModelCatalogCache();
  let calls = 0;
  const counting = async () => {
    calls++;
    return LIVE;
  };
  await resolveModelCatalog(quiet, counting);
  await resolveModelCatalog(quiet, counting);
  assert.equal(calls, 1);
});

test("a hung source cannot stall session creation forever", async () => {
  resetLiveModelCatalogCache();
  assert.ok(CATALOG_TIMEOUT_MS > 0 && CATALOG_TIMEOUT_MS <= 60_000, "the bound must be real and short");
  const models = await resolveModelCatalog(quiet, () => new Promise(() => {}));
  assert.deepEqual(models, MODEL_CATALOG);
}, { timeout: CATALOG_TIMEOUT_MS + 10_000 });

test("every returned row is one the source supplied — nothing is invented", async () => {
  resetLiveModelCatalogCache();
  const supplied = new Set(LIVE.map((m) => m.value));
  for (const m of await resolveModelCatalog(quiet, async () => LIVE)) {
    assert.ok(supplied.has(m.value), `${m.value} was not in the source`);
  }
});

test("the `default` row NAMES the model it resolves to, matching ACP and plus", async () => {
  // `default` ships its own description, which never says which model it IS today.
  // All three adapters replace it with the sibling row's title; a fork that skipped
  // this would render the same catalogue differently from the other two.
  resetLiveModelCatalogCache();
  const models = await resolveModelCatalog(quiet, async () => LIVE);
  assert.equal(models.find((m) => m.value === "default").description, "Opus 5.5");
});

test("`default` is left UNTOUCHED when no sibling resolves alongside it", async () => {
  resetLiveModelCatalogCache();
  const models = await resolveModelCatalog(quiet, async () => [
    { value: "default", displayName: "Default (recommended)", description: "keep me" },
    row("haiku", "Haiku 4.5", "claude-haiku-4-5"),
  ]);
  assert.equal(models.find((m) => m.value === "default").description, "keep me");
});
