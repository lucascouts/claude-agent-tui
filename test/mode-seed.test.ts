// Story 046 / Task 4.1 — createSession SEEDS the current permission mode from settings
// `permissions.defaultMode` (R3.1 choose-before-start), instead of the hardcoded "default".
//
// CONTRACT (story.md R3.1 + design.md §6a): a new session's `modes.currentModeId` and the `mode`
// configOption `currentValue` are seeded from `permissions.defaultMode` (normalized through
// `resolvePermissionMode`), replacing the literal `currentModeId: "default"`. The normalization helper
// already exists; THIS pins the missing WIRING — that createSession routes the resolved setting into the
// session's mode state. Integration over the `startEngine` seam + a planted project `.claude/settings.json`.
//
// `plan` is chosen as the seeded value because it is a DE-escalation (read-only), so the SDK's
// `filterEscalatingDefaultMode` honors it from project settings (escalating modes like acceptEdits are
// stripped from a repo's own settings). CLAUDE_CONFIG_DIR is pointed at an empty temp dir to isolate the
// test from the developer's real ~/.claude. node:test (build first):
//   node --experimental-strip-types --test test/mode-seed.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function makeClient() {
  return {
    sessionUpdate: async () => {},
    requestPermission: async () => ({ outcome: { outcome: "selected", optionId: "allow" } }),
    readTextFile: async () => ({ content: "" }),
    writeTextFile: async () => ({}),
  } as never;
}

/** Minimal startEngine seam: returns a live fake PTY for the createSession spawn. */
function makeStartEngine() {
  return (args: { sessionId?: string; cwd: string }) => ({
    sessionId: args.sessionId ?? "11111111-1111-4111-8111-111111111111",
    pty: makeFakePty(),
    watcher: { stop: () => {}, notifyEndOfTurn: () => {} },
    cwd: args.cwd,
  });
}

/** Create a session in a temp cwd carrying an optional project `.claude/settings.json`, with
 *  CLAUDE_CONFIG_DIR isolated to an empty temp dir. Returns the seeded mode state. */
async function seededMode(
  t: Parameters<NonNullable<Parameters<typeof test>[0]>>[0],
  settings: unknown | null,
): Promise<{ currentModeId: string; modeCurrentValue: unknown }> {
  const dir = mkdtempSync(join(tmpdir(), "mode-seed-"));
  const cfg = mkdtempSync(join(tmpdir(), "mode-seed-cfg-"));
  const prevCfg = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = cfg;
  if (settings !== null) {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify(settings) + "\n", "utf8");
  }
  const agent = new ClaudeAcpAgent(makeClient(), undefined, undefined, {
    startEngine: makeStartEngine() as never,
  });
  t.after(() => {
    agent.dispose();
    if (prevCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevCfg;
    rmSync(dir, { recursive: true, force: true });
    rmSync(cfg, { recursive: true, force: true });
  });
  const res = await (agent as unknown as {
    createSession: (p: unknown) => Promise<{ sessionId: string }>;
  }).createSession({ cwd: dir, mcpServers: [] });
  const sessions = (agent as unknown as {
    sessions: Record<
      string,
      { configOptions: Array<{ id: string; currentValue?: unknown }>; modes: { currentModeId: string } }
    >;
  }).sessions;
  const sess = sessions[res.sessionId];
  return {
    currentModeId: sess.modes.currentModeId,
    modeCurrentValue: sess.configOptions.find((o) => o.id === "mode")?.currentValue,
  };
}

test("4.1 createSession seeds currentModeId from project settings defaultMode=plan (R3.1)", async (t) => {
  const { currentModeId, modeCurrentValue } = await seededMode(t, { permissions: { defaultMode: "plan" } });
  assert.equal(
    currentModeId,
    "plan",
    "createSession must SEED modes.currentModeId from permissions.defaultMode, not hardcode 'default' (R3.1)",
  );
  assert.equal(
    modeCurrentValue,
    "plan",
    "the mode configOption currentValue must reflect the seeded permission mode (R3.1)",
  );
});

test("4.1 createSession with no settings falls back to 'default' (safe default — regression guard)", async (t) => {
  const { currentModeId } = await seededMode(t, null);
  assert.equal(currentModeId, "default");
});
