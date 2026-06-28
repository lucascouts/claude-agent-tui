// Story 060 / Task 3.1 — select/deselect wiring for the `ultracode` effort-selector sentinel
// (R2.1, R2.2, R2.3, R3.2, R1.2).
//
// APPROVED ARCHITECTURE "Option A: keyword live + settings scratch (NO dedicated re-spawn)":
//   - Selecting `ultracode` activates a per-session flag (`session.ultracodeActive`), writes the
//     declarative scratch keys ({ultracode,ultracodeKeywordTrigger}) into the gate's scratch settings
//     file, and applies its EFFORT component (xhigh) through the SAME live `/effort` inject as every
//     real level — NEVER `/effort ultracode` (R1.2).
//   - The LIVE activation is a KEYWORD PREFIX on the OUTGOING prompt: while active, prompt() submits
//     `ultracode <payload>` (the binary's per-turn Workflow opt-in). No re-spawn (no 2nd startEngine).
//   - Selecting a real level (or `default`) DEACTIVATES ultracode (clears the flag + scratch keys) and
//     applies that level.
//
// Harness: the effort-apply real-`createSession`/`startEngine` seam (a single shared `writes[]` so the
// live injects are observable) + an injected fake clock so prompt() can be driven deterministically (the
// keyword-prefix is asserted on the OUTGOING PTY payload). The scratch-settings half (R3.2) is asserted
// directly against `applyUltracodeSettings` on a real temp file (it preserves a pre-existing key).
//   node --experimental-strip-types --test test/effort-ultracode-apply.test.ts   (build dist/ first)
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ClaudeAcpAgent } from "../dist/acp-agent.js";
import { applyUltracodeSettings } from "../dist/gate/settings-writer.js";

/** A fake PTY that CAPTURES every `write` into the shared `writes` array (so each inject is observable). */
function makeFakePty(writes: string[]) {
  const pty = {
    onExit: () => ({ dispose() {} }),
    onData: () => ({ dispose() {} }),
    resize: () => {},
    write: (d: string) => {
      writes.push(d);
    },
    kill: () => {},
  };
  return pty as never;
}

function makeClient() {
  return {
    sessionUpdate: async () => {},
    requestPermission: async () => ({ outcome: { outcome: "selected", optionId: "allow" } }),
    readTextFile: async () => ({ content: "" }),
    writeTextFile: async () => ({}),
  } as never;
}

/** Fake clock shared by sendPrompt (the \r delay) and the turn resolver (Δt + watchdog). */
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

/** startEngine seam: call 1 is the createSession spawn. Selecting effort/ultracode must NOT re-spawn
 *  (Option A), so any 2nd call is a regression. All PTYs share one `writes` array (injects observable). */
function makeStartEngine() {
  const calls: Array<{ sessionId?: string; resume?: boolean }> = [];
  const writes: string[] = [];
  const startEngine = (args: { sessionId?: string; cwd: string; resume?: boolean }) => {
    calls.push({ sessionId: args.sessionId, resume: args.resume });
    return {
      sessionId: args.sessionId ?? "11111111-1111-4111-8111-111111111111",
      pty: makeFakePty(writes),
      watcher: { stop: () => {}, notifyEndOfTurn: () => {} },
      cwd: args.cwd,
    };
  };
  return { startEngine, calls, writes };
}

type SessionShape = {
  configOptions: Array<{ id: string; currentValue?: unknown }>;
  ultracodeActive?: boolean;
  turnDetector?: { observe: (m: unknown) => void };
  interacted?: boolean;
};

async function newSession(
  t: Parameters<NonNullable<Parameters<typeof test>[0]>>[0],
  startEngine: unknown,
  schedule: unknown,
) {
  const agent = new ClaudeAcpAgent(makeClient(), undefined, undefined, {
    startEngine: startEngine as never,
    schedule: schedule as never,
  });
  t.after(() => agent.dispose());
  const response = await (
    agent as unknown as {
      createSession: (p: unknown) => Promise<{ sessionId: string }>;
    }
  ).createSession({ cwd: "/work/dir", mcpServers: [] });
  const sessions = (
    agent as unknown as {
      sessions: Record<string, SessionShape>;
    }
  ).sessions;
  return { agent, sessionId: response.sessionId, sessions };
}

const setOption = (agent: ClaudeAcpAgent, sessionId: string, configId: string, value: string) =>
  (
    agent as unknown as {
      setSessionConfigOption: (p: {
        sessionId: string;
        configId: string;
        value: string;
      }) => Promise<unknown>;
    }
  ).setSessionConfigOption({ sessionId, configId, value });

const effortCurrentValue = (sessions: Record<string, SessionShape>, id: string) =>
  sessions[id].configOptions.find((o) => o.id === "effort")?.currentValue;

const asst = (stop_reason: unknown, uuid: string) => ({
  type: "assistant",
  uuid,
  message: { stop_reason },
});

