// Story 030 / Task 2.1 — submit the assembled payload to the PTY (§8) and resolve the pending
// session/prompt ONLY via the story-024 end-of-turn detector.
//
// Locks the Degrau-2 prompt() contract: assemble via promptToClaude → submit with the §8 convention
// (single-line: write(text) + delayed \r; multi-line: bracketed-paste) → register the turn with
// createTurnResolver and resolve solely on the detector's terminal boundary (never by the writer).
// A mixed ContentBlock[] yields EXACTLY ONE completed turn carrying the 024 stopReason and stays
// pending across mid-turn events. Enabling ACP-side input does NOT bypass the §10 entrypoint=='cli'
// billing guard-rail. (R1, R1.2, R5, R5.1, R5.2 + §10 constraint.)
//
// The end-of-turn signal is STUBBED by driving session.turnDetector directly (the seam the live
// pump feeds). The agent's `schedule` is injected as a fake clock shared by sendPrompt + the resolver.
// node:test: `node --experimental-strip-types --test test/prompt-submit-endofturn.test.ts` (build first)
import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeAcpAgent } from "../dist/acp-agent.js";

/** Fake clock shared by sendPrompt (the \r delay) and the turn resolver (Δt + watchdog). */
function makeClock() {
  let now = 0;
  const timers: Array<{ at: number; fn: () => void; cancelled: boolean }> = [];
  const schedule = (fn: () => void, ms: number) => {
    const t = { at: now + ms, fn, cancelled: false };
    timers.push(t);
    return () => { t.cancelled = true; };
  };
  const advance = (ms: number) => {
    now += ms;
    for (const t of [...timers].sort((a, b) => a.at - b.at)) {
      if (!t.cancelled && t.at <= now) { t.cancelled = true; t.fn(); }
    }
  };
  return { schedule, advance };
}

function makeAgent(deps: any = {}) {
  const updates: unknown[] = [];
  const client: any = { async sessionUpdate(u: unknown) { updates.push(u); } };
  const agent: any = new ClaudeAcpAgent(client, console, undefined, deps);
  return { agent, updates };
}

function fakePty() {
  const writes: string[] = [];
  return {
    writes,
    write: (d: string) => { writes.push(d); },
    onData: () => ({ dispose() {} }),
    onExit: () => ({ dispose() {} }),
    kill: () => {}, resize: () => {},
  };
}

function injectSession(agent: any, sid: string, pty: any) {
  agent.sessions[sid] = {
    pty, emitted: new Set(), cancelled: false, cwd: "/tmp/x",
    toolUseCache: {}, guardChecked: false,
    settingsManager: { dispose() {} }, watcher: undefined,
  };
  return agent.sessions[sid];
}

const SID = "sess-030-submit";
const asst = (stop_reason: unknown, uuid: string) => ({ type: "assistant", uuid, message: { stop_reason } });

test("R1.2 — a single-line payload submits as write(text) then a delayed \\r (§8)", async () => {
  const { schedule, advance } = makeClock();
  const { agent } = makeAgent({ schedule });
  const pty = fakePty();
  const session = injectSession(agent, SID, pty);

  const p = agent.prompt({ sessionId: SID, prompt: [{ type: "text", text: "single line" }] });
  await Promise.resolve(); // flush prompt()'s synchronous submit prefix
  assert.deepEqual(pty.writes, ["\x15"], "the input-clearing Ctrl+U leads (034 G2 fix); no body yet");
  advance(60);
  assert.deepEqual(pty.writes, ["\x15", "single line"], "the body is written verbatim after the clear settles");
  advance(60);
  assert.deepEqual(pty.writes, ["\x15", "single line", "\r"], "the \\r follows after the submission delay");

  // resolve the turn so the awaited prompt settles (no leaked pending promise)
  session.turnDetector.observe(asst("end_turn", "u1"));
  advance(200);
  assert.deepEqual(await p, { stopReason: "end_turn" });
});

