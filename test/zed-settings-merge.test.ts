import { test } from "node:test";
import assert from "node:assert/strict";
import { isAbsolute } from "node:path";
import { buildZedAgentEntry, mergeAgentServer, parseJsonc } from "../dist/zed-register.js";

// Story 027 / Task 1.2 — non-destructive Zed `agent_servers` registration (R1.2, R6.2).
// The fork is registered by merging ONE `agent_servers` entry into the user's Zed
// settings.json. The merge MUST preserve every pre-existing key (read-modify-write a
// parsed copy, never overwrite wholesale) and the built entry MUST carry the §15 shape
// `{ type:"custom", command:"node", args:[<abs>/dist/index.js], env:{} }` with `env`
// LEFT EMPTY (R6.2 — billing sanitization is internal to the spawn, story 013/Task 2.1).
// Zed settings are JSONC (comments + trailing commas), so parseJsonc tolerates both.

const ABS = "/home/user/claude-agent-tui/dist/index.js";

const FIXTURE = `{
  // user's own settings — must survive the merge untouched
  "theme": "dark",
  "ui_font_size": 16,
  "agent_servers": {
    "gemini": { "type": "registry" },
    "codex-acp": { "type": "registry" },
  },
  "soft_wrap": "editor_width",
}`;

// --- buildZedAgentEntry: the §15 entry shape, env left empty (R6.2) -----------------

test("buildZedAgentEntry: produces the §15 custom-spawn shape with empty env (R6.2)", () => {
  const entry = buildZedAgentEntry(ABS);
  assert.deepEqual(entry, { type: "custom", command: "node", args: [ABS], env: {} });
  assert.deepEqual(entry.env, {}, "env MUST be empty — sanitization is internal to the spawn (story 013)");
});

test("buildZedAgentEntry: args[0] is an absolute path ending in dist/index.js", () => {
  const entry = buildZedAgentEntry(ABS);
  assert.ok(isAbsolute(entry.args[0]), "args[0] must be an absolute path");
  assert.ok(entry.args[0].endsWith("dist/index.js"), "args[0] must point at the built dist/index.js");
});

test("buildZedAgentEntry: rejects a relative path or a non-dist/index.js target", () => {
  assert.throws(() => buildZedAgentEntry("fork/dist/index.js"), /absolute/i, "relative path must be rejected");
  assert.throws(() => buildZedAgentEntry("/some/other/file.js"), /dist\/index\.js/i, "wrong target rejected");
});

// --- parseJsonc: tolerates comments + trailing commas (Zed settings are JSONC) ------

test("parseJsonc: tolerates // comments and trailing commas", () => {
  assert.deepEqual(parseJsonc(`{ // hi\n  "a": 1,\n  "b": [1, 2,],\n}`), { a: 1, b: [1, 2] });
});

// --- mergeAgentServer: inserts the new entry, preserves every original key ----------

test("mergeAgentServer: adds the new agent_servers entry under the given name", () => {
  const merged = parseJsonc(mergeAgentServer(FIXTURE, "Claude (assinatura)", buildZedAgentEntry(ABS)));
  assert.deepEqual(merged.agent_servers["Claude (assinatura)"], {
    type: "custom",
    command: "node",
    args: [ABS],
    env: {},
  });
});

test("mergeAgentServer: every original key survives byte-for-byte (no key dropped or mutated)", () => {
  const original = parseJsonc(FIXTURE);
  const merged = parseJsonc(mergeAgentServer(FIXTURE, "Claude (assinatura)", buildZedAgentEntry(ABS)));
  // top-level non-agent_servers keys identical
  assert.equal(merged.theme, original.theme);
  assert.equal(merged.ui_font_size, original.ui_font_size);
  assert.equal(merged.soft_wrap, original.soft_wrap);
  // pre-existing agent_servers entries preserved exactly
  assert.deepEqual(merged.agent_servers.gemini, original.agent_servers.gemini);
  assert.deepEqual(merged.agent_servers["codex-acp"], original.agent_servers["codex-acp"]);
});

test("mergeAgentServer: is idempotent — re-merging the same entry is a fixed point", () => {
  const once = mergeAgentServer(FIXTURE, "Claude (assinatura)", buildZedAgentEntry(ABS));
  const twice = mergeAgentServer(once, "Claude (assinatura)", buildZedAgentEntry(ABS));
  assert.deepEqual(parseJsonc(twice), parseJsonc(once), "merging twice must equal merging once");
});

test("mergeAgentServer: creates agent_servers when the settings have none", () => {
  const merged = parseJsonc(mergeAgentServer(`{ "theme": "dark" }`, "Claude (assinatura)", buildZedAgentEntry(ABS)));
  assert.equal(merged.theme, "dark", "unrelated key preserved");
  assert.ok(merged.agent_servers["Claude (assinatura)"], "agent_servers created with the new entry");
});
