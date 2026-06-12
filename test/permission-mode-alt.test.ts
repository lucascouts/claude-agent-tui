// Story 033 / Task 3.2 — the --permission-mode acceptEdits/bypassPermissions deny-only alternative:
// the spawn flag, the deny-only matcher, and the unchanged-billing guard-rail (R4.1, R4.2).
//
// OFFLINE: pure functions over the flag/matcher/guard; no spawn, no claude. The guard-rail re-assertion
// reuses the story-022 entrypoint guard (never spoofs, aborts on a credit-class label).
//
// node:test: build first, then
//   node --experimental-strip-types --test test/permission-mode-alt.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertEntrypointCli,
  denyOnlyShouldDeny,
  permissionModeFlag,
  reassertBillingGuard,
  type DenyOnlyPolicy,
} from "../dist/permissions/permission-mode.js";
import type { GuardHooks, WatchedMessage } from "../dist/billing/entrypoint-guard.js";

test("3.2 acceptEdits → the spawn argv carries --permission-mode acceptEdits", () => {
  assert.deepEqual(permissionModeFlag("acceptEdits"), ["--permission-mode", "acceptEdits"]);
});

test("3.2 bypassPermissions → the spawn argv carries --permission-mode bypassPermissions", () => {
  assert.deepEqual(permissionModeFlag("bypassPermissions"), ["--permission-mode", "bypassPermissions"]);
});

test("3.2 an unsupported mode throws (never silently selects a non-gating flag)", () => {
  // @ts-expect-error — exercising the runtime guard with an invalid mode
  assert.throws(() => permissionModeFlag("plan"), /unsupported alternative permission mode/);
});

test("3.2 the flag is interactive-only: it adds NO -p/stream-json (billing unchanged)", () => {
  const [flag, mode] = permissionModeFlag("acceptEdits");
  assert.equal(flag, "--permission-mode");
  assert.equal(mode, "acceptEdits");
  // The fragment must not smuggle a print/stream-json token that would flip billing to credit. Match
  // WHOLE tokens (not a substring — "--permission-mode" legitimately contains "-p").
  const creditToken = (t: string) => t === "-p" || t === "--print" || /stream-json/.test(t);
  assert.ok(![flag, mode].some(creditToken), "no credit-path token");
});

test("3.2 the deny-only hook denies a dangerous tool and auto-approves the rest", () => {
  const policy: DenyOnlyPolicy = { denyMatchers: ["Bash", "Edit"] };
  assert.equal(denyOnlyShouldDeny(policy, "Bash"), true, "dangerous tool is denied");
  assert.equal(denyOnlyShouldDeny(policy, "Edit"), true);
  assert.equal(denyOnlyShouldDeny(policy, "Read"), false, "a safe tool auto-approves (not denied)");
  assert.equal(denyOnlyShouldDeny(policy, "Glob"), false);
});

test("3.2 a '*' deny-only matcher denies everything (the safest deny-only posture)", () => {
  const policy: DenyOnlyPolicy = { denyMatchers: ["*"] };
  assert.equal(denyOnlyShouldDeny(policy, "Bash"), true);
  assert.equal(denyOnlyShouldDeny(policy, "Read"), true);
});

test("3.2 an empty deny-only policy denies nothing (pure auto-approve)", () => {
  const policy: DenyOnlyPolicy = { denyMatchers: [] };
  assert.equal(denyOnlyShouldDeny(policy, "Bash"), false);
});

// ── billing guard-rail re-assertion (§10 / story 022) — UNCHANGED under the alternative mode ──

test("3.2 the guard-rail PASSES a cli entrypoint (subscription) — the alternative does not change billing", () => {
  const event: WatchedMessage = { type: "assistant", entrypoint: "cli", sessionId: "s1" };
  const result = assertEntrypointCli(event);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.entrypoint, "cli");
});

test("3.2 the guard-rail ABORTS on a sdk-ts entrypoint (credit) — never proceeds, never spoofs to cli", () => {
  const event: WatchedMessage = { type: "assistant", entrypoint: "sdk-ts", sessionId: "s1" };
  const result = assertEntrypointCli(event);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.entrypoint, "sdk-ts", "the observed entrypoint is named, not rewritten");
  assert.match(result.ok === false ? result.reason : "", /API credit/);
  assert.match(result.ok === false ? result.reason : "", /NOT being rewritten/);
});

test("3.2 the guard-rail ABORTS on a print entrypoint (credit)", () => {
  const result = assertEntrypointCli({ type: "user", entrypoint: "print", sessionId: "s1" });
  assert.equal(result.ok, false);
});

test("3.2 a missing entrypoint on a billable event is conservatively ABORTED (unknown → abort)", () => {
  const result = assertEntrypointCli({ type: "assistant", sessionId: "s1" });
  assert.equal(result.ok, false, "an unknown/missing entrypoint must not bill silently");
});

test("3.2 a lightweight (non-billable) event is not aborted (skip → proceed)", () => {
  const result = assertEntrypointCli({ type: "summary", sessionId: "s1" });
  assert.equal(result.ok, true, "a lightweight type is skipped, not aborted");
});

test("3.2 reassertBillingGuard stops the session on a credit label via the injected hooks (live-pump path)", () => {
  const stops: { entrypoint: string }[] = [];
  let alerted = "";
  const hooks: GuardHooks = {
    alert: (m) => (alerted = m),
    stopSession: (info) => stops.push({ entrypoint: info.entrypoint }),
  };
  const decision = reassertBillingGuard({ type: "assistant", entrypoint: "sdk-py", sessionId: "s1" }, hooks);
  assert.equal(decision.action, "abort");
  assert.equal(stops.length, 1, "the session is stopped on a credit label");
  assert.equal(stops[0].entrypoint, "sdk-py", "the observed entrypoint is passed through (not spoofed)");
  assert.match(alerted, /BLOCKED/);
});

test("3.2 reassertBillingGuard is a silent no-op on a cli label (subscription)", () => {
  const stops: unknown[] = [];
  const hooks: GuardHooks = {
    alert: () => stops.push("alert"),
    stopSession: () => stops.push("stop"),
  };
  const decision = reassertBillingGuard({ type: "assistant", entrypoint: "cli", sessionId: "s1" }, hooks);
  assert.equal(decision.action, "allow");
  assert.equal(stops.length, 0, "a subscription label triggers no side effect");
});
