// Story 046 / Task 4.5 + 4.6 — passive restart warning + bypass guard omission in advertised modes
// (R3.5, R3.6).
//
// CONTRACT (story.md R3.5 / R3.6 + design.md §6c):
//   - R3.5: the `dontAsk` AND `bypassPermissions` mode options carry a passive warning IN THEIR
//     `description` stating that switching to them restarts the session. The other modes' descriptions
//     are unchanged (no restart warning).
//   - R3.6: WHERE `bypassPermissions` is unavailable (the ALLOW_BYPASS/root guard) it is OMITTED from
//     the advertised modes (the `select` schema has no `disabled` affordance — it stays absent).
//
// The advertised modes surface through the `mode` configOption in the createSession response (the
// `select` options list). AGENT INTEGRATION over fakes (gate-wiring precedent) — drive createSession,
// read the response's `mode` option. node:test (build first):
//   node --experimental-strip-types --test test/mode-modes-advertise.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeAcpAgent } from "../dist/acp-agent.js";

function makeFakePty() {
  const pty = {
    onExit: () => ({ dispose() {} }),
    onData: () => ({ dispose() {} }),
    resize: () => {},
    write: () => {},
    kill: () => {},
  };
  return pty as never;
}

function makeAgent(t: Parameters<NonNullable<Parameters<typeof test>[0]>>[0]) {
  const client = {
    sessionUpdate: async () => {},
    requestPermission: async () => ({ outcome: { outcome: "selected", optionId: "allow" } }),
    readTextFile: async () => ({ content: "" }),
    writeTextFile: async () => ({}),
  } as never;
  const startEngine = (args: { sessionId?: string; cwd: string }) => ({
    sessionId: args.sessionId ?? "11111111-1111-4111-8111-111111111111",
    pty: makeFakePty(),
    watcher: { stop: () => {}, notifyEndOfTurn: () => {} },
    cwd: args.cwd,
  });
  const agent = new ClaudeAcpAgent(client, undefined, undefined, { startEngine: startEngine as never });
  t.after(() => agent.dispose());
  return agent;
}

type ModeOpt = { value: string; name?: string; description?: string };

async function modeOptions(t: Parameters<NonNullable<Parameters<typeof test>[0]>>[0]): Promise<ModeOpt[]> {
  const agent = makeAgent(t);
  const response = (await (agent as unknown as {
    createSession: (p: unknown) => Promise<{ configOptions: Array<{ id: string; options?: ModeOpt[] }> }>;
  }).createSession({ cwd: "/work/dir", mcpServers: [] }));
  const modeOption = response.configOptions.find((o) => o.id === "mode");
  assert.ok(modeOption?.options, "the createSession response must advertise a `mode` configOption with options");
  return modeOption!.options!;
}

const RESTART_RE = /restart|re-?spawn/i;

test("4.5 the dontAsk mode description carries a passive restart warning (R3.5)", async (t) => {
  const opts = await modeOptions(t);
  const dontAsk = opts.find((o) => o.value === "dontAsk");
  assert.ok(dontAsk, "dontAsk must be advertised");
  assert.ok(
    RESTART_RE.test(dontAsk!.description ?? ""),
    `dontAsk description must warn that switching restarts the session (R3.5), got: ${JSON.stringify(dontAsk!.description)}`,
  );
});

test("4.5 a cyclable mode (acceptEdits) description carries NO restart warning (R3.5 — others unchanged)", async (t) => {
  const opts = await modeOptions(t);
  const acceptEdits = opts.find((o) => o.value === "acceptEdits");
  assert.ok(acceptEdits, "acceptEdits must be advertised");
  assert.ok(
    !RESTART_RE.test(acceptEdits!.description ?? ""),
    `a cyclable mode must NOT carry the restart warning (R3.5), got: ${JSON.stringify(acceptEdits!.description)}`,
  );
});

test("R7 (056 v3) the `auto` permission mode IS advertised on the default model, with the classifier tip", async (t) => {
  // The default model now declares supportsAutoMode (model-catalog.ts), so buildAvailableModes surfaces
  // `auto` — the parity gap the in-Zed proof found (the mode existed but was never advertised).
  const opts = await modeOptions(t);
  const auto = opts.find((o) => o.value === "auto");
  assert.ok(auto, "auto must be advertised on the default model (supportsAutoMode === true)");
  assert.match(
    auto!.description ?? "",
    /classifier/i,
    `auto must carry the model-classifier tip, got: ${JSON.stringify(auto!.description)}`,
  );
});

test("4.6 bypassPermissions is omitted from advertised modes when unavailable under the guard (R3.6)", async (t) => {
  const opts = await modeOptions(t);
  const bypass = opts.find((o) => o.value === "bypassPermissions");
  const underGuard = !!(process.getuid && process.getuid() === 0 && !process.env.IS_SANDBOX);
  if (underGuard) {
    assert.equal(bypass, undefined, "bypassPermissions must be OMITTED under the root/ALLOW_BYPASS guard (R3.6)");
  } else {
    // Bypass available: it is advertised AND carries the restart warning (R3.5).
    assert.ok(bypass, "bypassPermissions must be advertised when available");
    assert.ok(
      RESTART_RE.test(bypass!.description ?? ""),
      `the advertised bypassPermissions description must warn that switching restarts the session (R3.5), got: ${JSON.stringify(bypass!.description)}`,
    );
  }
});
