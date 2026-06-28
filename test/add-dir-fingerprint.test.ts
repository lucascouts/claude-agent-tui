// Story 057 / sub-task 1.2 — createSession resolves the additional-directory list (always-on, no env
// gate), threads it to the spawn engine, stores it on the session record, and folds the SORTED set
// into the session fingerprint so a changed `--add-dir` set forces a re-spawn (R1.3) while a
// reordered-but-equal set does not. The `_meta.additionalRoots` legacy fallback is honored (R3.1).
//
// AGENT INTEGRATION over the startEngine seam (createSession-spawn / agent-respawn precedent): the
// injected fake startEngine captures `args.additionalDirectories`, and the stored fingerprint is read
// off the real `agent.sessions` record — both are exercised through the REAL createSession, so the
// resolve→thread→store→fingerprint wiring is proven end-to-end (computeSessionFingerprint is private,
// so the fingerprint is asserted via its stored value, per the design's "via the fingerprint" option).
// node:test (build first — behavioral imports resolve against ../dist):
//   node --experimental-strip-types --test test/add-dir-fingerprint.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeAcpAgent } from "../dist/acp-agent.js";

/** Minimal ACP client stub — every method the agent may call on construction/createSession. */
function makeClient() {
  return {
    sessionUpdate: async () => {},
    requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    readTextFile: async () => ({ content: "" }),
    writeTextFile: async () => ({}),
  } as never;
}

/** A fake PTY: satisfies the handle shape used by createSession; records nothing of substance. */
function makeFakePty() {
  return {
    onExit: () => ({ dispose() {} }),
    onData: () => ({ dispose() {} }),
    resize: () => {},
    write: () => {},
    kill: () => {},
  } as never;
}

/** Captured startEngine args — call 1 is the createSession spawn. We record additionalDirectories so
 *  the "resolved list reaches the engine" assertion is load-bearing. */
type Captured = { sessionId?: string; cwd: string; additionalDirectories?: string[] };

function makeStartEngine() {
  const calls: Captured[] = [];
  const startEngine = (args: {
    sessionId?: string;
    cwd: string;
    additionalDirectories?: string[];
  }) => {
    calls.push({
      sessionId: args.sessionId,
      cwd: args.cwd,
      additionalDirectories: args.additionalDirectories,
    });
    return {
      sessionId: args.sessionId ?? "11111111-1111-4111-8111-111111111111",
      pty: makeFakePty(),
      watcher: { stop: () => {}, notifyEndOfTurn: () => {} },
      cwd: args.cwd,
    };
  };
  return { startEngine, calls };
}

/** Construct an agent with the injected startEngine seam, create one session with `params`, and
 *  return the captured spawn args + the stored session record (carrying additionalDirectories +
 *  sessionFingerprint). Mirrors the createSession-spawn / agent-respawn harness shape. */
async function createWith(
  t: Parameters<NonNullable<Parameters<typeof test>[0]>>[0],
  params: Record<string, unknown>,
) {
  const fake = makeStartEngine();
  const agent = new ClaudeAcpAgent(makeClient(), undefined, undefined, {
    startEngine: fake.startEngine,
  });
  t.after(() => agent.dispose());
  const response = await (
    agent as unknown as {
      createSession: (p: unknown, o?: unknown) => Promise<{ sessionId: string }>;
    }
  ).createSession(params);
  const sessions = (
    agent as unknown as {
      sessions: Record<
        string,
        { additionalDirectories?: string[]; sessionFingerprint: string }
      >;
    }
  ).sessions;
  return { call: fake.calls[0], record: sessions[response.sessionId] };
}

test("the resolved additionalDirectories list REACHES startEngine and is stored on the session record", async (t) => {
  const dirs = ["/work/a", "/work/b"];
  const { call, record } = await createWith(t, {
    cwd: "/work/dir",
    mcpServers: [],
    additionalDirectories: dirs,
  });

  assert.deepEqual(
    call.additionalDirectories,
    dirs,
    "the resolved additional-directory list must reach startEngine (→ --add-dir on the spawn)",
  );
  assert.deepEqual(
    record.additionalDirectories,
    dirs,
    "the resolved list must be stored on the session record (sub-task 2.3 re-threads it)",
  );
});

test("the fingerprint DIFFERS when the additional-directory set differs", async (t) => {
  const a = await createWith(t, {
    cwd: "/work",
    mcpServers: [],
    additionalDirectories: ["/work/a"],
  });
  const b = await createWith(t, {
    cwd: "/work",
    mcpServers: [],
    additionalDirectories: ["/work/a", "/work/b"],
  });

  assert.notEqual(
    a.record.sessionFingerprint,
    b.record.sessionFingerprint,
    "a changed --add-dir set must change the fingerprint (→ forces a re-spawn, R1.3)",
  );
});

test("EQUAL sets in a DIFFERENT input order produce the SAME fingerprint (sorted-equal)", async (t) => {
  const a = await createWith(t, {
    cwd: "/work",
    mcpServers: [],
    additionalDirectories: ["/work/a", "/work/b"],
  });
  const b = await createWith(t, {
    cwd: "/work",
    mcpServers: [],
    additionalDirectories: ["/work/b", "/work/a"],
  });

  assert.equal(
    a.record.sessionFingerprint,
    b.record.sessionFingerprint,
    "a reordered-but-equal set must NOT change the fingerprint (the set is sorted, R1.3)",
  );
});

test("the empty/absent dir set yields the SAME fingerprint as an explicit empty list", async (t) => {
  const absent = await createWith(t, { cwd: "/work", mcpServers: [] });
  const empty = await createWith(t, {
    cwd: "/work",
    mcpServers: [],
    additionalDirectories: [],
  });

  assert.equal(
    absent.record.sessionFingerprint,
    empty.record.sessionFingerprint,
    "an absent additionalDirectories resolves to [] — same fingerprint as an explicit empty list",
  );
});

test("the _meta.additionalRoots FALLBACK is honored when additionalDirectories is absent (R3.1)", async (t) => {
  const roots = ["/work/x", "/work/y"];
  const { call, record } = await createWith(t, {
    cwd: "/work",
    mcpServers: [],
    _meta: { additionalRoots: roots },
  });

  assert.deepEqual(
    call.additionalDirectories,
    roots,
    "with additionalDirectories absent, the resolved list falls back to _meta.additionalRoots",
  );
  assert.deepEqual(
    record.additionalDirectories,
    roots,
    "the _meta.additionalRoots fallback is the list stored on the session record",
  );

  // The fallback must also drive the fingerprint identically to the equivalent top-level field — i.e.
  // additionalDirectories:[x,y] and _meta.additionalRoots:[x,y] fingerprint the same (single resolve).
  const direct = await createWith(t, {
    cwd: "/work",
    mcpServers: [],
    additionalDirectories: roots,
  });
  assert.equal(
    record.sessionFingerprint,
    direct.record.sessionFingerprint,
    "the _meta.additionalRoots fallback must fold into the fingerprint exactly like the top-level field",
  );
});

test("the top-level additionalDirectories takes PRECEDENCE over _meta.additionalRoots", async (t) => {
  const { call } = await createWith(t, {
    cwd: "/work",
    mcpServers: [],
    additionalDirectories: ["/top/level"],
    _meta: { additionalRoots: ["/meta/root"] },
  });

  assert.deepEqual(
    call.additionalDirectories,
    ["/top/level"],
    "additionalDirectories ?? _meta.additionalRoots — the top-level field wins when both are present",
  );
});
