// Story 046 / Task 2.1 — the static curated model catalog (R1.1, R2.1).
//
// CONTRACT (story.md R1.1 / R2.1 + design.md §5/§7): a new `model-catalog.ts` exports a static
// curated `ModelInfo[]` of TUI-accepted aliases — `default`, `fable5`, `opus`, `sonnet`, `haiku` —
// replacing the single static `[DEGRAU1_DEFAULT_MODEL_INFO]`. `default` stays a safe fallback entry.
// Effort-capable entries declare `supportsEffort` + a non-empty `supportedEffortLevels` (which is what
// unlocks the effort selector via `buildConfigOptions`, design §7). This file pins the catalog as a
// pure data contract — no spawn, no agent, no claude.
//
// node:test runner (build first): `node --experimental-strip-types --test test/model-catalog.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MODEL_CATALOG } from "../dist/model-catalog.js";

// Story 009 R5.2 added `fable51`: the Claude 5 family's newest member LEADS `fable5`, so the
// contract is still exact order + exact membership, with one more member.
const EXPECTED_ALIASES = ["default", "fable51", "fable5", "opus", "sonnet", "haiku"];

test("2.1 catalog: exports more than the single static entry (R1.1 — was 1 item)", () => {
  assert.ok(Array.isArray(MODEL_CATALOG), "MODEL_CATALOG is an array of ModelInfo");
  assert.ok(MODEL_CATALOG.length > 1, `the catalog must have >1 entry, got ${MODEL_CATALOG.length}`);
});

test("2.1 catalog: every curated TUI alias is present by `value` (R1.1)", () => {
  const values = MODEL_CATALOG.map((m) => m.value);
  for (const alias of EXPECTED_ALIASES) {
    assert.ok(values.includes(alias), `expected catalog alias '${alias}' in: ${values.join(", ")}`);
  }
});

test("2.1 catalog: `default` is retained as a safe fallback entry (R1.1)", () => {
  const def = MODEL_CATALOG.find((m) => m.value === "default");
  assert.ok(def, "the `default` fallback entry must remain in the catalog");
  assert.equal(typeof def!.displayName, "string", "the default entry carries a displayName");
});

test("2.1 catalog: every entry has a value + displayName (the configOption `select` shape)", () => {
  for (const m of MODEL_CATALOG) {
    assert.equal(typeof m.value, "string", `entry value is a string: ${JSON.stringify(m)}`);
    assert.ok(m.value.length > 0, `entry value is non-empty: ${JSON.stringify(m)}`);
    assert.equal(typeof m.displayName, "string", `entry displayName is a string: ${JSON.stringify(m)}`);
  }
});

test("2.1 catalog: at least one entry declares effort support — unlocks the effort selector (R2.1)", () => {
  const effortCapable = MODEL_CATALOG.filter((m) => m.supportsEffort === true);
  assert.ok(
    effortCapable.length >= 1,
    "at least one catalog model must declare supportsEffort so the effort option can surface (R2.1)",
  );
  for (const m of effortCapable) {
    assert.ok(
      Array.isArray(m.supportedEffortLevels) && m.supportedEffortLevels.length > 0,
      `an effort-capable model must list non-empty supportedEffortLevels: ${JSON.stringify(m)}`,
    );
  }
});

test("2.1 catalog: a non-effort model does NOT advertise effort levels (effort stays hidden for it)", () => {
  // `haiku` is the genuine non-effort model — it must not claim effort support, else the effort
  // selector would appear for a model that can't honor it. (Story 056: `default` NOW
  // advertises effort for v0.52 parity — pinned by model-catalog-effort.test.ts.)
  const haiku = MODEL_CATALOG.find((m) => m.value === "haiku");
  assert.ok(haiku, "haiku entry present");
  assert.notEqual(haiku!.supportsEffort, true, "a genuine non-effort model (`haiku`) must not declare effort support");
});
