import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeAcpAgent } from "../dist/acp-agent.js";

// Story 025 / Task 4.2 (R4.2, R4.3) — large-load throughput integration test. Feeds a recorded
// large-fixture transcript (a burst of hundreds-to-thousands of message events) through the
// update pump and asserts the FORK side of §11: every linearized event yields EXACTLY ONE
// ordered session/update (no internal drop / merge / reorder); the run injects NO ACP-side
// input (the burst is read-only — the PTY is never written to); and the §10 entrypoint=='cli'
// billing guard-rail stays GREEN over the whole fixture. The user's Zed THROTTLE verdict
// (R4.1) and any chunking remedy are the empirical probe recorded in FORK.md (Task 4.1); this
// test guarantees 026's replay path starts from a clean one-update-per-event baseline.
//
// Runtime already delivered by story 023's pump — this is a load REGRESSION guard. Reuses the
// pump-tail-source harness (build first; behavioral imports resolve against ../dist).

const BURST = 1500; // "hundreds-to-thousands"

function makeAgent(messages: unknown[]) {
  const captured: any[] = [];
  const errors: any[] = [];
  let ptyWrites = 0;
  const client = {
    sessionUpdate: async (n: any) => {
      captured.push(n);
    },
    requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    readTextFile: async () => ({ content: "" }),
    writeTextFile: async () => ({}),
  } as never;
  // capture logger.error so a billing/guard alert is observable
  const logger = { log: () => {}, error: (...a: any[]) => errors.push(a.join(" ")) } as never;
  const fakeStartEngine = (args: { sessionId?: string; cwd: string }) => ({
    sessionId: args.sessionId ?? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    pty: {
      onExit: () => ({ dispose() {} }),
      onData: () => ({ dispose() {} }),
      resize() {},
      write() {
        ptyWrites++; // ACP-side input would surface here — it must NOT during a read-only pump
      },
      kill() {},
    } as never,
    watcher: { stop() {}, notifyEndOfTurn() {} },
    cwd: args.cwd,
  });
  const getMessages = async () => messages as never;
  const agent: any = new ClaudeAcpAgent(client, logger, undefined, {
    startEngine: fakeStartEngine,
    getMessages,
  });
  return { agent, captured, errors, ptyWrites: () => ptyWrites };
}

async function freshSession(agent: any): Promise<string> {
  const r = await agent.createSession({ cwd: "/work", mcpServers: [] });
  return r.sessionId;
}

/** A recorded large-fixture transcript: `n` assistant text events, each entrypoint 'cli'. */
function largeFixture(n: number): unknown[] {
  const out: unknown[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      uuid: "u" + i,
      type: "assistant",
      entrypoint: "cli",
      message: { role: "assistant", content: [{ type: "text", text: "m" + i }] },
    });
  }
  return out;
}

test("load-burst: every event yields exactly one ordered session/update — no drop/merge/reorder (R4.2)", async (t) => {
  const messages = largeFixture(BURST);
  const { agent, captured } = makeAgent(messages);
  t.after(() => agent.dispose());
  const sessionId = await freshSession(agent);

  await agent.pumpUpdates(sessionId);

  assert.equal(captured.length, BURST, "one session/update per linearized event — no drop, no merge");
  for (let i = 0; i < BURST; i++) {
    assert.equal(captured[i].update.sessionUpdate, "agent_message_chunk", `event ${i} kind`);
    assert.deepEqual(captured[i].update.content, { type: "text", text: "m" + i }, `event ${i} ordered/content`);
  }
});

test("load-burst: the burst is read-only — no ACP-side input is injected into the PTY (R4.3)", async (t) => {
  const messages = largeFixture(BURST);
  const { agent, ptyWrites } = makeAgent(messages);
  t.after(() => agent.dispose());
  const sessionId = await freshSession(agent);

  await agent.pumpUpdates(sessionId);

  assert.equal(ptyWrites(), 0, "the read-only pump must never write input to the PTY");
});

test("load-burst: the entrypoint=='cli' billing guard-rail stays green over the fixture (R4.3)", async (t) => {
  const messages = largeFixture(BURST);
  const { agent, captured, errors } = makeAgent(messages);
  t.after(() => agent.dispose());
  const sessionId = await freshSession(agent);

  await agent.pumpUpdates(sessionId);

  // a 'cli' entrypoint never trips the guard: the session is not torn down (all updates flow)
  // and no billing alert is logged.
  assert.equal(captured.length, BURST, "cli entrypoint -> guard green -> no teardown, full burst emitted");
  assert.equal(errors.length, 0, "no billing/guard error logged for a clean cli entrypoint");
});
