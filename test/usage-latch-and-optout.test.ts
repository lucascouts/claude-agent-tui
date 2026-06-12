// Story 042 / Task 2.1 (R4.1, R5.1) — a REGRESSION lock over two behaviors that story 042's
// default-ON flip MUST keep intact (they predate 042; this file only characterizes them):
//
//   Part A (R4.1) — the per-session reject LATCH. WHEN the ACP client REJECTS a `usage_update`
//   (the R8 detection signal), the pump catches it, latches the feature OFF for that session, and
//   keeps the surrounding text/tool stream flowing WITHOUT propagating the rejection. Across two
//   usage-bearing turns only the FIRST usage_update is attempted; the rest are suppressed.
//
//   Part B (R5.1) — the byte-identical OPT-OUT. The `USAGE_UPDATE=0`/`"false"` opt-out maps to a
//   constructed-OFF agent (usageUpdateEnabled === false), and a flag-OFF pump emits ZERO
//   usage_update — the session/update stream is byte-for-byte the pre-042 OFF core (the two text
//   chunks, in order). An ON run is the SAME core stream PLUS the usage notifications, proving the
//   OFF path leaves the core untouched.
//
// This exercises the REAL pump (`ClaudeAcpAgent.pumpUpdates`) and the REAL gate (`usageUpdatesFor`
// via the agent) — NOT a local re-impl (self-guard at the bottom, established 018/019 pattern). It
// REUSES the story-025 `usage-reject.test.ts` harness shape (stub client + fake engine + two
// usage-bearing turns). No production runtime changes here: the latch lives in acp-agent.ts and the
// gate in usage.ts; this file LOCKS them. A first-run pass is EXPECTED (it characterizes existing
// behavior), not a missing Red.
//
// Run: `npm --prefix fork run build && node --experimental-strip-types --test test/usage-latch-and-optout.test.ts`
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ClaudeAcpAgent } from "../dist/acp-agent.js";
import { usageUpdateEnabled } from "../dist/usage-env.js";

// A captured session/update notification (the stub client records these).
type Captured = { update: { sessionUpdate: string; content?: { text?: string } } };

// Two assistant turns, each carrying text + usage tokens (usage lives on the Anthropic `message`,
// a sibling of role/content — the exact carrier the pump reads as `turn.message.message`).
const MESSAGES = [
  {
    uuid: "a1",
    type: "assistant",
    entrypoint: "cli",
    message: { role: "assistant", content: [{ type: "text", text: "t1" }], usage: { input_tokens: 10, output_tokens: 5 } },
  },
  {
    uuid: "a2",
    type: "assistant",
    entrypoint: "cli",
    message: { role: "assistant", content: [{ type: "text", text: "t2" }], usage: { input_tokens: 20, output_tokens: 8 } },
  },
];

// A fake engine so createSession/pumpUpdates run without a real claude/PTY (story-025 shape).
const fakeStartEngine = (args: { sessionId?: string; cwd: string }) => ({
  sessionId: args.sessionId ?? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  pty: { onExit: () => ({ dispose() {} }), onData: () => ({ dispose() {} }), resize() {}, write() {}, kill() {} } as never,
  watcher: { stop() {}, notifyEndOfTurn() {} },
  cwd: args.cwd,
});

/**
 * Build an agent over the REAL pump with a stub Zed client. `reject` chooses the client posture:
 *   - reject=true  → the client THROWS on usage_update (R8) and captures everything else.
 *   - reject=false → the client ACCEPTS and captures EVERYTHING, including usage_update.
 * `usageUpdate` is the per-agent feature flag.
 */
function makeAgent(opts: { reject: boolean; usageUpdate: boolean }) {
  const captured: Captured[] = []; // the surrounding (non-usage when rejecting) stream
  const all: Captured[] = []; // every notification the client received, in order
  const usageAttempts: Captured[] = [];
  const errors: string[] = [];
  const client = {
    sessionUpdate: async (n: any) => {
      all.push(n);
      if (n?.update?.sessionUpdate === "usage_update") {
        usageAttempts.push(n);
        if (opts.reject) throw new Error("Zed rejects UNSTABLE usage_update"); // R8 client rejection
      }
      captured.push(n);
    },
    requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    readTextFile: async () => ({ content: "" }),
    writeTextFile: async () => ({}),
  } as never;
  const logger = { log: () => {}, error: (...a: any[]) => errors.push(a.join(" ")) } as never;
  const getMessages = async () => MESSAGES as never;
  const agent: any = new ClaudeAcpAgent(client, logger, undefined, {
    startEngine: fakeStartEngine,
    getMessages,
    usageUpdate: opts.usageUpdate,
  });
  return { agent, captured, all, usageAttempts, errors };
}

async function freshSession(agent: any): Promise<string> {
  const r = await agent.createSession({ cwd: "/work", mcpServers: [] });
  return r.sessionId;
}

// === Part A (R4.1) — the per-session reject latch is preserved ====================================

test("R4.1 latch: a client rejection is caught and never escapes the pump's turn loop", async (t) => {
  const { agent } = makeAgent({ reject: true, usageUpdate: true });
  t.after(() => agent.dispose());
  const sessionId = await freshSession(agent);

  let threw = false;
  try {
    await agent.pumpUpdates(sessionId);
  } catch {
    threw = true;
  }
  assert.equal(threw, false, "the usage_update client rejection must not escape into the turn loop");
});

