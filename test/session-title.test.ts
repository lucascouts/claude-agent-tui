// Task 3.2 (R5.2, R5.3) — derive the session title from `getSessionInfo`, the
// disk-reading fallback; `query.generateSessionTitle` is CUT (§15.7, D4).
//
// Authored test-first from the requirement. FLAT in test/ (the runner globs
// `test/*.test.ts` and skips subdirectories silently).
//
// What is already true, and therefore NOT what this file is for: story 056 (#812)
// already pushes a sanitized title at the end-of-turn boundary, and
// test/session-title-push.test.ts covers that. Repeating it here would author a
// file that is green on arrival. What #984 ADDS is that the title is derived from
// what `getSessionInfo` returns — which is a title AND the disk record it came
// from. Upstream publishes `updatedAt: new Date(info.lastModified).toISOString()`
// beside the title; a push that drops it has taken the summary from disk without
// taking the record, and a client cannot order two sessions' titles.
//
// The identity halves, hostile first:
//   1. WRONGLY COLLAPSED: two sessions whose disk summaries are the SAME string
//      must each publish their own title. A dedup latch held on the agent rather
//      than per session merges two sessions into one, and the second session
//      never gets a title at all.
//   2. WRONGLY SPLIT: two disk summaries that sanitize to the SAME title are one
//      title, published once. The published string is a value this port DERIVES
//      (whitespace collapsed, newlines gone), so its identity is the sanitized
//      form, not the raw summary — asserted in its own right because no wording
//      in R5.2 describes it.
//   3. Then the benign fixtures: a title on disk is published; an absent one
//      invents nothing.
//
// HERMETIC: `getSessionInfo` is the injected deps seam (never touches ~/.claude),
// and the turn is driven through the fake clock, exactly as the story-056 suite does.
//
// node:test (build first):
//   npm test   —  or  node --experimental-strip-types --test test/session-title.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeAcpAgent } from "../dist/acp-agent.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CWD = "/work/proj";

/** Deterministic clock shared by sendPrompt's \r delay and the turn resolver. */
function makeClock() {
  let now = 0;
  const timers: Array<{ at: number; fn: () => void; cancelled: boolean }> = [];
  const schedule = (fn: () => void, ms: number) => {
    const t = { at: now + ms, fn, cancelled: false };
    timers.push(t);
    return () => {
      t.cancelled = true;
    };
  };
  const advance = (ms: number) => {
    now += ms;
    for (const t of [...timers].sort((a, b) => a.at - b.at)) {
      if (!t.cancelled && t.at <= now) {
        t.cancelled = true;
        t.fn();
      }
    }
  };
  return { schedule, advance };
}

function rejectAfter(ms: number): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`prompt did not resolve within ${ms}ms`)), ms).unref?.(),
  ) as Promise<never>;
}

type Update = {
  sessionId: string;
  update: { sessionUpdate: string; title?: string | null; updatedAt?: string | null };
};

function makeAgent(deps: any = {}) {
  const updates: Update[] = [];
  const client: any = {
    async sessionUpdate(u: Update) {
      updates.push(u);
    },
  };
  const agent: any = new ClaudeAcpAgent(client, console, undefined, deps);
  return { agent, updates };
}

function fakePty() {
  return {
    write: () => {},
    onData: () => ({ dispose() {} }),
    onExit: () => ({ dispose() {} }),
    kill: () => {},
    resize: () => {},
  };
}

function injectSession(agent: any, sid: string) {
  agent.sessions[sid] = {
    pty: fakePty(),
    emitted: new Set(),
    emittedNested: new Set(),
    cancelled: false,
    cwd: CWD,
    toolUseCache: {},
    guardChecked: false,
    settingsManager: { dispose() {} },
    watcher: undefined,
  };
  return agent.sessions[sid];
}

const asst = (stop_reason: unknown, uuid: string) => ({
  type: "assistant",
  uuid,
  message: { stop_reason },
});

/** Drive ONE real end-of-turn: submit → terminal boundary → Δt quiescence. */
async function runTurn(agent: any, advance: (ms: number) => void, sid: string, uuid: string) {
  const session = agent.sessions[sid];
  const p = agent.prompt({ sessionId: sid, prompt: [{ type: "text", text: "hi" }] });
  await Promise.resolve();
  session.turnDetector.observe(asst("end_turn", uuid));
  advance(200);
  await Promise.race([p, rejectAfter(2000)]);
  await new Promise((r) => setTimeout(r, 0)); // drain the fire-and-forget push
}

const titlePushes = (updates: Update[]) =>
  updates.filter((u) => u.update?.sessionUpdate === "session_info_update");

