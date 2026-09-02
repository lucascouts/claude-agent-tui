// Upstream #1025 parity — `_meta.kind` on the advertised permission modes
// (REBASE-AND-DRIFT.md §15.5).
//
// CONTRACT: each advertised mode carries a coarse classification alongside its free-text
// description — `standard` (asks, or auto-accepts edits), `plan`, `auto_review`,
// `full_access`. Only the CATALOGUE ports: upstream applies the mode through
// `query.setPermissionMode`, which is CUT in this engine (SEAM-MAP).
//
// TWO SURFACES, ONE CATALOGUE. `createSession` returns both the `modes` state (what
// `session/set_mode` validates against) and the `mode` configOption (what the client
// renders). They describe the same modes, so the kind must be readable from either —
// otherwise a mode's classification would depend on which surface Zed happened to read.
//
// `dontAsk` deliberately carries NO kind: upstream's four kinds all describe a mode that
// ASKS or AUTO-APPROVES, and `dontAsk` DENIES. It is absent from upstream's catalogue
// entirely, and omitting the key is how that shows. `claude-agent-fork` reached the same
// decision independently for the same mode.
//
// node:test (build first):
//   node --experimental-strip-types --test test/mode-kind-meta.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeAcpAgent } from "../dist/acp-agent.js";

type Mode = { id: string; name?: string; _meta?: { kind?: string } | null };
type Opt = { value: string; name?: string; _meta?: { kind?: string } | null };

function makeFakePty() {
  return {
    onExit: () => ({ dispose() {} }),
    onData: () => ({ dispose() {} }),
    resize: () => {},
    write: () => {},
    kill: () => {},
  } as never;
}

async function session(t: Parameters<NonNullable<Parameters<typeof test>[0]>>[0]) {
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
  const agent = new ClaudeAcpAgent(client, undefined, undefined, {
    startEngine: startEngine as never,
  });
  t.after(() => agent.dispose());
  const response = await (
    agent as unknown as {
      createSession: (p: unknown) => Promise<{
        modes?: { availableModes: Mode[] };
        configOptions: Array<{ id: string; options?: Opt[] }>;
      }>;
    }
  ).createSession({ cwd: "/work/dir", mcpServers: [] });
  const modes = response.modes?.availableModes ?? [];
  const opts = response.configOptions.find((o) => o.id === "mode")?.options ?? [];
  assert.ok(modes.length > 0, "createSession must advertise availableModes");
  assert.ok(opts.length > 0, "createSession must advertise a `mode` configOption");
  return { modes, opts };
}

// id -> expected kind; `null` means the key must be absent/undefined.
const EXPECTED: Record<string, string | null> = {
  default: "standard",
  acceptEdits: "standard",
  plan: "plan",
  auto: "auto_review",
  bypassPermissions: "full_access",
  dontAsk: null,
};

test("#1025 every advertised mode carries the expected `_meta.kind` (or none, for dontAsk)", async (t) => {
  const { modes } = await session(t);
  for (const mode of modes) {
    assert.ok(mode.id in EXPECTED, `unclassified mode "${mode.id}" — EXPECTED must be updated with it`);
    const expected = EXPECTED[mode.id]!;
    const actual = mode._meta?.kind;
    if (expected === null) {
      assert.equal(actual, undefined, `"${mode.id}" must NOT claim a kind upstream has not defined`);
    } else {
      assert.equal(actual, expected, `"${mode.id}" kind`);
    }
  }
});

test("#1025 the kind is readable from the configOption surface too, and agrees", async (t) => {
  const { modes, opts } = await session(t);
  assert.deepEqual(
    opts.map((o) => o.value).sort(),
    modes.map((m) => m.id).sort(),
    "both surfaces must describe the same catalogue",
  );
  for (const opt of opts) {
    const mode = modes.find((m) => m.id === opt.value)!;
    assert.equal(
      opt._meta?.kind,
      mode._meta?.kind,
      `"${opt.value}" kind must agree across the two surfaces`,
    );
  }
});

test("#1025 the catalogue is classified exhaustively — no mode is left without a decision", async (t) => {
  const { modes } = await session(t);
  const classified = modes.filter((m) => EXPECTED[m.id] !== null);
  assert.ok(
    classified.every((m) => typeof m._meta?.kind === "string" && m._meta.kind.length > 0),
    "every mode expected to carry a kind must actually carry a non-empty one",
  );
});
