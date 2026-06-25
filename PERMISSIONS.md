# PERMISSIONS.md — the hybrid permission gate

How tool-call permissions reach the Zed client (`session/request_permission`) when the
agent runs `claude` as a real PTY-driven TUI and reads its JSONL transcript, instead of
calling the SDK directly. This is the relay the upstream ACP agent got for free from the
SDK `canUseTool` callback; the JSONL+PTY rewrite has to reconstruct it.

## Overview

The gate is **hybrid**: a loopback **hook server** receives each tool call from `claude`
(a `PreToolUse` hook POST), the fork **correlates** it against the JSONL `tool_use` it
observed, **raises** an ACP `session/request_permission` dialog in Zed, and — on allow —
**clears** the native TUI prompt by injecting a keystroke into the PTY. Every uncertain
path **fails closed** (deny).

```
claude (PTY/TUI) --PreToolUse hook--> hook-server.ts --> gate-wiring.ts decide()
        |                                                      |
        | writes tool_use to JSONL                             | correlate by tool_use.id
        v                                                      v
   transcript --pump (acp-agent.ts)--> correlator.register()   requestPermission()  --> Zed dialog
                                                               |  (allow) armAllowSweep --> PTY keystroke
```

Key modules:

| Module                                  | Role                                                                                                                                                           |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/permissions/hook-server.ts`        | Loopback HTTP server; each `PreToolUse` runs as an independent async handler that calls `decide`.                                                              |
| `src/permissions/gate-wiring.ts`        | `SessionGateImpl`: `decide` → mode shortcuts → correlation wait → raise → sweep; owns the correlator, the native-prompt markers, the per-session serial queue. |
| `src/permissions/request-permission.ts` | `ToolUseCorrelator` (`register`/`isCleanMatch`/`decide`) + `requestPermission` (raise + fail-closed mapping).                                                  |
| `src/permissions/allow-inject.ts`       | `clearNativePrompt` / `keystrokeFor` — types the allow (`"1\r"`) or deny (`"No"`) key into the PTY.                                                            |
| `src/acp-agent.ts` (`pumpUpdates`)      | Feeds the correlator from the JSONL: main-chain ids (`registerGateToolUses`) and, since story 054, sidechain ids.                                              |
| `src/subagent-gate.ts`                  | Pure helpers turning sidechain rows into the correlator's feed.                                                                                                |

## Main-chain tool permission (stories 033/034)

1. The pump reads `getSessionMessages` (main chain) and `registerGateToolUses` records
   every `tool_use.id` into `session.gate.correlator` (exactly once, duplicate-aware).
2. `claude` runs a tool → the `PreToolUse` hook POSTs `{tool_use_id, tool_name, …}` to
   the loopback server → `decide(call)`.
3. `decide` nudges the pump, then `waitForCorrelation(call.toolUseId)` polls until the id
   is a **clean single JSONL match** (or the wait expires).
4. `requestPermission` raises the Zed dialog under `toolCallId = call.toolUseId`, maps the
   user's choice to `allow`/`deny`, and **fails closed** on a missing/duplicate id, a
   transport error, or a `cancelled` outcome.
5. On `allow`, `armAllowSweep` clears the native TUI prompt (#52822) if it still shows.

## Subagent tool permission relay (story 054)

### The gap

Tools called **inside a subagent** (a `Task`/`Agent` spawn) live in the **sidechain**
transcript, not the main chain. The correlator was fed only from the main chain, so a
subagent tool's id was never a clean match → `waitForCorrelation` expired → `deny` was
returned **without ever raising a dialog**. The subagent's tool died silently after ~5 s.
This is the `canUseTool` parity break.

### The fix — five seams (source → register → correlate → raise → inject)

1. **Source + register (`subagent-gate.ts` + `pumpUpdates`).** In the **gated live pump
   only** (never the shared `emitLinearizedWithNested` that `session/load` replay also
   runs — that would break replay==live), after `sourceSubagentRows`, the pump collects
   each inner `tool_use` and registers its id into the correlator **exactly once** via a
   per-session dedup `Set` (`registeredSidechain`), recording each inner id → its
   `SidechainToolUse` in `sidechainParentMap`. A row is a sidechain row when it carries
   `isSidechain === true` **or** a non-empty `parent_tool_use_id` (the only sidechain
   signal in the SDK's reduced live shape — there is no `isSidechain` field live).
2. **Correlate + look up the parent (`gate-wiring.ts` `decide`).** After the correlation
   wait, `decide` consults a session-backed resolver (`ResolveSubagentRelay`, threaded
   through `bindSession`) that maps the inner id → `{parentId, subagentLabel}`. The label
   is derived best-effort from the spawning Task's input (`subagent_type`/`description`),
   falling back to `"subagent"`.
3. **Re-nudge during the wait.** `waitForCorrelation` re-nudges the pump every ~250 ms so
   a sidechain row that materializes mid-wait correlates before the timeout.
4. **Raise under the parent Task (`request-permission.ts`).** When `dialogToolCallId` is
   set, `requestPermission` attaches the ACP dialog to the **parent Task `tool_call` id**
   Zed already rendered (proven accepted by `nestedUpdatesFor`'s re-target), with a title
   naming the inner tool + subagent and `rawInput` = the inner tool's input. The
   correlator still **decides on the inner id**. Main-chain calls (no extra params) are
   byte-identical to before.
5. **Clear the native subagent prompt (`gate-wiring.ts` marker + `allow-inject.ts`).** The
   `SUBAGENT_PROMPT_MARKER` (`"Tool use · from the"`) lets `textShowsNativePrompt`
   recognize the subagent permission box so `clearNativePrompt` types the allow key on
   allow and the deny key on deny — both paths drive the TUI.

### Fail-loud, never silent (R4)

A known/orphan subagent id that cannot be safely relayed — an **orphan** parent
(`parentId === null`, no Task to attach to) or an id that **never correlated** within the
wait window — emits a **visible, logged deny** (through the gate's `onWarn` → the agent's
`logger.error`) naming the subagent and the inner tool, then returns `deny`. It never
raises a dialog against a bogus parent id, and never times out silently.

### Concurrency (R5)

Two subagent tools can fire in parallel (independent hook handlers). A **per-session
serial queue** (`permissionQueue` / `enqueuePermission`) wraps the
`requestPermission` + `armAllowSweep` critical section so their shared-PTY keystrokes
never cross. The concurrent prelude (wait/correlate/resolve, and the orphan/uncorrelatable
deny) stays parallel; distinct inner ids remain independent in the correlator.

### Permission modes (U4)

The mode shortcuts run **before** correlation: `bypassPermissions` auto-allows every tool
(including subagent tools); `acceptEdits` auto-allows edit-class tools. So a subagent tool
is auto-allowed under those modes with no dialog, exactly as a main-chain tool — the
panel's mode selector is honored.

## Fail-closed posture

- A hook arriving before the gate is bound, or racing teardown → `deny`.
- An uncorrelated / duplicate / re-entrant `tool_use.id` → `deny`.
- An ACP transport error or a `cancelled` outcome → `deny`.
- A subagent orphan / never-correlated id → **logged** `deny`.
- A native prompt that does not clear after the keystroke → stuck-prompt warning + HOLD
  (never a silent approve).

## Tests

Unit + integration via `node:test` (`npm run test:fork` / `npm test`):
`subagent-gate`, `pump-subagent-gate-feed`, `request-permission-subagent`,
`gate-subagent-decide`, `gate-subagent-renudge`, `gate-subagent-fallback`,
`gate-subagent-serial`, `allow-inject-subagent` — plus the main-chain
`request-permission-correlation` / `gate-wiring` regression. The in-Zed live proof
(subagent dialog under the parent Task, allow/deny driving the native prompt, two parallel
subagent tools, reduced-shape preserving the inner id) is the deferred manual E2E.
