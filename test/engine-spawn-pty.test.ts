// Story 013 / Task 1.2 — spawn under a real PTY with the §5 dimensions.
// node:test runner: `node --experimental-strip-types --test test/engine-spawn-pty.test.ts`
// (run `npm run build` first — behavioral imports resolve against ../dist).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnClaudePty } from "../dist/engine-pty.js";

// RFC-4122 v4: version nibble 4, variant nibble in [89ab].
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface SpawnCall {
  file: string;
  args: readonly string[];
  opts: Record<string, unknown>;
}

// A fake `pty.spawn`: records its arguments and returns a sentinel handle. Lets us assert
// the spawn SPEC without launching a real process.
function fakePty() {
  const calls: SpawnCall[] = [];
  const handle = { __fake: true } as never;
  const spawn = ((file: string, args: readonly string[], opts: Record<string, unknown>) => {
    calls.push({ file, args, opts });
    return handle;
  }) as never;
  return { calls, handle, spawn };
}

test("pty: spawnClaudePty launches the resolved shell with the -lc argv", () => {
  const { calls, spawn } = fakePty();
  const res = spawnClaudePty({
    cwd: "/work/dir",
    baseEnv: { SHELL: "/bin/bash" } as NodeJS.ProcessEnv,
    spawn,
  });
  assert.equal(calls.length, 1, "spawn must be called exactly once");
  assert.equal(calls[0].file, "/bin/bash");
  assert.deepEqual(calls[0].args, ["-lc", `claude --session-id ${res.sessionId}`]);
});

test("pty: the §5 options object carries name/cols/rows/cwd", () => {
  const { calls, spawn } = fakePty();
  spawnClaudePty({ cwd: "/host/cwd", baseEnv: {} as NodeJS.ProcessEnv, spawn });
  const opts = calls[0].opts;
  assert.equal(opts.name, "xterm-256color");
  assert.equal(opts.cols, 120);
  assert.equal(opts.rows, 40);
  assert.equal(opts.cwd, "/host/cwd");
});

test("pty: the spawn env is sanitized (terminal vars set, billing var dropped)", () => {
  const { calls, spawn } = fakePty();
  spawnClaudePty({
    cwd: "/x",
    baseEnv: { PATH: "/usr/bin", HOME: "/home/u", CLAUDECODE: "1" } as NodeJS.ProcessEnv,
    spawn,
  });
  const env = calls[0].opts.env as Record<string, string | undefined>;
  assert.equal(env.TERM, "xterm-256color");
  assert.equal(env.COLORTERM, "truecolor");
  assert.equal(env.FORCE_COLOR, "3");
  assert.equal(
    env.CLAUDECODE,
    undefined,
    "an inherited billing var must not survive into the spawn env",
  );
  assert.equal(env.PATH, "/usr/bin", "unrelated env keys survive");
});

test("pty: does not configure piped (non-PTY) stdio — the real PTY is what makes isTTY true (R1.4)", () => {
  const { calls, spawn } = fakePty();
  spawnClaudePty({ cwd: "/x", baseEnv: {} as NodeJS.ProcessEnv, spawn });
  assert.equal(
    calls[0].opts.stdio,
    undefined,
    "no stdio:'pipe' — a pipe yields non-interactive mode",
  );
});

test("pty: returns the spawned handle for callers (story 014 manages its lifecycle)", () => {
  const { handle, spawn } = fakePty();
  const res = spawnClaudePty({ cwd: "/x", baseEnv: {} as NodeJS.ProcessEnv, spawn });
  assert.equal(res.pty, handle);
});

test("pty: the sessionId is a v4 uuid reused verbatim in the argv (R1.1)", () => {
  const { calls, spawn } = fakePty();
  const res = spawnClaudePty({ cwd: "/x", baseEnv: {} as NodeJS.ProcessEnv, spawn });
  assert.match(res.sessionId, UUID_V4);
  assert.ok(
    (calls[0].args[1] as string).includes(res.sessionId),
    "the generated sessionId must appear verbatim in the claude command",
  );
});
