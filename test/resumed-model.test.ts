import { test } from "node:test";
import assert from "node:assert/strict";
import { MODEL_CATALOG, resolveCatalogValueFromModelId } from "../dist/model-catalog.js";

// Story 081 / Task 1.1 — map a transcript's REAL model id onto a catalog `value`.
//
// A resumed session shows `Default` in Zed's selector because createSession seeds the model
// configOption from DEFAULT_MODEL_INFO.value (acp-agent.ts:3532) regardless of what the transcript
// used. Story 069 already reads the turn's true model on the same code path
// (acp-agent.ts:2767, `carrier.model`) but spends it only on contextWindowSize. This function is the
// missing half: real id -> catalog value, so the selector can be seeded from the same read.
//
// Shape mirrors inferContextWindowFromModelId (family match, total function, null for unknown):
// anything it cannot place must return null so the caller keeps the existing seed (R2.1).

const CATALOG_VALUES = new Set(MODEL_CATALOG.map((m) => m.value));

test("resolves each live family to a catalog value (R1.2)", () => {
  assert.equal(resolveCatalogValueFromModelId("claude-opus-4-8"), "opus");
  assert.equal(resolveCatalogValueFromModelId("claude-fable-5"), "fable5");
  assert.equal(resolveCatalogValueFromModelId("claude-sonnet-5"), "sonnet");
  assert.equal(resolveCatalogValueFromModelId("claude-haiku-4-5"), "haiku");
});

test("resolves dated snapshots by family, not exact id (R1.2)", () => {
  assert.equal(resolveCatalogValueFromModelId("claude-sonnet-4-5-20250929"), "sonnet");
  assert.equal(resolveCatalogValueFromModelId("claude-haiku-4-5-20251001"), "haiku");
  assert.equal(resolveCatalogValueFromModelId("claude-opus-4-6"), "opus");
});

test("tolerates the [1m] long-context suffix (R1.2)", () => {
  // `/model default` resolves to `claude-opus-4-8[1m]` (story 069) — the suffix must not defeat
  // the family match, or a resumed 1M session would fall back to `Default`.
  assert.equal(resolveCatalogValueFromModelId("claude-opus-4-8[1m]"), "opus");
  assert.equal(resolveCatalogValueFromModelId("claude-sonnet-5[1m]"), "sonnet");
});

test("every resolved value EXISTS in MODEL_CATALOG (no phantom entries)", () => {
  // The guard that matters: returning a value absent from the catalog would make Zed's selector
  // show an entry that cannot be selected. Assert against the catalog itself, never a literal list.
  for (const id of [
    "claude-opus-4-8",
    "claude-fable-5",
    "claude-sonnet-5",
    "claude-haiku-4-5",
    "claude-sonnet-4-5-20250929",
  ]) {
    const v = resolveCatalogValueFromModelId(id);
    assert.ok(v !== null, `${id} must resolve`);
    assert.ok(CATALOG_VALUES.has(v), `${id} -> "${v}" is not a MODEL_CATALOG value`);
  }
});

test("unknown / empty / non-string input returns null (R2.1 fail-safe)", () => {
  // null routes the caller to "leave the current seed alone" — the same shape story 069 uses on the
  // neighbouring line (`?? session.contextWindowSize`, never overwrite with null).
  assert.equal(resolveCatalogValueFromModelId(""), null);
  assert.equal(resolveCatalogValueFromModelId("gpt-4"), null);
  assert.equal(resolveCatalogValueFromModelId("claude-zzz-9"), null);
  assert.equal(resolveCatalogValueFromModelId(undefined as unknown as string), null);
  assert.equal(resolveCatalogValueFromModelId(null as unknown as string), null);
  assert.equal(resolveCatalogValueFromModelId(42 as unknown as string), null);
});

test("is a total function — never throws on hostile input", () => {
  for (const bad of [{}, [], NaN, Infinity, Symbol("x")]) {
    assert.doesNotThrow(() => resolveCatalogValueFromModelId(bad as unknown as string));
  }
});

// --- Task 2.1 — the selector reconcile on the story-069 read site ----------------------------
//
// emitTurnUpdates is shared by the LIVE pump and the `session/load` replay, so the reconcile must
// fire on a resumed transcript AND stay silent when nothing changed — otherwise every live turn
// would re-emit a config_option_update. These tests assert the EMISSION COUNT, which is what
// catches that.

import { ClaudeAcpAgent } from "../dist/acp-agent.js";
import { MODEL_CATALOG as CATALOG, DEFAULT_MODEL_INFO } from "../dist/model-catalog.js";

function agentWithSession(seedModel = DEFAULT_MODEL_INFO.value) {
  const updates = [];
  const agent = new ClaudeAcpAgent(
    { sessionUpdate: async (u) => { updates.push(u); } },
    console,
  );
  agent.sessions["s-1"] = {
    emitted: new Set(),
    emittedNested: new Set(),
    toolUseCache: {},
    usageDisabled: true, // suppress usage_update noise; the 069/081 read sits before it
    contextWindowSize: 200_000,
    modes: { currentModeId: "default", availableModes: [] },
    modelInfos: CATALOG,
    agents: [],
    configOptions: [{ id: "model", currentValue: seedModel }],
  };
  return { agent, updates };
}