/**
 * Drive a real single-line prompt through the agent and return the OUTGOING PTY payload (the body
 * write that sits between the leading input-clear and the trailing submit `\r`). Resolves the turn via
 * the story-024 detector so no pending promise leaks. `writes` is the shared capture array.
 */
async function sendOnce(
  agent: ClaudeAcpAgent,
  sessionId: string,
  sessions: Record<string, SessionShape>,
  writes: string[],
  advance: (ms: number) => void,
  text: string,
  uuid: string,
): Promise<string> {
  writes.length = 0;
  const p = (
    agent as unknown as {
      prompt: (req: unknown) => Promise<unknown>;
    }
  ).prompt({ sessionId, prompt: [{ type: "text", text }] });
  await Promise.resolve(); // flush prompt()'s synchronous submit prefix
  advance(60); // let the input-clear settle → the body write lands
  advance(60); // submit \r
  // The body is everything written that is not the leading Ctrl+U clear or a bare submit \r.
  const body = writes.filter((w) => w !== "\x15" && w !== "\r").join("");
  // Resolve the turn so the awaited prompt settles.
  sessions[sessionId].turnDetector?.observe(asst("end_turn", uuid));
  advance(200);
  await p;
  return body;
}

test("R2.1/R2.2/R1.2 — selecting `ultracode` injects `/effort xhigh` (never `/effort ultracode`), sets currentValue=ultracode + ultracodeActive", async (t) => {
  const fake = makeStartEngine();
  const clock = makeClock();
  const { agent, sessionId, sessions } = await newSession(t, fake.startEngine, clock.schedule);
  await setOption(agent, sessionId, "model", "sonnet"); // surface the effort option (a /model inject)

  // Make the ultracode→xhigh inject OBSERVABLE: the machine-seeded effort could already be xhigh (then
  // the no-op guard would suppress the inject). Force a guaranteed non-xhigh real level FIRST.
  await setOption(agent, sessionId, "effort", "low");
  assert.equal(effortCurrentValue(sessions, sessionId), "low", "precondition: effort is now low");
  const callsBeforeUltracode = fake.calls.length;
  fake.writes.length = 0; // drop the /model + /effort low writes — assert only the ultracode select below

  await setOption(agent, sessionId, "effort", "ultracode");

  const all = fake.writes.join("");
  assert.equal(
    fake.calls.length,
    callsBeforeUltracode,
    "selecting ultracode must NOT re-spawn (Option A: keyword + scratch, no new startEngine call)",
  );
  assert.match(
    all,
    /\/effort xhigh/,
    `ultracode's effort component is xhigh, applied via the live /effort inject; got: ${JSON.stringify(all)}`,
  );
  assert.ok(
    !all.includes("/effort ultracode"),
    `R1.2: ultracode must NEVER be emitted as a /effort value; got: ${JSON.stringify(all)}`,
  );
  assert.equal(
    effortCurrentValue(sessions, sessionId),
    "ultracode",
    "the effort configOption currentValue stays the `ultracode` sentinel (optimistic commit)",
  );
  assert.equal(
    sessions[sessionId].ultracodeActive,
    true,
    "the per-session ultracodeActive flag is set",
  );
});

test("R2.2 — while ultracode is active the OUTGOING prompt is prefixed with the `ultracode` keyword; inactive → no prefix", async (t) => {
  const fake = makeStartEngine();
  const clock = makeClock();
  const { agent, sessionId, sessions } = await newSession(t, fake.startEngine, clock.schedule);
  await setOption(agent, sessionId, "model", "sonnet");

  // (a) BEFORE selecting ultracode: a plain prompt carries NO keyword prefix.
  const inactiveBody = await sendOnce(
    agent,
    sessionId,
    sessions,
    fake.writes,
    clock.advance,
    "hello world",
    "u-inactive",
  );
  assert.ok(
    !inactiveBody.startsWith("ultracode "),
    `with ultracode inactive the outgoing payload must NOT be keyword-prefixed; got: ${JSON.stringify(inactiveBody)}`,
  );
  assert.ok(inactiveBody.includes("hello world"), "the inactive payload still carries the user text");

  // (b) AFTER selecting ultracode: the outgoing payload STARTS WITH the keyword opt-in.
  await setOption(agent, sessionId, "effort", "ultracode");
  const activeBody = await sendOnce(
    agent,
    sessionId,
    sessions,
    fake.writes,
    clock.advance,
    "hello world",
    "u-active",
  );
  assert.ok(
    activeBody.startsWith("ultracode "),
    `with ultracode active the outgoing payload MUST start with the "ultracode " keyword; got: ${JSON.stringify(activeBody)}`,
  );
  assert.ok(
    activeBody.includes("hello world"),
    "the user text rides AFTER the keyword prefix (the prefix is additive, not a replacement)",
  );
});

