// Port of upstream #1035 (97394d9) — a custom slash skill typed as `/name args` is persisted by the
// CLI as a user record carrying ONLY markers:
//   <command-message>name</command-message>\n<command-name>/name</command-name>\n<command-args>args</command-args>
// `stripLocalCommandMetadata` stripped every marker and dropped the record as "nothing left", so the
// user's prompt vanished from a loaded thread (and from the live pump, which shares the same emit).
// Marker-only records are now reconstructed as "/name args", EXCEPT:
//   - records carrying `<local-command-stdout>`/`<local-command-stderr>` (client-local output);
//   - commands whose record is local UI noise: upstream's /context /heapdump /extra-usage /compact
//     /model /status /usage, plus the tui's own PTY injects — `/effort <level>` and `/fast on|off`
//     from the config-option applies, and the `/fast` availability probe. Those reach the CLI
//     transcript as marker-only records exactly like a user-typed command, so without an entry each
//     config change would surface in the thread as a prompt the user never sent.
//
// node:test runner: `npm run build` first (the behavioural import resolves against ../dist), then
//   node --experimental-strip-types --test test/replay-slash-skill-prompt.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeAcpAgent, stripLocalCommandMetadata } from "../dist/acp-agent.js";

/** The exact record shape the CLI writes for a slash invocation (indentation as observed live). */
const record = (name: string, args: string) =>
  `<command-name>${name}</command-name>\n            <command-message>${name.slice(1)}</command-message>\n            <command-args>${args}</command-args>`;

test("a marker-only slash skill record is reconstructed as `/name args`", () => {
  assert.equal(
    stripLocalCommandMetadata(record("/example-skill", "explain the startup decision")),
    "/example-skill explain the startup decision",
  );
  assert.equal(stripLocalCommandMetadata(record("/example-skill", "")), "/example-skill");
  assert.equal(
    stripLocalCommandMetadata(record("/bentoo-dev:bentoo", "bump mesa")),
    "/bentoo-dev:bentoo bump mesa",
    "a plugin-namespaced skill keeps its namespace",
  );
});

test("the array-of-blocks path reconstructs the same prompt", () => {
  assert.deepEqual(
    stripLocalCommandMetadata([{ type: "text", text: record("/example-skill", "explain") }]),
    [{ type: "text", text: "/example-skill explain" }],
  );
});

test("records carrying local stdout/stderr stay hidden", () => {
  for (const tag of ["local-command-stdout", "local-command-stderr"]) {
    assert.equal(
      stripLocalCommandMetadata(`${record("/example-skill", "explain")}<${tag}>handled</${tag}>`),
      null,
      tag,
    );
  }
});

test("client-local commands, including the tui's own PTY injects, stay hidden", () => {
  const hidden: Array<[string, string]> = [
    ["/model", "opus"],
    ["/effort", "high"],
    ["/fast", "on"],
    ["/fast", "off"],
    ["/fast", ""],
    ["/compact", ""],
    ["/context", ""],
    ["/status", ""],
    ["/usage", ""],
    ["/heapdump", ""],
    ["/extra-usage", ""],
  ];
  for (const [name, args] of hidden) {
    assert.equal(stripLocalCommandMetadata(record(name, args)), null, `${name} ${args}`);
  }
});

test("a command-name without a leading slash is not reconstructed", () => {
  assert.equal(stripLocalCommandMetadata("<command-name>example-skill</command-name>"), null);
});

test("the pump emits the reconstructed prompt and nothing for a config inject", async (t) => {
  const captured: any[] = [];
  const client = {
    sessionUpdate: async (n: any) => {
      captured.push(n);
    },
    requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    readTextFile: async () => ({ content: "" }),
    writeTextFile: async () => ({}),
  } as never;
  const messages = [
    {
      uuid: "u1",
      type: "user",
      message: { role: "user", content: record("/example-skill", "explain") },
    },
    { uuid: "u2", type: "user", message: { role: "user", content: record("/effort", "high") } },
  ];
  const agent: any = new ClaudeAcpAgent(client, undefined, undefined, {
    startEngine: (args: { sessionId?: string; cwd: string }) => ({
      sessionId: args.sessionId ?? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      pty: {
        onExit: () => ({ dispose() {} }),
        onData: () => ({ dispose() {} }),
        resize() {},
        write() {},
        kill() {},
      } as never,
      watcher: { stop() {}, notifyEndOfTurn() {} },
      cwd: args.cwd,
    }),
    getMessages: async () => messages as never,
  });
  t.after(() => agent.dispose());
  const { sessionId } = await agent.createSession({ cwd: "/work", mcpServers: [] });

  await agent.pumpUpdates(sessionId);

  const chunks = captured.filter((n) => n.update.sessionUpdate === "user_message_chunk");
  assert.deepEqual(
    chunks.map((n) => n.update.content),
    [{ type: "text", text: "/example-skill explain" }],
  );
});
