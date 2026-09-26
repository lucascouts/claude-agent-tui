// Port of upstream claude-agent-acp #1165 (281e47e) — honor permissions.disableBypassPermissionsMode.
//
// CONTRACT: Claude Code refuses `bypassPermissions` when ANY settings tier (user, project, local,
// managed) sets `permissions.disableBypassPermissionsMode` to "disable". The key only takes a
// permission away, so it is honoured from every tier — project included (unlike an escalating
// `defaultMode`, which `filterEscalatingDefaultMode` strips from a repo's own settings). With it set,
// a session must:
//   - omit `bypassPermissions` from the advertised mode catalog (modes AND the `mode` configOption);
//   - clamp a `defaultMode: "bypassPermissions"` seed to "default", with a logged reason — so the
//     fresh spawn carries no `--permission-mode bypassPermissions`;
//   - refuse a set_mode / set_config_option(mode) request for bypass (no re-spawn into bypass).
//
// Integration over the `startEngine` seam with planted user (CLAUDE_CONFIG_DIR) and project
// (`<cwd>/.claude/settings.json`) settings, isolated in temp dirs. node:test (build first):
//   node --experimental-strip-types --test test/mode-disable-bypass.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeAcpAgent } from "../dist/acp-agent.js";

// Under root outside a sandbox bypass is already off (ALLOW_BYPASS), which would make every
// assertion below pass vacuously — and the control case impossible.
const ROOT_GUARD = !!(process.getuid && process.getuid() === 0 && !process.env.IS_SANDBOX);

function makeFakePty() {
  return {
    onExit: () => ({ dispose() {} }),
    onData: () => ({ dispose() {} }),
    resize: () => {},
    write: () => {},
    kill: () => {},
  } as never;
}

function makeClient() {
  return {
    sessionUpdate: async () => {},
    requestPermission: async () => ({ outcome: { outcome: "selected", optionId: "allow" } }),
    readTextFile: async () => ({ content: "" }),
    writeTextFile: async () => ({}),
  } as never;
}

interface Harness {
  sessionId: string;
  spawnModes: Array<string | undefined>;
  errors: string[];
  currentModeId: string;
  availableModeIds: string[];
  modeOptionValues: string[];
  agent: {
    setSessionMode: (p: { sessionId: string; modeId: string }) => Promise<unknown>;
    setSessionConfigOption: (p: { sessionId: string; configId: string; value: string }) => Promise<unknown>;
  };
}

async function createWith(
  t: Parameters<NonNullable<Parameters<typeof test>[0]>>[0],
  userSettings: unknown,
  projectSettings: unknown | null,
): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "disable-bypass-"));
  const cfg = mkdtempSync(join(tmpdir(), "disable-bypass-cfg-"));
  const prevCfg = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = cfg;
  writeFileSync(join(cfg, "settings.json"), JSON.stringify(userSettings) + "\n", "utf8");
  if (projectSettings !== null) {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify(projectSettings) + "\n", "utf8");
  }
  const spawnModes: Array<string | undefined> = [];
  const errors: string[] = [];
  const agent = new ClaudeAcpAgent(makeClient(), undefined, undefined, {
    startEngine: ((args: { sessionId?: string; cwd: string; permissionMode?: string }) => {
      spawnModes.push(args.permissionMode);
      return {
        sessionId: args.sessionId ?? "22222222-2222-4222-8222-222222222222",
        pty: makeFakePty(),
        watcher: { stop: () => {}, notifyEndOfTurn: () => {} },
        cwd: args.cwd,
      };
    }) as never,
  });
  (agent as unknown as { logger: unknown }).logger = {
    log: () => {},
    error: (...a: unknown[]) => errors.push(a.map(String).join(" ")),
  };
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
  const sess = (agent as unknown as {
    sessions: Record<
      string,
      {
        modes: { currentModeId: string; availableModes: Array<{ id: string }> };
        configOptions: Array<{ id: string; options?: Array<{ value: string }> }>;
      }
    >;
  }).sessions[res.sessionId];
  return {
    sessionId: res.sessionId,
    spawnModes,
    errors,
    currentModeId: sess.modes.currentModeId,
    availableModeIds: sess.modes.availableModes.map((m) => m.id),
    modeOptionValues: (sess.configOptions.find((o) => o.id === "mode")?.options ?? []).map((o) => o.value),
    agent: agent as unknown as Harness["agent"],
  };
}

async function assertBypassDisabled(h: Harness): Promise<void> {
  assert.ok(!h.availableModeIds.includes("bypassPermissions"), "catalog must omit bypassPermissions");
  assert.ok(!h.modeOptionValues.includes("bypassPermissions"), "mode configOption must omit bypassPermissions");
  assert.equal(h.currentModeId, "default", "defaultMode bypassPermissions must clamp to 'default'");
  assert.deepEqual(h.spawnModes, ["default"], "the spawn must not carry --permission-mode bypassPermissions");
  assert.ok(
    h.errors.some((e) => e.includes("disableBypassPermissionsMode")),
    `the clamp must log its reason; got ${JSON.stringify(h.errors)}`,
  );
  await assert.rejects(
    h.agent.setSessionMode({ sessionId: h.sessionId, modeId: "bypassPermissions" }),
    /not available/,
    "set_mode bypassPermissions must be refused",
  );
  await assert.rejects(
    h.agent.setSessionConfigOption({ sessionId: h.sessionId, configId: "mode", value: "bypassPermissions" }),
    /Invalid value/,
    "set_config_option mode=bypassPermissions must be refused",
  );
  assert.deepEqual(h.spawnModes, ["default"], "a refused request must not re-spawn");
}

test("control: user defaultMode=bypassPermissions without the key seeds bypass", { skip: ROOT_GUARD }, async (t) => {
  const h = await createWith(t, { permissions: { defaultMode: "bypassPermissions" } }, null);
  assert.ok(h.availableModeIds.includes("bypassPermissions"));
  assert.equal(h.currentModeId, "bypassPermissions");
  assert.deepEqual(h.spawnModes, ["bypassPermissions"]);
});

test("honors permissions.disableBypassPermissionsMode from user settings", { skip: ROOT_GUARD }, async (t) => {
  const h = await createWith(
    t,
    { permissions: { defaultMode: "bypassPermissions", disableBypassPermissionsMode: "disable" } },
    null,
  );
  await assertBypassDisabled(h);
});

test("honors permissions.disableBypassPermissionsMode from project settings", { skip: ROOT_GUARD }, async (t) => {
  const h = await createWith(
    t,
    { permissions: { defaultMode: "bypassPermissions" } },
    { permissions: { disableBypassPermissionsMode: "disable" } },
  );
  await assertBypassDisabled(h);
});
