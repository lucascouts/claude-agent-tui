// Story 032 / Task 2.2 — merge the hook entry preserving ALL existing user keys (R2.1, R2.2, R2.4).
//
// mergeHook(prior, group) folds the fork hook into an existing-or-absent settings object: every
// pre-existing key/value AND the user's own PreToolUse hooks survive, the fork hook is appended, and
// `prior` is never mutated. A null prior yields a minimal object with only the fork hook. Fully
// OFFLINE — pure object transform.
//
// node:test: build first, then
//   node --experimental-strip-types --test test/gate-merge.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as SW from "../dist/gate/settings-writer.js";

const FORK = () => SW.buildHookEntry(45678);

test("2.2 a null prior yields a minimal object with ONLY the fork hook (R2.2)", () => {
  const merged = SW.mergeHook(null, FORK());
  assert.deepEqual(Object.keys(merged), ["hooks"], "only the hooks key");
  const pre = (merged.hooks as { PreToolUse: unknown[] }).PreToolUse;
  assert.equal(pre.length, 1, "exactly the fork hook");
  assert.equal(SW.isForkHookGroup(pre[0]), true, "that one group is the fork hook");
});

test("2.2 an existing prior keeps EVERY unrelated key/value plus the user hook, and adds the fork hook", () => {
  const prior = {
    permissions: { allow: ["Read"], defaultMode: "default" },
    model: "claude-sonnet",
    env: { FOO: "bar" },
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }],
      PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "echo done" }] }],
    },
  };
  const merged = SW.mergeHook(prior, FORK());

  // every unrelated key/value preserved verbatim
  assert.deepEqual(merged.permissions, prior.permissions, "permissions preserved");
  assert.equal(merged.model, "claude-sonnet", "model preserved");
  assert.deepEqual(merged.env, prior.env, "env preserved");
  // the user's other hook event preserved
  assert.deepEqual(
    (merged.hooks as { PostToolUse: unknown }).PostToolUse,
    prior.hooks.PostToolUse,
    "PostToolUse preserved",
  );
  // PreToolUse: the user's own hook survives AND the fork hook is appended (R2.4)
  const pre = (merged.hooks as { PreToolUse: unknown[] }).PreToolUse;
  assert.equal(pre.length, 2, "user hook + fork hook");
  assert.deepEqual(pre[0], prior.hooks.PreToolUse[0], "user's own PreToolUse hook is intact and first");
  assert.equal(SW.isForkHookGroup(pre[1]), true, "the fork hook is appended");
  assert.equal(SW.isForkHookGroup(pre[0]), false, "the user's hook is NOT mistaken for the fork hook");
});

test("2.2 mergeHook does NOT mutate prior (deep-clone discipline)", () => {
  const prior = { a: 1, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [] }] } };
  const snapshot = structuredClone(prior);
  SW.mergeHook(prior, FORK());
  assert.deepEqual(prior, snapshot, "prior must be untouched after merge");
});

test("2.2 a prior with NO hooks block gets one created, user keys still intact", () => {
  const prior = { model: "x", permissions: { allow: [] } };
  const merged = SW.mergeHook(prior, FORK());
  assert.equal(merged.model, "x");
  assert.deepEqual(merged.permissions, { allow: [] });
  const pre = (merged.hooks as { PreToolUse: unknown[] }).PreToolUse;
  assert.equal(pre.length, 1);
  assert.equal(SW.isForkHookGroup(pre[0]), true);
});

test("2.2 re-merging is idempotent — the fork hook is not duplicated", () => {
  const once = SW.mergeHook({ model: "x" }, FORK());
  const twice = SW.mergeHook(once, FORK());
  const pre = (twice.hooks as { PreToolUse: unknown[] }).PreToolUse;
  const forkGroups = pre.filter((g) => SW.isForkHookGroup(g));
  assert.equal(forkGroups.length, 1, "re-injecting must not duplicate the fork hook");
  assert.equal(twice.model, "x", "user key still intact after a second merge");
});

test("2.2 a non-object prior root throws (a corrupt file is never clobbered blindly, R2.1)", () => {
  for (const bad of [[1, 2, 3], "scalar", 42]) {
    assert.throws(
      () => SW.mergeHook(bad as unknown as Record<string, unknown>, FORK()),
      /must be a JSON object/,
      `prior=${JSON.stringify(bad)} must throw`,
    );
  }
});