const turnWith = (model) => ({
  message: { message: { role: "assistant", content: [], ...(model ? { model } : {}) } },
});

test("resumed transcript on another model reseeds the selector and emits ONCE (R1.1)", async () => {
  const { agent, updates } = agentWithSession("default");
  await agent.emitTurnUpdates("s-1", turnWith("claude-fable-5"), {});
  const modelOpt = agent.sessions["s-1"].configOptions.find((o) => o.id === "model");
  assert.equal(modelOpt.currentValue, "fable5", "selector must follow the transcript");
  const emitted = updates.filter((u) => u.update?.sessionUpdate === "config_option_update");
  assert.equal(emitted.length, 1, "exactly one config_option_update per real change");
});

test("`default` facing a claude-opus transcript emits NOTHING (R1.3 equivalence)", async () => {
  const { agent, updates } = agentWithSession("default");
  await agent.emitTurnUpdates("s-1", turnWith("claude-opus-4-8"), {});
  const modelOpt = agent.sessions["s-1"].configOptions.find((o) => o.id === "model");
  assert.equal(modelOpt.currentValue, "default", "`default` IS opus — leave it alone");
  assert.equal(
    updates.filter((u) => u.update?.sessionUpdate === "config_option_update").length,
    0,
    "no visible change => no emission",
  );
});

test("same model twice does not re-emit (live-path storm guard)", async () => {
  const { agent, updates } = agentWithSession("default");
  await agent.emitTurnUpdates("s-1", turnWith("claude-fable-5"), {});
  await agent.emitTurnUpdates("s-1", turnWith("claude-fable-5"), {});
  await agent.emitTurnUpdates("s-1", turnWith("claude-fable-5"), {});
  assert.equal(
    updates.filter((u) => u.update?.sessionUpdate === "config_option_update").length,
    1,
    "three turns on one model must emit once, not three times",
  );
});

test("missing / blank / unknown model leaves the seed untouched (R2.1)", async () => {
  for (const m of [undefined, "", "gpt-4", "claude-zzz-9"]) {
    const { agent, updates } = agentWithSession("default");
    await agent.emitTurnUpdates("s-1", turnWith(m), {});
    const modelOpt = agent.sessions["s-1"].configOptions.find((o) => o.id === "model");
    assert.equal(modelOpt.currentValue, "default", `model=${JSON.stringify(m)} must not reseed`);
    assert.equal(
      updates.filter((u) => u.update?.sessionUpdate === "config_option_update").length,
      0,
      `model=${JSON.stringify(m)} must not emit`,
    );
  }
});

test("the reconcile does not disturb story 069's contextWindowSize (R2.2)", async () => {
  const { agent } = agentWithSession("default");
  agent.sessions["s-1"].usageDisabled = false;
  const before = agent.sessions["s-1"].contextWindowSize;
  await agent.emitTurnUpdates("s-1", turnWith("claude-haiku-4-5"), {});
  assert.equal(
    agent.sessions["s-1"].contextWindowSize,
    200_000,
    "069 still resolves the window from the same read",
  );
  assert.ok(typeof before === "number");
});

// --- Task 3.1 — the scope decision, as an executable guard ------------------------------------
//
// Story 081 deliberately does NOT add `--model` to the resume argv (see story.md "Scope decision"):
// the corpus measurement showed 36/38 resumed windows preserving their model, `buildResumeArgv` is
// the fork's most sensitive path, and an unwarranted `--model` could override a legitimate
// mid-session switch. This test makes that decision cost something to reverse silently.

import { buildResumeArgv } from "../dist/engine-lifecycle.js";

test("buildResumeArgv carries NO --model (R3.2 scope decision)", () => {
  const [flag, script] = buildResumeArgv("sess-1", "acceptEdits", "high", "reviewer", undefined, undefined);
  assert.equal(flag, "-c");
  assert.ok(!/--model/.test(script), "story 081 is display-only — no --model on the resume argv");
  assert.match(script, /claude --resume "sess-1"/);
  assert.match(script, /--permission-mode acceptEdits/);
  assert.match(script, /--effort high/);
  assert.match(script, /--agent "reviewer"/);
});

test("buildResumeArgv is byte-identical to its pre-081 output (characterization)", () => {
  assert.deepEqual(
    buildResumeArgv("abc", undefined, undefined, undefined, undefined, undefined),
    ["-c", 'claude --resume "abc" || claude'],
    "the bare form must not drift",
  );
  assert.deepEqual(
    buildResumeArgv("abc", "plan", "low", undefined, undefined, undefined),
    ["-c", 'claude --resume "abc" --permission-mode plan --effort low || claude --permission-mode plan --effort low'],
    "flags must reach BOTH halves, unchanged",
  );
});
