# LINEARIZATION.md — tree → ordered turns (story 017)

How the fork turns a `<sessionId>.jsonl` transcript *tree* (`uuid` ← `parentUuid`, with
`isSidechain` subagent branches, forks, re-prompts, and a post-`/compact` `summary` anchor) into the
single *linear* turn order Zed's Agent Panel consumes. Implemented in `src/linearize.ts`; consumed by
the §7 translator (stories 018–021) and the `session/load` replay (stories 011/023).

## 1. Source of the order — reuse `getSessionMessages` (do not write a parser)

The linearization is **sourced from `getSessionMessages(sessionId, { dir })`** (Degrau-0 E5 verdict
`REUSE-live`; `experiments/DECISION-E5.md`). The SDK already parses the transcript, builds the
conversation chain via `parentUuid` links **internally**, resolves forks/re-prompts/compact anchors,
filters `isSidechain`/`isMeta`/`system`, and returns only the **main-chain user/assistant messages in
chronological order**. We adopt that array order verbatim (`readOrderedMessages`, R1.1) — billing-free,
re-parse p50 ≤ 4.67 ms for 1 MB / 2000 msgs, **0 linearization divergences** (E5).

`readOrderedTurns(sessionId, dir)` = `readOrderedMessages` + `linearizeTurns` is the **single seam**
both the live re-parse path and the replay path call, so they cannot diverge (R3.3).

## 2. Reconciliation to the real SDK shape (important)

The design was written against an assumed `SessionMessage` carrying `parentUuid`/`isSidechain`/
`isMeta`/`cwd`/`timestamp`. The **empirically-verified** shape (story 015 `src/jsonl.ts`;
`sdk.d.ts` `SessionMessage`) is **reduced**:

```
{ type: 'user' | 'assistant' | 'system', uuid, session_id, message, parent_tool_use_id }
```

`getSessionMessages` pre-filters sidechains/meta and returns the **main chain only** (E5:
"returning 4 main-chain messages"). Real subagent rows live in **separate** files
(`subagents/agent-<agentId>.jsonl`, observed in-corpus) reachable via `getSubagentMessages(sessionId,
agentId)`; those rows carry `isSidechain: true` and correlate by **`agentId`** (their
`parentToolUseId` is `null`). Consequences, all reconciled in `src/linearize.ts` and recorded in
`.draft/deviations.yaml`:

- **Order key** is uuid-anchored by **monotonic array position** (`chainPositionKey(uuid, index)`),
  not by `parentUuid` (absent live). The E5 monotonic-ordered-**superset** property makes a prefix
  re-parse keep every prior position, so a turn at order *k* stays *k* after appends (R3.1/R3.2):
  prior `orderKey`s are never reshuffled, re-keyed, or re-emitted.
- **Sidechain detection**: `isSidechain` when a raw/fallback row carries it, else inferred from a
  non-null `parent_tool_use_id`. On the pure live path there are no sidechain rows to detect, so the
  partition is a no-op there; it activates for raw fixtures, the R1.3 `fallback`, and a future
  `getSubagentMessages` merge.
- **Live nesting of real subagent rows requires `getSubagentMessages` (agentId-keyed)** — flagged as
  the follow-up to fully satisfy R2.2/R5 on the live path; story 017 sources `getSessionMessages` only.

## 3. Sidechain flattening policy — `nested` (default)

Chosen policy: **`nested` via `parent_tool_use_id`** (design Key Decision 2). Each sidechain
(subagent) event is attached under its spawning `Agent`/`Task` `tool_use` (kind `think`, §7 map), so
it renders under that `tool_call` and **never** as a free-standing top-level turn; the top-level turn
count equals the main-chain count.

- `applySidechainPolicy(messages, policy)` → `{ topLevel, nestedByToolUseId }`.
- `linearizeTurns` attaches resolved children to the spawning parent turn via `Turn.nested`.

Rationale: subagent runs are *caused by* a main-chain `tool_use`; nesting preserves causality and
matches how the translator attaches tool lifecycle by `toolCallId`. Alternatives are selectable and
leave the main-turn order untouched (R2.3 — the main-turn subsequence is byte-identical across all
three): **`hidden`** drops sidechains (loses subagent visibility); **`inline`** merges them in
chronological position (risks merging two logical turns). **Reversibility:** the policy is a single
opt — if real-Zed rendering of `nested` tool content proves poor, switch the default; nothing else
changes.

- **Orphan** (a sidechain whose `parent_tool_use_id` does not resolve to a main-stream tool_use): it
  is placed **inline** in chronological position (never dropped) and logged once as drift (R2.3).

## 4. Edge cases

- **Fork** (a `parentUuid` with two children, e.g. an edited re-prompt): the surviving chain is
  selected; abandoned branch turns are absent (R4.1). Resolved by `getSessionMessages` live; by the
  `fallback`'s tip-walk in the contingency path.
- **Re-prompt** (re-anchored to an earlier ancestor): placed chronologically with **no ancestor
  duplication** (R4.2).
- **Post-`/compact` `summary`**: treated as a continuity **anchor**, not a rendered turn — excluded
  from the top level; the linear order stays continuous across the boundary (R4.3). `system` rows are
  likewise non-turn anchors.
- **Empty / single-turn / orphan-only**: returns `[]` or the available turns; never crashes.

## 5. R1.3 contingency — `buildChainEquivalent` (gated OFF)

If a future binary makes `getSessionMessages` unavailable/non-equivalent for the live path,
`buildChainEquivalent(rawLines, { enabled: true })` is a behavioral **fallback** mirror over RAW
JSONL (where `parentUuid`/`isSidechain`/`isMeta` actually exist): parse → filter `isSidechain`/
`isMeta`/`system` → walk the `parentUuid` chain backward from the latest tip to the root → reverse
(dropping abandoned fork branches). It is **disabled by default** — it is the contingency only, NOT
the v1 path (E5 `REUSE-live` is). Stub limitation: the tip is the last main row in file order.

## 6. Reference test

`fixtures/lin-task-sidechain.{jsonl,expected.json}` pin the linearized order (uuid + stable
`orderKey` + nested attachment) of a real-shape Task/sidechain transcript, asserted through the shared
`readOrderedTurns` seam (`test/lin-reference-order.test.ts`, R5). Content is synthesized — the source
transcript is a client project and is not committable — but the field shapes mirror the observed
corpus (`subagents/agent-*.jsonl`: `isSidechain`, `agentId`; main: `Agent` tool_use; `summary`
anchor).