test("R1.2 — a multi-line payload submits wrapped in a bracketed-paste envelope (§8)", async () => {
  const { schedule, advance } = makeClock();
  const { agent } = makeAgent({ schedule });
  const pty = fakePty();
  const session = injectSession(agent, SID, pty);

  const p = agent.prompt({ sessionId: SID, prompt: [{ type: "text", text: "line A\nline B" }] });
  await Promise.resolve();
  assert.deepEqual(pty.writes, ["\x15"], "the input-clearing Ctrl+U leads (034 G2 fix)");
  advance(60);
  assert.equal(pty.writes.length, 2, "the whole multi-line block is one write before \\r");
  assert.ok(
    pty.writes[1].startsWith("\x1b[200~") && pty.writes[1].includes("\x1b[201~"),
    "multi-line text is wrapped in the bracketed-paste envelope",
  );
  assert.ok(pty.writes[1].includes("line A\nline B"), "the body sits inside the envelope");
  advance(60);
  assert.equal(pty.writes[2], "\r", "submit \\r still follows the paste");

  session.turnDetector.observe(asst("end_turn", "u1"));
  advance(200);
  assert.deepEqual(await p, { stopReason: "end_turn" });
});

test("R5/R5.2 — a mixed ContentBlock[] resolves as EXACTLY ONE turn carrying the 024 stopReason", async () => {
  const { schedule, advance } = makeClock();
  const { agent } = makeAgent({ schedule });
  const pty = fakePty();
  const session = injectSession(agent, SID, pty);

  const p = agent.prompt({
    sessionId: SID,
    prompt: [
      { type: "text", text: "review" },
      { type: "resource_link", name: "a.ts", uri: "file:///p/a.ts" },
      { type: "resource", resource: { uri: "file:///p/b.ts", text: "small inline" } },
    ],
  });
  await Promise.resolve();
  advance(60);
  const submitted = pty.writes.join("");
  assert.ok(submitted.includes("review"), "the text block was submitted");
  assert.ok(submitted.includes("@/p/a.ts"), "the resource_link was submitted as @<path>");
  assert.ok(submitted.includes("small inline"), "the small embedded resource was inlined");

  // R5.1 — NOT resolved before the detector fires a terminal boundary
  let settled = false;
  void p.then(() => { settled = true; });
  session.turnDetector.observe(asst("tool_use", "u1")); // mid-turn, non-terminal
  await Promise.resolve();
  assert.equal(settled, false, "the prompt stays pending across a mid-turn (tool_use) event");

  // exactly one terminal boundary → one resolution with the mapped 024 stopReason
  session.turnDetector.observe(asst("max_tokens", "u2"));
  advance(200);
  assert.deepEqual(await p, { stopReason: "max_tokens" }, "resolved once, carrying the detector's stopReason");
});

test("§10 — enabling ACP input does NOT bypass the entrypoint=='cli' billing guard-rail", async () => {
  // A billed (credit) entrypoint in the JSONL must still abort the session via the pump's guard.
  const billed = {
    type: "assistant", uuid: "b1", entrypoint: "sdk-py",
    message: { role: "assistant", content: [], stop_reason: "end_turn" },
  };
  const getMessages = async () => [billed];
  const { agent } = makeAgent({ getMessages });
  injectSession(agent, SID, fakePty());

  await (agent as any).pumpUpdates(SID);
  assert.equal(agent.sessions[SID], undefined, "a billed (sdk-py) entrypoint aborts the session — guard intact");
});

test("an unknown session still faults (no silent accept-then-drop), even with input enabled", async () => {
  const { schedule } = makeClock();
  const { agent } = makeAgent({ schedule });
  await assert.rejects(
    () => agent.prompt({ sessionId: "does-not-exist", prompt: [] }),
    /Session not found/,
    "prompt() on an unknown session must throw",
  );
});
