// Upstream #986 (v0.67.0), ported — the `Skill` tool renders as its own tool call instead of
// falling through to the generic `Other` arm, and the skill's NAME (plus, when locatable, the
// absolute path of its SKILL.md) travels in `_meta.claudeCode` so a client can render the block
// without parsing the title string.
//
// WHY THIS IS REACHABLE ON THIS ENGINE, unlike most of the v0.67→v0.70 window: the fork reads what
// `claude` persisted to the JSONL, and `Skill` arrives there as a real `tool_use` block carrying
// `input.skill` — measured at port time in 73 of 3 515 local transcripts. No new source is needed,
// so this is an ordinary translator port over KEEP seams (`toolInfoFromToolUse`,
// `toolUpdateFromToolResult`), not a stream-only signal like #990's model-fallback advisory.
//
// The `_meta` half is asserted through `toAcpNotifications` rather than against the helper directly:
// `claudeCodeMetaFromToolUse` is module-private, and what matters is that the four call sites that
// build `_meta.claudeCode` all route through it — a test on the helper alone would still pass if a
// call site kept its old inline literal.
//
// node:test runner: `node --experimental-strip-types --test test/skill-tool-call.test.ts`
// (run `npm run build` first — the behavioral imports resolve against ../dist).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyEvent } from "../dist/event-switch.js";
import { toAcpNotifications, toolInfoFromToolUse, toolUpdateFromToolResult } from "../dist/lib.js";

const logger = { log() {}, error() {} } as any;
const client = {} as any;

function skillToolUse(input: unknown, id = "toolu_skill") {
  return { type: "tool_use" as const, id, name: "Skill", input };
}

/** Compose the read seam exactly as production does: event → classifyEvent → translator. */
function translate(block: unknown, options: Record<string, unknown> = {}) {
  const event = {
    uuid: "p1",
    type: "assistant",
    userType: "external",
    message: { role: "assistant", content: [block] },
  };
  const c: any = classifyEvent(event as any);
  return toAcpNotifications(c.content, c.role, "sess-986", {}, client, logger, {
    registerHooks: false,
    ...options,
  });
}

// ---------------------------------------------------------------- toolInfoFromToolUse

test("Skill tool_use: title names the skill and the kind is `other`", () => {
  const info: any = toolInfoFromToolUse(skillToolUse({ skill: "commits" }));
  assert.equal(info.title, "Load skill: commits");
  assert.equal(info.kind, "other");
  assert.deepEqual(info.content, []);
});

test("Skill tool_use: a missing skill name degrades to the bare label, never `undefined`", () => {
  for (const input of [undefined, {}, { skill: undefined }]) {
    const info: any = toolInfoFromToolUse(skillToolUse(input));
    assert.equal(info.title, "Load skill", `input ${JSON.stringify(input)}`);
    assert.equal(info.kind, "other");
  }
});

test("Skill tool_use: no longer falls through to the generic `Other` arm (regression guard)", () => {
  // Before the port the `default` arm titled the block with the raw tool name and dumped the
  // JSON input as expandable content. Both are what this port removes.
  const info: any = toolInfoFromToolUse(skillToolUse({ skill: "commits" }));
  assert.notEqual(info.title, "Skill");
  assert.deepEqual(info.content, []);
});

// ------------------------------------------------------------ toolUpdateFromToolResult

test("Skill tool_result: the `Launching skill: …` restatement is suppressed", () => {
  const update: any = toolUpdateFromToolResult(
    {
      type: "tool_result",
      tool_use_id: "toolu_skill",
      content: [{ type: "text", text: "Launching skill: commits" }],
    } as any,
    { name: "Skill", id: "toolu_skill" },
  );
  assert.deepEqual(update, {});
});

test("Skill tool_result: a FAILED skill still surfaces its error", () => {
  // The error early-return sits ahead of the switch, so suppressing the success text must not
  // swallow a failure — the user would otherwise see a skill block that silently did nothing.
  const update: any = toolUpdateFromToolResult(
    {
      type: "tool_result",
      tool_use_id: "toolu_skill",
      is_error: true,
      content: [{ type: "text", text: "Skill not found: nope" }],
    } as any,
    { name: "Skill", id: "toolu_skill" },
  );
  assert.ok(update.content?.length > 0, "an errored Skill result must not be suppressed");
  assert.match(JSON.stringify(update.content), /Skill not found/);
});

// ------------------------------------------------------------------------ _meta wiring

test("Skill tool_call: `_meta.claudeCode.skill` carries the name over the seam", () => {
  const [n] = translate(skillToolUse({ skill: "commits" })) as any[];
  assert.equal(n.update.sessionUpdate, "tool_call");
  assert.equal(n.update._meta.claudeCode.toolName, "Skill");
  assert.equal(n.update._meta.claudeCode.skill, "commits");
});

test("_meta.claudeCode carries NO skill field for a non-Skill tool", () => {
  const [n] = translate({
    type: "tool_use",
    id: "toolu_bash",
    name: "Bash",
    input: { command: "ls" },
  }) as any[];
  assert.equal(n.update._meta.claudeCode.toolName, "Bash");
  assert.ok(!("skill" in n.update._meta.claudeCode), "skill must be absent, not undefined");
  assert.ok(!("skillPath" in n.update._meta.claudeCode));
});

// --------------------------------------------------------------------- skillPath on disk

test("skillPath: resolved when the SKILL.md exists under the cwd, absent when it does not", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "fork-skill-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const dir = join(cwd, ".claude", "skills", "commits");
  mkdirSync(dir, { recursive: true });
  const skillFile = join(dir, "SKILL.md");
  writeFileSync(skillFile, "# commits\n");

  const [hit] = translate(skillToolUse({ skill: "commits" }), { cwd }) as any[];
  assert.equal(hit.update._meta.claudeCode.skillPath, skillFile);

  // A name with no file on disk costs nothing: the field is simply omitted, so a client never
  // renders a link to a file that isn't there.
  const [miss] = translate(skillToolUse({ skill: "absent" }, "toolu_miss"), { cwd }) as any[];
  assert.equal(miss.update._meta.claudeCode.skill, "absent");
  assert.ok(!("skillPath" in miss.update._meta.claudeCode));
});

test("skillPath: a `<prefix>:<name>` spelling probes the plugin layout too", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "fork-skill-plugin-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const dir = join(cwd, ".claude", "plugins", "epic", "skills", "epic");
  mkdirSync(dir, { recursive: true });
  const skillFile = join(dir, "SKILL.md");
  writeFileSync(skillFile, "# epic\n");

  const [n] = translate(skillToolUse({ skill: "epic:epic" }), { cwd }) as any[];
  assert.equal(n.update._meta.claudeCode.skill, "epic:epic");
  assert.equal(n.update._meta.claudeCode.skillPath, skillFile);
});

test("skillPath: absent without a cwd — the fork never probes from an unknown root", () => {
  const [n] = translate(skillToolUse({ skill: "commits" })) as any[];
  assert.ok(!("skillPath" in n.update._meta.claudeCode));
});
