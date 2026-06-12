// Story 028 / Sub-task 3.1 — SessionEngine.cleanup() cancels a pending background discovery (R3.1).
// node:test runner: `node --experimental-strip-types --test test/session-engine-discovery-abort.test.ts`
// (run `npm run build` first — behavioral imports resolve against ../dist).
//
// Sub-task 2.1 deferred the fresh-path transcript discovery into an unbounded (watchdogMs: Infinity)
// background poll, cancellable via an AbortController STORED on the engine (setPendingDiscovery). But
// 2.1 deliberately did NOT make cleanup() abort it — so a session torn down before its first
// interaction leaked the poll. 3.1 closes that: cleanup() aborts the stored controller, idempotently,
// before stopping the watcher, so an idle/closed pre-interaction session releases its background poll.
//
// RED driver: "cleanup() aborts the pending discovery" — on the pre-3.1 code cleanup() never calls
// ac.abort(), so signal.aborted stays false. The idle-teardown case and the teardownSession null-guard
// (the latter already shipped in 2.1) are regression guards.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionEngine } from "../dist/engine-lifecycle.js";
import { ClaudeAcpAgent } from "../dist/acp-agent.js";
import { makeFakePty, makeFakeWatcher } from "./lifecycle-fakes.ts";

test("cleanup() aborts a pending background discovery and still stops the watcher (R3.1)", () => {
  const { pty } = makeFakePty();
  const { watcher, stopCount } = makeFakeWatcher();
  const sessions = new Map<string, SessionEngine>();
  const eng = new SessionEngine({ handle: { sessionId: "S1", pty }, watcher, sessions });

  const ac = new AbortController();
  eng.setPendingDiscovery(ac);
  assert.equal(ac.signal.aborted, false, "the discovery poll is live before cleanup");

  eng.cleanup();

  assert.equal(ac.signal.aborted, true, "cleanup() aborts the pending discovery controller");
  assert.equal(stopCount(), 1, "the watcher is still stopped on cleanup");
  assert.equal(sessions.has("S1"), false, "the session-map entry is released");
  assert.equal(eng.isDisposed, true, "the engine reports disposed");
});

test("cleanup()'s discovery-abort is idempotent — a second cleanup does not throw (R3.1)", () => {
  const { pty } = makeFakePty();
  const { watcher, stopCount } = makeFakeWatcher();
  const eng = new SessionEngine({ handle: { sessionId: "S1", pty }, watcher });
  const ac = new AbortController();
  eng.setPendingDiscovery(ac);

  eng.cleanup();
  assert.doesNotThrow(() => eng.cleanup(), "a second cleanup is a no-op");

  assert.equal(ac.signal.aborted, true, "the controller stays aborted across the idempotent second call");
  assert.equal(stopCount(), 1, "the watcher is not stopped twice");
});

test("an idle pre-interaction session (pending discovery, NO watcher armed) tears down cleanly (R3.1)", () => {
  // A fresh session whose transcript never appeared: setPendingDiscovery ran, but the watcher was
  // never armed (it is undefined). cleanup() must abort the poll AND not throw on the absent watcher.
  const { pty } = makeFakePty();
  const sessions = new Map<string, SessionEngine>();
  const eng = new SessionEngine({ handle: { sessionId: "S1", pty }, sessions }); // no watcher
  const ac = new AbortController();
  eng.setPendingDiscovery(ac);

  assert.doesNotThrow(() => eng.cleanup(), "idle teardown does not throw on the absent watcher");
  assert.equal(ac.signal.aborted, true, "the background poll is aborted even with no watcher armed");
  assert.equal(sessions.has("S1"), false, "the session entry is released");
});

test("teardownSession's no-engine fallback null-guards an absent watcher (regression — shipped in 2.1)", async () => {
  // A session created via a fake startEngine that returns NO engine and NO watcher — the shape of a
  // fresh session torn down before its transcript appeared. dispose() → teardownSession takes the
  // no-engine fallback `session.watcher?.stop()`; the null-guard must keep it from throwing.
  const makeClient = () =>
    ({
      sessionUpdate: async () => {},
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      readTextFile: async () => ({ content: "" }),
      writeTextFile: async () => ({}),
    }) as never;
  const fakePty = makeFakePty().pty;
  const startEngine = (args: { sessionId?: string; cwd: string }) => ({
    sessionId: args.sessionId ?? "44444444-4444-4444-8444-444444444444",
    pty: fakePty,
    watcher: undefined, // never armed (fresh, pre-interaction) — the null-guard target
    cwd: args.cwd,
    // no `engine` → teardownSession takes the no-engine fallback branch
  });
  const agent = new ClaudeAcpAgent(makeClient(), undefined, undefined, {
    startEngine: startEngine as never,
  });

  await (
    agent as unknown as { createSession: (p: unknown) => Promise<{ sessionId: string }> }
  ).createSession({ cwd: "/host", mcpServers: [] });

  await assert.doesNotReject(
    () => agent.dispose(),
    "dispose tears down a no-engine/no-watcher session without throwing on the absent watcher",
  );
});
