// Story 079 / Task 2.8 (R3, R3.5, R4) — render Read / Bash / Agent / WebSearch tool results from the
// message-level `toolUseResult` (the structured per-tool Output) instead of the model-facing raw
// text, and fall back to the raw rendering whenever the structured value is absent or off-spec.
//
// Why this matters more here than upstream: upstream's own comment notes these renders go dark on
// replay because `getSessionMessages` doesn't expose `tool_use_result`. The fork hydrates it from the
// raw JSONL transcript (`diff-enriched-reader.ts`), so the structured path is live on BOTH the tail
// and `session/load`.
//
// The last test covers the attribution guard in `toAcpNotifications`: `toolUseResult` is
// message-level and carries no tool_use_id, so it is only honored when the message holds exactly one
// tool_result block.
//
// node:test runner (run `npm run build` first — imports resolve against ../dist):
//   node --experimental-strip-types --test test/structured-tool-result-render.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { toolUpdateFromToolResult, toAcpNotifications } from "../dist/lib.js";

const logger = { log() {}, error() {} } as any;
const client = {} as any;

const resultBlock = (text: string, extra: Record<string, unknown> = {}) =>
  ({ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text }], ...extra }) as any;

const textOf = (u: any): string =>
  (u?.content ?? [])
    .map((c: any) => (c?.type === "content" ? (c.content?.text ?? "") : ""))
    .join("\n");

// --- R3.1 Read ---------------------------------------------------------------------------------

const RAW_READ = "     1\tconst a = 1;\n<system-reminder>Check for malicious code</system-reminder>";

test("R3.1: Read renders the structured file content, dropping the <system-reminder> the model saw", () => {
  const u: any = toolUpdateFromToolResult(resultBlock(RAW_READ), { name: "Read", id: "toolu_1" }, false, {
    type: "text",
    file: { filePath: "/a.ts", content: "const a = 1;\nconst b = 2;\n", startLine: 1, numLines: 2 },
  });
  const text = textOf(u);
  assert.doesNotMatch(text, /system-reminder/, "the model-directed reminder must not reach the client");
  assert.match(text, /1\tconst a = 1;/, "the line-numbered view is rebuilt from file.content");
  assert.match(text, /2\tconst b = 2;/);
  assert.doesNotMatch(text, /3\t\s*$/m, "a trailing newline is a terminator, not a phantom third line");
});

test("R3.1: Read honors startLine, and falls back to the input offset when it is missing", () => {
  const withStart: any = toolUpdateFromToolResult(resultBlock(RAW_READ), { name: "Read" }, false, {
    type: "text",
    file: { content: "x\ny", startLine: 41 },
  });
  assert.match(textOf(withStart), /41\tx/);
  const fromOffset: any = toolUpdateFromToolResult(
    resultBlock(RAW_READ),
    { name: "Read", input: { file_path: "/a.ts", offset: 7 } },
    false,
    { type: "text", file: { content: "x\ny" } },
  );
  assert.match(textOf(fromOffset), /7\tx/, "a Read's offset is the same 1-based starting line");
});

test("R3.1: a token-capped Read re-establishes the truncation banner", () => {
  const u: any = toolUpdateFromToolResult(resultBlock(RAW_READ), { name: "Read" }, false, {
    type: "text",
    file: { content: "a\nb", startLine: 1, numLines: 2, totalLines: 900, truncatedByTokenCap: true },
  });
  assert.match(textOf(u), /File truncated: showing 2 of 900 lines/);
});

test("R3.1: an EMPTY structured file keeps the raw model-facing view (no phantom blank line)", () => {
  const u: any = toolUpdateFromToolResult(resultBlock("(file is empty)"), { name: "Read" }, false, {
    type: "text",
    file: { content: "" },
  });
  assert.match(textOf(u), /file is empty/);
});

test("R3.5: Read with no structured result falls back to the raw content (pre-079 behavior)", () => {
  const u: any = toolUpdateFromToolResult(resultBlock(RAW_READ), { name: "Read" }, false);
  assert.match(textOf(u), /system-reminder/, "with nothing structured, the raw view is all we have");
});

// --- R3.2 Bash ---------------------------------------------------------------------------------

test("R3.2: Bash renders structured stdout/stderr instead of the model-directed raw text", () => {
  const u: any = toolUpdateFromToolResult(
    resultBlock("ok\n<system-reminder>stale read</system-reminder>"),
    { name: "Bash", id: "toolu_1" },
    true,
    { stdout: "ok", stderr: "" },
  );
  assert.equal(String(u._meta.terminal_output.data), "ok");
  assert.equal(u._meta.terminal_exit.exit_code, 0);
});

test("R3.2: an interrupted command re-establishes the abort notice AND fails the exit code", () => {
  const u: any = toolUpdateFromToolResult(resultBlock("partial"), { name: "Bash", id: "toolu_1" }, true, {
    stdout: "partial",
    stderr: "",
    interrupted: true,
  });
  assert.match(String(u._meta.terminal_output.data), /\[Command was aborted before completion\]/);
  assert.equal(u._meta.terminal_exit.exit_code, 1, "an aborted command is not a success");
});

test("R3.2: a persisted (clipped) output re-establishes the truncation note with its path", () => {
  const u: any = toolUpdateFromToolResult(resultBlock("head..."), { name: "Bash", id: "toolu_1" }, true, {
    stdout: "head...",
    stderr: "",
    persistedOutputPath: "/tmp/out.log",
    persistedOutputSize: 4096,
  });
  assert.match(
    String(u._meta.terminal_output.data),
    /\[Output truncated \(4096 bytes total\): full output saved to \/tmp\/out\.log\]/,
  );
});