test("R2.3 — selecting a real level after ultracode injects that level, clears ultracodeActive, drops the keyword prefix", async (t) => {
  const fake = makeStartEngine();
  const clock = makeClock();
  const { agent, sessionId, sessions } = await newSession(t, fake.startEngine, clock.schedule);
  await setOption(agent, sessionId, "model", "sonnet");
  // Seed a non-high level so the later `/effort high` deselect inject is observable, then activate.
  await setOption(agent, sessionId, "effort", "low");
  await setOption(agent, sessionId, "effort", "ultracode");
  assert.equal(sessions[sessionId].ultracodeActive, true, "precondition: ultracode active");
  fake.writes.length = 0;

  await setOption(agent, sessionId, "effort", "high"); // deselect ultracode → a real level

  const all = fake.writes.join("");
  assert.match(
    all,
    /\/effort high/,
    `deselecting to a real level injects that level live; got: ${JSON.stringify(all)}`,
  );
  assert.equal(
    sessions[sessionId].ultracodeActive,
    false,
    "selecting a real level clears the ultracodeActive flag",
  );
  assert.equal(
    effortCurrentValue(sessions, sessionId),
    "high",
    "the effort currentValue now reflects the real level",
  );

  // A subsequent prompt must carry NO keyword prefix now that ultracode is deselected.
  const body = await sendOnce(
    agent,
    sessionId,
    sessions,
    fake.writes,
    clock.advance,
    "post deselect",
    "u-after",
  );
  assert.ok(
    !body.startsWith("ultracode "),
    `after deselecting ultracode the outgoing payload must NOT be keyword-prefixed; got: ${JSON.stringify(body)}`,
  );
});

test("R3.2 — applyUltracodeSettings(active=true) writes ultracode + ultracodeKeywordTrigger and PRESERVES a pre-existing key; (active=false) removes BOTH, keeps the pre-existing key", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fork-ultracode-settings-"));
  const file = path.join(dir, "settings.local.json");
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  // Seed the scratch with a pre-existing key (a stand-in for the gate hook block) that MUST survive.
  const seed = { hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "http", url: "http://x/__fork-acp-gate__" }] }] } };
  await fs.writeFile(file, `${JSON.stringify(seed, null, 2)}\n`, "utf8");

  // active=true → set BOTH keys, preserve the prior block.
  await applyUltracodeSettings(file, true);
  const afterOn = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
  assert.equal(afterOn.ultracode, true, "active=true sets ultracode:true");
  assert.equal(
    afterOn.ultracodeKeywordTrigger,
    true,
    "active=true sets ultracodeKeywordTrigger:true (defensively enables the keyword)",
  );
  assert.deepEqual(
    afterOn.hooks,
    seed.hooks,
    "the pre-existing hooks block is preserved verbatim (the gate hook is never clobbered)",
  );

  // active=false → remove BOTH ultracode keys, keep the prior block.
  await applyUltracodeSettings(file, false);
  const afterOff = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
  assert.ok(!("ultracode" in afterOff), "active=false removes the ultracode key");
  assert.ok(
    !("ultracodeKeywordTrigger" in afterOff),
    "active=false removes the ultracodeKeywordTrigger key",
  );
  assert.deepEqual(
    afterOff.hooks,
    seed.hooks,
    "the pre-existing hooks block still survives the deselect rewrite",
  );
});

test("R3.2 — applyUltracodeSettings is absence-safe: a missing file is treated as `{}` and creates one with the keys (active=true), or a no-op-equivalent `{}` (active=false)", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fork-ultracode-absent-"));
  const file = path.join(dir, "settings.local.json"); // deliberately NOT created
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  // active=true on an absent file must not throw — it creates the file with just the two keys.
  await applyUltracodeSettings(file, true);
  const created = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
  assert.equal(created.ultracode, true, "absent → created with ultracode:true");
  assert.equal(created.ultracodeKeywordTrigger, true, "absent → created with ultracodeKeywordTrigger:true");

  // active=false then removes them, leaving an empty object (no residue keys).
  await applyUltracodeSettings(file, false);
  const emptied = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
  assert.ok(!("ultracode" in emptied), "deselect removes ultracode");
  assert.ok(!("ultracodeKeywordTrigger" in emptied), "deselect removes ultracodeKeywordTrigger");
});

test("billing seam — the ultracode apply + keyword path introduces no -p/--print/stream-json token", async (t) => {
  const fake = makeStartEngine();
  const clock = makeClock();
  const { agent, sessionId, sessions } = await newSession(t, fake.startEngine, clock.schedule);
  await setOption(agent, sessionId, "model", "sonnet");
  await setOption(agent, sessionId, "effort", "low"); // ensure the ultracode→xhigh inject fires
  await setOption(agent, sessionId, "effort", "ultracode");
  // also drive a prompt so the keyword-prefixed outgoing payload is included in the writes sweep
  await sendOnce(agent, sessionId, sessions, fake.writes, clock.advance, "do work", "u-bill");
  const all = fake.writes.join("");
  assert.ok(
    !/--print|stream-json|(^|\s)-p(\s|$)/.test(all),
    `the ultracode apply/keyword path must carry no credit token: ${JSON.stringify(all)}`,
  );
});
