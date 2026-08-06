// Story 079 / Task 1.3 (R1, R1.1) — the Bash terminal metas must key off the id the client was
// actually told about.
//
// `toolInfoFromToolUse` announces the terminal under `toolUse.id`, so the output/exit metas must use
// that same id. The old code read only `toolResult.tool_use_id` and coerced it with `String(...)`,
// which turned an absent field into the literal `"undefined"` and an absent block-level id into `""`
// — both of them ids no terminal was ever created for. A client that buffers output/exit until a
// matching terminal create (Zed's `pending_terminal_output`/`pending_terminal_exit`) then holds them
// forever and shows an empty terminal.
//
// Ported from upstream #917 (v0.63.0). Unit test over the translator directly (build first —
// imports resolve against ../dist):
//   node --experimental-strip-types --test test/bash-terminal-id-source.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { toolUpdateFromToolResult } from "../dist/tools.js";

const bashResult = (extra: Record<string, unknown> = {}) =>
  ({ type: "tool_result", content: [{ type: "text", text: "hello" }], ...extra }) as any;

test("R1: the announced tool_use.id wins over the result block's tool_use_id", () => {
  const u: any = toolUpdateFromToolResult(
    bashResult({ tool_use_id: "toolu_BLOCK" }),
    { name: "Bash", id: "toolu_ANNOUNCED" },
    true,
  );
  assert.equal(u.content[0].terminalId, "toolu_ANNOUNCED");
  assert.equal(u._meta.terminal_info.terminal_id, "toolu_ANNOUNCED");
  assert.equal(u._meta.terminal_output.terminal_id, "toolu_ANNOUNCED");
  assert.equal(u._meta.terminal_exit.terminal_id, "toolu_ANNOUNCED");
});

test("R1: the result block's tool_use_id is still used when the tool_use carries no id", () => {
  const u: any = toolUpdateFromToolResult(
    bashResult({ tool_use_id: "toolu_BLOCK" }),
    { name: "Bash" },
    true,
  );
  assert.equal(u.content[0].terminalId, "toolu_BLOCK", "the pre-079 source remains the fallback");
});

test("R1.1: no id anywhere → no terminal content, no terminal metas, code-block fallback", () => {
  const u: any = toolUpdateFromToolResult(bashResult(), { name: "Bash" }, true);
  assert.equal(u._meta, undefined, "emitting metas for an unknown terminal strands them in the client");
  assert.equal(u.content[0].type, "content", "it falls through to the code-block rendering");
  assert.match(String(u.content[0].content.text), /```console/);
  assert.match(String(u.content[0].content.text), /hello/);
});

test("R1.1: a present-but-undefined tool_use_id is absent, never the literal 'undefined'", () => {
  const u: any = toolUpdateFromToolResult(
    bashResult({ tool_use_id: undefined }),
    { name: "Bash" },
    true,
  );
  const rendered = JSON.stringify(u);
  assert.doesNotMatch(rendered, /"undefined"/, `String(undefined) must never become an id: ${rendered}`);
  assert.equal(u._meta, undefined);
});

test("R1.1: an empty-string id is absent (it matches no terminal)", () => {
  const u: any = toolUpdateFromToolResult(bashResult({ tool_use_id: "" }), { name: "Bash", id: "" }, true);
  assert.equal(u._meta, undefined);
  assert.equal(u.content[0].type, "content");
});

test("R1.1: a non-string id is absent", () => {
  const u: any = toolUpdateFromToolResult(bashResult({ tool_use_id: 42 }), { name: "Bash" }, true);
  assert.equal(u._meta, undefined);
});

test("R1 regression: an errored Bash with an announced id still exits 1 under that id (#776)", () => {
  const u: any = toolUpdateFromToolResult(
    bashResult({ is_error: true, tool_use_id: "toolu_BLOCK" }),
    { name: "Bash", id: "toolu_ANNOUNCED" },
    true,
  );
  assert.equal(u._meta.terminal_exit.exit_code, 1);
  assert.equal(u._meta.terminal_exit.terminal_id, "toolu_ANNOUNCED");
});
