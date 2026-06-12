// Story 014 / Task 4.1 — robust `claude --resume` with a fresh-session fallback (R4.1, R4.2).
// node:test runner: `node --experimental-strip-types --test test/engine-resume.test.ts`
// (run `npm run build` first — behavioral imports resolve against ../dist).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnResumePty, buildResumeArgv } from "../dist/engine-lifecycle.js";
import { makeFakeSpawn } from "./lifecycle-fakes.ts";

const BILLING_VARS = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_AGENT_SDK_VERSION",
  "CLAUDE_AGENT_SDK_CLIENT_APP",
];

test("resume argv carries the `|| claude` fresh-session fallback (R4.1)", () => {
  assert.deepEqual(buildResumeArgv("ABC"), ["-c", `claude --resume "ABC" || claude`]);
});

test("spawnResumePty spawns the shell with the robust resume argv (R4.1)", () => {
  const { calls, spawn } = makeFakeSpawn();
  spawnResumePty({ sessionId: "sess-123", cwd: "/work", baseEnv: { SHELL: "/bin/bash" }, spawn });

  assert.equal(calls.length, 1, "spawn called exactly once");
  assert.equal(calls[0].file, "/bin/bash");
  assert.deepEqual(calls[0].args, ["-c", `claude --resume "sess-123" || claude`]);
});

test("resume reuses the story 013 sanitized env — four billing vars deleted (R4.2)", () => {
  const { calls, spawn } = makeFakeSpawn();
  spawnResumePty({
    sessionId: "X",
    cwd: "/work",
    baseEnv: {
      PATH: "/usr/bin",
      HOME: "/home/u",
      CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
      CLAUDE_AGENT_SDK_VERSION: "0.3.156",
      CLAUDE_AGENT_SDK_CLIENT_APP: "zed",
    },
    spawn,
  });

  const env = calls[0].opts.env as Record<string, string | undefined>;
  for (const key of BILLING_VARS) {
    assert.equal(env[key], undefined, `${key} must be deleted so resume bills as subscription`);
  }
  assert.equal(env.TERM, "xterm-256color", "terminal var set by the sanitized env");
  assert.equal(env.COLORTERM, "truecolor");
  assert.equal(env.FORCE_COLOR, "3");
  assert.equal(env.PATH, "/usr/bin", "unrelated env keys survive");
  assert.equal(env.HOME, "/home/u");
});

test("resume carries no -p/--print/stream-json token (stays on the interactive path)", () => {
  const { calls, spawn } = makeFakeSpawn();
  spawnResumePty({ sessionId: "X", cwd: "/work", baseEnv: {}, spawn });

  const joined = calls[0].args.join(" ");
  for (const forbidden of ["-p", "--print", "stream-json"]) {
    assert.ok(!joined.includes(forbidden), `resume argv must not contain ${forbidden}`);
  }
});

test("resume PTY uses the §5 geometry (xterm-256color, 120x40) and the host cwd", () => {
  const { calls, spawn } = makeFakeSpawn();
  spawnResumePty({ sessionId: "X", cwd: "/host/cwd", baseEnv: {}, spawn });

  const opts = calls[0].opts;
  assert.equal(opts.name, "xterm-256color");
  assert.equal(opts.cols, 120);
  assert.equal(opts.rows, 40);
  assert.equal(opts.cwd, "/host/cwd");
});

test("resume id is double-quoted so it survives shell word-splitting", () => {
  // A defensive shape check: ids are uuids, but the quoting must be literal in the command.
  assert.equal(buildResumeArgv("a b")[1], `claude --resume "a b" || claude`);
});
