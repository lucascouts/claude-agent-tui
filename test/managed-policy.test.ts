// Port of upstream #1146 (58c5db1) — reading the managed-policy tier must never stop the agent from
// starting. index.ts used to `await resolveSettings(...)` at module scope with nothing around it, and
// before the `unhandledRejection` handler was registered, so a transient EINTR/EMFILE/EAGAIN while
// reading the tier aborted ESM module evaluation: the process exited 1 before any ACP traffic and Zed
// saw only a dead agent. The read now lives in `applyManagedPolicyEnv` (src/managed-policy.ts), which
// is best-effort — it logs to stderr and returns, leaving the agent running with no policy env.
//
// node:test runner: `npm run build` first (the behavioural import resolves against ../dist), then
//   node --experimental-strip-types --test test/managed-policy.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

// Imported lazily so each case reports its own failure when the module is missing (the pre-fix tree).
const load = async () => import("../dist/managed-policy.js");

test("a rejecting resolveSettings resolves, logs to stderr, and leaves env untouched", async () => {
  const { applyManagedPolicyEnv } = await load();
  const env: Record<string, string | undefined> = { KEEP: "1" };
  const logged: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args);
  };
  const failure = Object.assign(new Error("interrupted system call"), { code: "EINTR" });
  try {
    await assert.doesNotReject(
      applyManagedPolicyEnv((async () => {
        throw failure;
      }) as never, env),
    );
  } finally {
    console.error = original;
  }
  assert.deepEqual(env, { KEEP: "1" }, "no policy env is applied on failure");
  assert.equal(logged.length, 1, "the failure is reported once, on stderr");
  assert.ok(logged[0].includes(failure), "the error itself is logged, for diagnosis");
});

test("a resolved policy copies its env onto the target env", async () => {
  const { applyManagedPolicyEnv } = await load();
  const env: Record<string, string | undefined> = { KEEP: "1", OVERRIDE: "old" };
  const calls: unknown[] = [];
  await applyManagedPolicyEnv((async (opts: unknown) => {
    calls.push(opts);
    return { effective: { env: { OVERRIDE: "new", ADDED: "x" } } };
  }) as never, env);
  assert.deepEqual(calls, [{ settingSources: [] }], "only the managed tier is read");
  assert.deepEqual(env, { KEEP: "1", OVERRIDE: "new", ADDED: "x" });
});

test("a policy with no env leaves the target env untouched", async () => {
  const { applyManagedPolicyEnv } = await load();
  const env: Record<string, string | undefined> = { KEEP: "1" };
  await applyManagedPolicyEnv((async () => ({ effective: {} })) as never, env);
  assert.deepEqual(env, { KEEP: "1" });
});

test("index.ts no longer awaits resolveSettings bare at module scope", () => {
  const src = readFileSync(join(here, "..", "src", "index.ts"), "utf8");
  assert.doesNotMatch(src, /await\s+resolveSettings\s*\(/, "the bare module-scope await is gone");
  assert.match(src, /await\s+applyManagedPolicyEnv\s*\(\s*\)/, "the entry point goes through the helper");
});
