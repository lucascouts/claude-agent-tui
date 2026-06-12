// Story 023 / Group 1 (sub-task 1.3 — the cascade) — the Session record migrates OFF the SDK Query.
// Unit: the stored Session record exposes pty/watcher/emitted and has NO query/input; and the 6
// control methods reference no `session.query`. The method-body assertions are a SOURCE grep of
// src/acp-agent.ts (the migration is structural, so we pin it at the source).
// node:test runner: `node --experimental-strip-types --test test/session-record-migration.test.ts`
// (run `npm run build` first — behavioral imports resolve against ../dist).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ClaudeAcpAgent } from "../dist/acp-agent.js";

const here = dirname(fileURLToPath(import.meta.url));
const ACP_AGENT_SRC = join(here, "..", "src", "acp-agent.ts");

function makeClient() {
  return {
    sessionUpdate: async () => {},
    requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    readTextFile: async () => ({ content: "" }),
    writeTextFile: async () => ({}),
  } as never;
}

function makeFakeStartEngine() {
  const startEngine = (args: { sessionId?: string; cwd: string }) => ({
    sessionId: args.sessionId ?? "33333333-3333-4333-8333-333333333333",
    pty: {
      onExit: () => ({ dispose() {} }),
      onData: () => ({ dispose() {} }),
      resize: () => {},
      write: () => {},
      kill: () => {},
    } as never,
    watcher: { stop: () => {}, notifyEndOfTurn: () => {} },
    cwd: args.cwd,
  });
  return { startEngine };
}

test("the stored Session record exposes pty/watcher/emitted and has no query/input", async (t) => {
  const agent = new ClaudeAcpAgent(makeClient(), undefined, undefined, makeFakeStartEngine());
  t.after(() => agent.dispose());

  const response = (await (agent as unknown as {
    createSession: (p: unknown, o?: unknown) => Promise<{ sessionId: string }>;
  }).createSession({ cwd: "/host", mcpServers: [] }));

  const session = (agent as unknown as { sessions: Record<string, Record<string, unknown>> })
    .sessions[response.sessionId];

  assert.ok("pty" in session, "Session record has `pty`");
  assert.ok("watcher" in session, "Session record has `watcher`");
  assert.ok(session.emitted instanceof Set, "Session record has `emitted` as a Set");
  assert.ok(!("query" in session), "Session record no longer holds the SDK `query`");
  assert.ok(!("input" in session), "Session record no longer holds the SDK `input` pushable");
});

/**
 * Extract the body of a named method (from its declaration up to the next method/`}` boundary).
 * We bound at the next line that begins a sibling method declaration at the class indent level.
 */
function methodBody(src: string, declaration: string): string {
  const startIdx = src.indexOf(declaration);
  assert.ok(startIdx >= 0, `method not found: ${declaration}`);
  // Find the matching close brace by brace-counting from the first '{' after the declaration.
  const openIdx = src.indexOf("{", startIdx);
  let depth = 0;
  let i = openIdx;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  return src.slice(startIdx, i + 1);
}

test("the 6 migrated control methods reference no `session.query` / `.query.`", () => {
  const src = readFileSync(ACP_AGENT_SRC, "utf8");

  const methods = [
    "async unstable_setSessionModel(",
    "async setSessionConfigOption(",
    "private async applySessionMode(",
    "private async applyConfigOptionValue(",
    "private async sendAvailableCommandsUpdate(",
    "private async teardownSession(",
  ];

  for (const decl of methods) {
    const body = methodBody(src, decl);
    assert.ok(
      !/\.query\./.test(body),
      `${decl.trim()} must not reference \`.query.\` after the Degrau-1 migration`,
    );
    assert.ok(
      !/session\.query\b/.test(body),
      `${decl.trim()} must not reference \`session.query\` after the Degrau-1 migration`,
    );
  }
});

test("teardownSession tears down via the engine handle (cleanup/kill), not query.close()", () => {
  const src = readFileSync(ACP_AGENT_SRC, "utf8");
  const body = methodBody(src, "private async teardownSession(");
  assert.ok(!/query\.close\s*\(/.test(body), "teardownSession must not call query.close()");
  assert.ok(
    /\.cleanup\s*\(|\.kill\s*\(/.test(body),
    "teardownSession must call the engine handle's cleanup()/kill()",
  );
});