// ── The disk record, not just the disk string ────────────────────────────────

test("3.2 a title present on disk is published WITH the disk record it came from (R5.2)", async () => {
  const { schedule, advance } = makeClock();
  const lastModified = Date.parse("2026-08-28T12:34:56.000Z");
  const { agent, updates } = makeAgent({
    schedule,
    getSessionInfo: async () => ({ summary: "  Close the\n  parity backlog ", lastModified }),
  });
  injectSession(agent, "sess-984-a");

  await runTurn(agent, advance, "sess-984-a", "u1");

  const pushes = titlePushes(updates);
  assert.equal(pushes.length, 1, `exactly one session_info_update, got ${pushes.length}`);
  assert.equal(pushes[0].update.title, "Close the parity backlog", "the sanitized disk summary");
  assert.equal(
    pushes[0].update.updatedAt,
    new Date(lastModified).toISOString(),
    "the title is derived from getSessionInfo, so it carries that record's timestamp",
  );
});

// ── Hostile half 1 — two sessions, one disk string ───────────────────────────

test("3.2 two sessions with the SAME disk summary each publish their own title (R5.2)", async () => {
  const { schedule, advance } = makeClock();
  const { agent, updates } = makeAgent({
    schedule,
    getSessionInfo: async () => ({ summary: "Shared summary", lastModified: 1_700_000_000_000 }),
  });
  injectSession(agent, "sess-984-b1");
  injectSession(agent, "sess-984-b2");

  await runTurn(agent, advance, "sess-984-b1", "u1");
  await runTurn(agent, advance, "sess-984-b2", "u2");

  const pushes = titlePushes(updates);
  assert.equal(pushes.length, 2, "dedup is per session; two sessions are not one");
  assert.deepEqual(
    pushes.map((p) => p.sessionId).sort(),
    ["sess-984-b1", "sess-984-b2"],
    "each push targets its own session",
  );
});

// ── Hostile half 2 — one title, two spellings on disk ────────────────────────

test("3.2 two summaries that sanitize to the SAME title publish once (R5.2)", async () => {
  const { schedule, advance } = makeClock();
  const summaries = ["Close the parity backlog", "Close   the\n\nparity  backlog"];
  let i = 0;
  const { agent, updates } = makeAgent({
    schedule,
    getSessionInfo: async () => ({
      summary: summaries[Math.min(i++, summaries.length - 1)],
      lastModified: 1_700_000_000_000 + i,
    }),
  });
  injectSession(agent, "sess-984-c");

  await runTurn(agent, advance, "sess-984-c", "u1");
  await runTurn(agent, advance, "sess-984-c", "u2");

  const pushes = titlePushes(updates);
  assert.equal(pushes.length, 1, "the published title is the sanitized form; that is its identity");
  assert.equal(pushes[0].update.title, "Close the parity backlog");
});

// ── Benign — nothing on disk invents nothing ─────────────────────────────────

test("3.2 no transcript on disk → the title is left unset (R5.2)", async () => {
  const { schedule, advance } = makeClock();
  const { agent, updates } = makeAgent({ schedule, getSessionInfo: async () => undefined });
  injectSession(agent, "sess-984-d");

  await runTurn(agent, advance, "sess-984-d", "u1");

  assert.equal(titlePushes(updates).length, 0, "no transcript → no title, and never a placeholder");
});

test("3.2 an empty summary on disk → the title is left unset (R5.2)", async () => {
  const { schedule, advance } = makeClock();
  const { agent, updates } = makeAgent({
    schedule,
    getSessionInfo: async () => ({ summary: "   \n  ", lastModified: 1_700_000_000_000 }),
  });
  injectSession(agent, "sess-984-e");

  await runTurn(agent, advance, "sess-984-e", "u1");

  assert.equal(titlePushes(updates).length, 0, "whitespace is not a title");
});

// ── The port states its own limit ────────────────────────────────────────────

test("3.2 the code states this is upstream's degraded path (R5.3)", () => {
  // §15.7 / D4: only the disk-reading fallback ports. Code that does not say so
  // implies a parity this adapter does not have.
  const source = readFileSync(join(HERE, "..", "src", "acp-agent.ts"), "utf8");
  // assert.ok, not assert.match: a failing match on a 220 KB source dumps the
  // whole file into the report and buries the reason.
  assert.ok(
    /generateSessionTitle/.test(source),
    "acp-agent.ts must name query.generateSessionTitle as the part that is CUT",
  );
  assert.ok(
    /degraded|fallback only|CUT/.test(source),
    "acp-agent.ts must say the ported path is upstream's degraded one",
  );
});
