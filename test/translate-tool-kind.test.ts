// Story 019 / Task 2.1 — drive a `tool_use` for every §7-mapped name through the REUSED, unmodified
// `tools.ts` `toolInfoFromToolUse` and assert the resolved ACP `kind`, plus an unmapped name falling
// back to `other`. The map is the authoritative §7 mapping in `tools.ts` — this story applies it
// exhaustively and re-implements NOTHING locally.
//
// REGRESSION GUARD over already-delivered runtime (the kind map ships inside the kept translator,
// story 011). §7 map: Read→read · Write/Edit→edit · Bash→execute · Glob/Grep→search ·
// WebFetch/WebSearch→fetch · Task/Agent→think · ExitPlanMode→switch_mode · default→other.
//
// node:test runner: `node --experimental-strip-types --test test/translate-tool-kind.test.ts`
// (run `npm run build` first — the behavioral import resolves against ../dist).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { toolInfoFromToolUse } from "../dist/lib.js";

const here = dirname(fileURLToPath(import.meta.url));

/** The §7 kind map, exhaustive over every mapped tool name. */
const KIND_MAP: ReadonlyArray<readonly [string, string]> = [
  ["Read", "read"],
  ["Write", "edit"],
  ["Edit", "edit"],
  ["Bash", "execute"],
  ["Glob", "search"],
  ["Grep", "search"],
  ["WebFetch", "fetch"],
  ["WebSearch", "fetch"],
  ["Task", "think"],
  ["Agent", "think"],
  ["ExitPlanMode", "switch_mode"],
];

for (const [name, kind] of KIND_MAP) {
  test(`kind map: ${name} → ${kind}`, () => {
    const info: any = toolInfoFromToolUse({ type: "tool_use", id: "toolu_x", name, input: {} });
    assert.equal(info.kind, kind, `${name} must resolve to kind '${kind}' via the upstream map`);
  });
}

test("kind map: ExitPlanMode → switch_mode, even with a plan input (explicit §7 Aceite)", () => {
  const info: any = toolInfoFromToolUse({
    type: "tool_use",
    id: "toolu_plan",
    name: "ExitPlanMode",
    input: { plan: "ship it" },
  });
  assert.equal(info.kind, "switch_mode");
});

test("kind map: an unmapped name (mcp__x__y) falls back to 'other' (default branch)", () => {
  const info: any = toolInfoFromToolUse({
    type: "tool_use",
    id: "toolu_mcp",
    name: "mcp__some__tool",
    input: {},
  });
  assert.equal(info.kind, "other", "unmapped names must resolve to 'other', never throw");
});

test("the kind map is REUSED from upstream tools.ts (no local re-implementation in this story)", () => {
  // The behavioral import is the upstream public export — a real function, not a local stand-in.
  assert.equal(
    typeof toolInfoFromToolUse,
    "function",
    "toolInfoFromToolUse must be the reused lib export",
  );
  // This story authors NO production mapping: its own test must not re-declare the resolver.
  const self = readFileSync(join(here, "translate-tool-kind.test.ts"), "utf8");
  assert.ok(
    !/function\s+toolInfoFromToolUse\b/.test(self),
    "the story must not re-implement the kind resolver locally",
  );
});
