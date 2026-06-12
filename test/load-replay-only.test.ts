// Story 027 live-acceptance regression: Degrau-1 `session/load` is REPLAY-ONLY.
//
// Caught in-Zed (2026-06-07): reopening a thread spawned a live `claude --resume`, which (a) re-emitted
// the whole history through the tail pump (double render) and (b) ran with the fork process cwd
// (≠ the session cwd), writing a duplicate-basename transcript that made the sessionId glob ambiguous
// → "Resource not found" on the next load. In Degrau-1 (read-only, no in-Zed input) reopening a prior
// session is purely to VIEW it, so loadSession must locate + replay the transcript WITHOUT spawning a
// live resume.
//
// node:test: `node --experimental-strip-types --test test/load-replay-only.test.ts` (build first).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeAcpAgent, defaultStartEngine } from "../dist/acp-agent.js";

const NOOP_PTY = {
  onExit: () => ({ dispose() {} }),
  onData: () => ({ dispose() {} }),
  resize() {},
  write() {},
  kill() {},
} as never;

test("defaultStartEngine replayOnly LOCATES the transcript without spawning claude --resume (027)", async () => {
  let spawnCalls = 0;
  const fakeSpawn = (() => {
    spawnCalls++;
    return NOOP_PTY;
  }) as never;

  const started = await defaultStartEngine({
    sessionId: "11111111-1111-4111-8111-111111111111",
    cwd: "/proj",
    resume: true,
    replayOnly: true,
    spawn: fakeSpawn,
    locateOptions: {
      glob: () => ["/home/x/.claude/projects/-proj/11111111-1111-4111-8111-111111111111.jsonl"],
      now: () => 0,
      sleep: async () => {},
    },
  });

  assert.equal(spawnCalls, 0, "replay-only load must NOT spawn a live `claude --resume`");
  assert.equal(started.engine, undefined, "no live engine is created for a read-only replay");
  assert.equal(started.watcher, undefined, "no tail watcher is armed for a read-only replay (it would re-emit)");
  assert.equal(started.sessionId, "11111111-1111-4111-8111-111111111111", "the resumed session id is preserved");
});

test("loadSession drives the engine in replay-only mode — threads replayOnly:true (027)", async (t) => {
  const capturedArgs: any[] = [];
  const fakeStartEngine = (args: any) => {
    capturedArgs.push(args);
    return {
      sessionId: args.sessionId ?? "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      pty: NOOP_PTY,
      watcher: undefined,
      engine: undefined,
      cwd: args.cwd,
    };
  };
  const client = {
    sessionUpdate: async () => {},
    requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    readTextFile: async () => ({ content: "" }),
    writeTextFile: async () => ({}),
  } as never;
  const agent: any = new ClaudeAcpAgent(client, undefined, undefined, {
    startEngine: fakeStartEngine,
    getMessages: async () => [],
  });
  t.after(() => agent.dispose());

  await agent.loadSession({ sessionId: "11111111-1111-4111-8111-111111111111", cwd: "/proj", mcpServers: [] });

  assert.equal(capturedArgs.length, 1, "loadSession starts exactly one engine");
  assert.equal(capturedArgs[0].replayOnly, true, "loadSession must request replay-only (no live resume)");
});
