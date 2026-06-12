# SEAM-MAP — reuse-vs-rewrite seam of the vendored ACP adapter

This seam map records, for each relevant symbol of the vendored `claude-agent-acp`
adapter, whether the fork **keeps**, **cuts**, or **rewrites** it, and which story
wires that decision in. Every symbol is **anchored by name** (never by line number —
upstream line numbers are volatile). This document is **read-only annotation**: it
describes the seam and changes no runtime behavior or any source symbol. The table
below is assembled incrementally across sub-tasks and stays open for more rows.

| Symbol | Verdict | Target story | Note |
|---|---|---|---|
| `runAcp` | KEEP | 011 | ACP transport entrypoint (stdin/stdout), engine-agnostic — §3 MANTER / §4 "Camada ACP REUSA integral" |
| `ndJsonStream` | KEEP | 011 | ND-JSON stdin/stdout stream wiring — §3 MANTER |
| `AgentSideConnection` | KEEP | 011 | ACP agent-side connection — §3 MANTER |
| `initialize` | KEEP | 011 | depends only on `clientCapabilities` — §3 MANTER |
| `toAcpNotifications` | KEEP | 018/019/020 | pure translator → `SessionNotification[]`; operates on Anthropic content blocks identical to JSONL `message.content` — §3/§4 REUSA |
| `toolInfoFromToolUse` | KEEP | 019 | tools.ts pure translator; `tool_use` → `tool_call` kind — §7 |
| `toolUpdateFromToolResult` | KEEP | 019 | tools.ts; `tool_result` → `tool_call_update` — §7 |
| `toolUpdateFromDiffToolResponse` | KEEP | 021 | tools.ts; `structuredPatch`+`originalFile` → `diff` content — §12; symbol KEEP, the diff *source* is rewritten in 021 |
| `planEntries` | KEEP | 020 | tools.ts; `TodoWrite` → `plan` entries — §7 |
| `taskStateToPlanEntries` | KEEP | 020 | tools.ts; task state → plan entries |
| `getSessionMessages` | KEEP | 015/023 | reused **LIVE** (re-invoked on the end-of-turn signal / short debounce; NO custom parser for v1) per Degrau-0 E5 `REUSE-live` (experiments/DEGRAU0-RESULTS.md, binding decision 1); pure JSONL reader, zero billing — feeds the live read (015) + rewritten core (023) |
| `replaySessionHistory` | KEEP | 026 | reused for `session/load` replay — §11 |
| `createSession` | CUT | 023 | the `query({ prompt, options })` SDK stream-json call ⇒ credit billing — §3 CORTAR / §4 |
| `prompt` | CUT | 023 | the ~590-line `while(true){ session.query.next() }` SDK consumption loop — §3 CORTAR (line numbers volatile) |
| `createSession + prompt()` | REWRITE | 023 | core rewrite — `createSession()` + the `prompt()` loop become PTY + JSONL-tail orchestration — §4 "REESCREVE createSession() + loop prompt()" / §0 |
| `cancel` | CUT | 030 | via `query.interrupt()`; re-implemented against the PTY (`\x03`) in story 030 — §3 |
| `setPermissionMode` | CUT | 032 | via `query.setPermissionMode()`; Degrau-2 gate path — §3 / §9 |
| `canUseTool` | CUT | 032 | SDK permission callback that does **not exist** in the PTY flow — §9; Degrau-2 |
| `claudeCliPath` | CUT | 012 | resolves the SDK-embedded binary; the fork resolves the subscription `claude` from **PATH** instead — §3 (story 012) |
| `streamEventToAcpNotifications` | KEEP (symbol retained, not deleted) BUT DEAD / unwired-in-v1 | 034 | the `content_block_delta` delta path has **no JSONL source** (block granularity only) — §7 caveat; symbol kept (not deleted), stays unwired in v1, viable only atop the optional live ANSI mirror (story 034). DEAD-exception to the KEEP-target rule. |

> **DEAD-exception.** `streamEventToAcpNotifications` is the explicit exception to
> the "every KEEP target is one of {011, 018, 019, 020, 026}" table-completeness
> rule: it is KEEP-as-symbol but DEAD / unwired-in-v1, target **034** (ANSI-mirror
> revival only). The symbol is marked, never removed from the source.

> **KEEP symbols wired by engine/rewrite stories.** Two KEEP symbols are *consumed*
> by stories outside the transport/translator set because that is where they get
> wired into the new engine: `getSessionMessages` (reused LIVE) → 015/023, and
> `toolUpdateFromDiffToolResponse` (KEEP translator) → 021 (the diff *source*
> rewrite). The symbols are kept intact; the target names where they are reused.

### Prior art — PTY engine spawn & lifecycle
The new engine's spawn and lifecycle design **reuses patterns** from prior art —
**siteboon**, **markes76**, and **Glyphic** (§4 "Prior art PTY (siteboon,
markes76, Glyphic) REUSA padrões"; §5). Attributed to the engine-spawn/lifecycle
stories **013** and **014**, so the rewrite reuses proven PTY patterns rather
than inventing them.