test("R4.1 latch: after the first rejection only ONE usage_update is attempted across both turns", async (t) => {
  const { agent, usageAttempts } = makeAgent({ reject: true, usageUpdate: true });
  t.after(() => agent.dispose());
  const sessionId = await freshSession(agent);

  await agent.pumpUpdates(sessionId);
  // Authoritative latch proof: the second turn's usage_update is suppressed by the per-session latch.
  assert.equal(usageAttempts.length, 1, "only the first usage_update is attempted; the latch suppresses the rest");
  // Supplementary: the per-session `usageDisabled` flag is latched true (reached via the agent's own
  // sessions map — the same path acp-agent.ts uses, not a brittle deep private cast).
  assert.equal(agent.sessions[sessionId].usageDisabled, true, "the per-session usageDisabled latch is set after a rejection");
});

test("R4.1 latch: the surrounding text stream stays in order, unaffected by the rejection", async (t) => {
  const { agent, captured, errors } = makeAgent({ reject: true, usageUpdate: true });
  t.after(() => agent.dispose());
  const sessionId = await freshSession(agent);

  await agent.pumpUpdates(sessionId);
  assert.deepEqual(
    captured.map((c) => c.update.sessionUpdate),
    ["agent_message_chunk", "agent_message_chunk"],
    "both text chunks still delivered despite the usage rejection",
  );
  assert.deepEqual(
    captured.map((c) => c.update.content?.text),
    ["t1", "t2"],
    "text stream stays in order after the rejection",
  );
  assert.equal(errors.length, 1, "the rejection is logged exactly once for drift telemetry");
});

// === Part B (R5.1) — USAGE_UPDATE=0 is byte-identical to the pre-042 OFF core =====================

test("R5.1 opt-out: USAGE_UPDATE=0 / \"false\" map to a constructed-OFF agent (usageUpdateEnabled === false)", () => {
  // The env opt-out is what ties USAGE_UPDATE=0 to the flag-OFF agent driven below.
  assert.equal(usageUpdateEnabled({ USAGE_UPDATE: "0" } as NodeJS.ProcessEnv), false, "USAGE_UPDATE=0 opts the agent OFF");
  assert.equal(usageUpdateEnabled({ USAGE_UPDATE: "false" } as NodeJS.ProcessEnv), false, "USAGE_UPDATE=false opts the agent OFF");
});

test("R5.1 opt-out: a flag-OFF pump emits ZERO usage_update — byte-for-byte the pre-042 core stream", async (t) => {
  // usageUpdate:false IS the opt-out / pre-042 baseline (USAGE_UPDATE=0 → constructed-OFF agent).
  const { agent, all } = makeAgent({ reject: false, usageUpdate: false });
  t.after(() => agent.dispose());
  const sessionId = await freshSession(agent);

  await agent.pumpUpdates(sessionId);

  const usage = all.filter((c) => c.update.sessionUpdate === "usage_update");
  assert.equal(usage.length, 0, "USAGE_UPDATE=0 (flag OFF) must construct ZERO usage_update");
  // The whole stream is exactly the pure core: the two text chunks, in order, with their text.
  assert.deepEqual(
    all.map((c) => c.update.sessionUpdate),
    ["agent_message_chunk", "agent_message_chunk"],
    "the OFF stream is byte-for-byte the core text stream — no usage notification injected",
  );
  assert.deepEqual(
    all.map((c) => c.update.content?.text),
    ["t1", "t2"],
    "the OFF stream's text content is the untouched core, in order",
  );
});

test("R5.1 opt-out: the ON stream is the SAME core stream PLUS the usage notifications (OFF core untouched)", async (t) => {
  // An ACCEPTING client with the flag ON: the ON stream must be the OFF core with usage_update
  // notifications interleaved — proving the OFF path is the core stream left untouched.
  const off = makeAgent({ reject: false, usageUpdate: false });
  t.after(() => off.agent.dispose());
  const on = makeAgent({ reject: false, usageUpdate: true });
  t.after(() => on.agent.dispose());

  await off.agent.pumpUpdates(await freshSession(off.agent));
  await on.agent.pumpUpdates(await freshSession(on.agent));

  // ON adds usage_update; OFF has none.
  assert.equal(on.all.filter((c) => c.update.sessionUpdate === "usage_update").length, 2, "ON emits one usage_update per usage-bearing turn");
  assert.equal(off.all.filter((c) => c.update.sessionUpdate === "usage_update").length, 0, "OFF emits none");
  // The ON stream with the usage_update notifications STRIPPED OUT equals the OFF stream exactly —
  // i.e. the flag only ADDS notifications; it never alters the core text stream.
  assert.deepEqual(
    on.all.filter((c) => c.update.sessionUpdate !== "usage_update"),
    off.all,
    "the ON core (usage stripped) is byte-for-byte the OFF stream — the OFF path is the core untouched",
  );
});

// === the latch + gate are REUSED from the dist exports, not re-implemented here ===================

test("the regression test REUSES the dist pump + gate (no local re-impl) (R4.1, R5.1)", () => {
  // established 018/019 self-guard: this file must not re-declare the agent or the gate locally.
  // (the `\s+`/`\b` form matches a genuine local decl only, never an import or this assertion line.)
  const self = readFileSync(new URL("./usage-latch-and-optout.test.ts", import.meta.url), "utf8");
  assert.ok(!/function\s+usageUpdatesFor\b/.test(self), "must not re-implement the usage gate locally");
  assert.ok(!/class\s+ClaudeAcpAgent\b/.test(self), "must not re-implement the agent/pump locally");
});