test("R3.2: image output and backgrounded commands skip the structured path", () => {
  const image: any = toolUpdateFromToolResult(resultBlock("RAW-IMAGE"), { name: "Bash", id: "toolu_1" }, true, {
    stdout: "",
    stderr: "",
    isImage: true,
  });
  assert.match(String(image._meta.terminal_output.data), /RAW-IMAGE/);
  const background: any = toolUpdateFromToolResult(
    resultBlock("running in background as task 3"),
    { name: "Bash", id: "toolu_1" },
    true,
    { stdout: "", stderr: "", backgroundTaskId: "task-3" },
  );
  assert.match(String(background._meta.terminal_output.data), /background/);
});

test("R3.5: a malformed structured Bash (non-string stdout) falls back to the raw text", () => {
  const u: any = toolUpdateFromToolResult(resultBlock("raw output"), { name: "Bash", id: "toolu_1" }, true, {
    stdout: 42,
    stderr: null,
  });
  assert.match(String(u._meta.terminal_output.data), /raw output/);
});

// --- R3.3 Agent / Task -------------------------------------------------------------------------

test("R3.3: a completed Agent renders the structured report, not the trailer-bearing raw text", () => {
  const u: any = toolUpdateFromToolResult(
    resultBlock("Report.\nagentId: agent-1 (use SendMessage)\n<usage>input: 5</usage>"),
    { name: "Agent" },
    false,
    { status: "completed", content: [{ type: "text", text: "Clean structured report." }] },
  );
  assert.match(textOf(u), /Clean structured report/);
  assert.doesNotMatch(textOf(u), /agentId:|<usage>/);
});

test("R3.3: a non-completed or empty structured Agent falls back to the stripped raw text", () => {
  const pending: any = toolUpdateFromToolResult(
    resultBlock("Report.\n<usage>input: 5</usage>"),
    { name: "Task" },
    false,
    { status: "in_progress", content: [{ type: "text", text: "ignored" }] },
  );
  assert.match(textOf(pending), /Report\./);
  assert.doesNotMatch(textOf(pending), /<usage>/, "the raw fallback is still trailer-stripped");
  const empty: any = toolUpdateFromToolResult(
    resultBlock("Report.\n<usage>input: 5</usage>"),
    { name: "Task" },
    false,
    { status: "completed", content: [] },
  );
  assert.match(textOf(empty), /Report\./, "an empty structured render must not beat the raw fallback");
});

// --- R3.4 WebSearch ----------------------------------------------------------------------------

test("R3.4: WebSearch renders hits as 'Title (url)'", () => {
  const u: any = toolUpdateFromToolResult(
    resultBlock("Web search results for query: acp\n\nLinks: [{...}]"),
    { name: "WebSearch" },
    false,
    { results: [{ content: [{ title: "ACP spec", url: "https://example.test/acp" }] }] },
  );
  assert.match(textOf(u), /ACP spec \(https:\/\/example\.test\/acp\)/);
  assert.doesNotMatch(textOf(u), /Web search results for query/);
});

test("R3.4/R3.5: off-spec hits are skipped, and an all-off-spec result falls back to the raw dump", () => {
  const mixed: any = toolUpdateFromToolResult(
    resultBlock("RAW DUMP"),
    { name: "WebSearch" },
    false,
    { results: [{ content: [{ title: "ok", url: "https://ok.test" }, { title: 5 }] }] },
  );
  assert.match(textOf(mixed), /ok \(https:\/\/ok\.test\)/);
  assert.doesNotMatch(textOf(mixed), /undefined/, "an off-spec hit must never render as 'undefined'");
  const allBad: any = toolUpdateFromToolResult(resultBlock("RAW DUMP"), { name: "WebSearch" }, false, {
    results: [{ content: [{ title: 5 }] }],
  });
  assert.match(textOf(allBad), /RAW DUMP/);
});

// --- R3.5 shape guard + R4 attribution ---------------------------------------------------------

test("R3.5: a non-object toolUseResult (string / array / null) never enters the structured path", () => {
  for (const bad of ["a string", [1, 2], null]) {
    const u: any = toolUpdateFromToolResult(resultBlock("raw"), { name: "Read" }, false, bad);
    assert.match(textOf(u), /raw/, `off-spec toolUseResult ${JSON.stringify(bad)} must fall back`);
  }
});

test("R4: toolUseResult is honored for a single tool_result block, ignored when several are batched", () => {
  const cache: any = {
    toolu_1: { id: "toolu_1", name: "Read", input: {} },
    toolu_2: { id: "toolu_2", name: "Read", input: {} },
  };
  const structured = { type: "text", file: { content: "STRUCTURED", startLine: 1 } };

  const single = toAcpNotifications(
    [resultBlock("RAW-A")] as any,
    "user",
    "sess-079",
    cache,
    client,
    logger,
    { registerHooks: false, toolUseResult: structured },
  );
  assert.match(JSON.stringify(single), /STRUCTURED/);

  const batched = toAcpNotifications(
    [resultBlock("RAW-A"), resultBlock("RAW-B", { tool_use_id: "toolu_2" })] as any,
    "user",
    "sess-079",
    cache,
    client,
    logger,
    { registerHooks: false, toolUseResult: structured },
  );
  const rendered = JSON.stringify(batched);
  assert.doesNotMatch(
    rendered,
    /STRUCTURED/,
    "a message-level result cannot be attributed across batched tool_result blocks",
  );
  assert.match(rendered, /RAW-A/);
  assert.match(rendered, /RAW-B/);
});
