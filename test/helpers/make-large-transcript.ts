// Story 038 / Task 4.1 — deterministic large synthetic transcript generator (resolves story 025
// probe 4.1). Produces an n-slot transcript that, once planted and replayed over the REAL stdio
// transport (acp-wire-large-burst.test.ts), exercises the fork's §11 one-update-per-linearized-event
// guarantee under a hundreds-to-thousands burst — the OVER-THE-WIRE analogue of the in-process
// load-burst.test.ts.
//
// The OUTPUT is a `PlantMessage[]` (the planter at plant-transcript.ts fills the linear `parentUuid`
// chain + uuids + session_id, so the spawned fork's REAL `getSessionMessages` reconstructs every
// turn, not just the leaf) PLUS a computed EXPECTED-UPDATE reference: one entry per `session/update`
// the fork must emit, in order. The test asserts `captured.length === expected.length` and walks the
// two in lockstep, so the no-drop / no-merge / stable-order assertion is exact, not guessed.
//
// Composition (deterministic, seedless — index-driven):
//   • Each slot `i in [0, n)` is either a TEXT slot or a TOOL slot.
//   • TOOL slot every `toolEvery` slots (i % toolEvery === toolEvery - 1): an assistant `tool_use`
//     followed by its user `tool_result`. The tool is **Bash** with a PLAIN STRING result ('ok') —
//     chosen because, with the wire client negotiating NO `_meta.terminal_output` capability,
//     `toAcpNotifications` maps a Bash round-trip to EXACTLY two updates (`tool_call` +
//     `tool_call_update`) and emits NO separate terminal_output notification and NO `{type:'diff'}`
//     update (Bash carries no `toolUseResult` structuredPatch, unlike Edit/Write). That keeps the
//     expected count deterministic.
//   • Every other slot is a TEXT slot: a single text message whose role alternates by slot parity
//     (even = user, odd = assistant), mapping to exactly one `user_message_chunk` /
//     `agent_message_chunk`. Texts are tag-free (`u<i>` / `a<i>`) so `stripLocalCommandMetadata`
//     never strips a user turn to null and the ordered text assertion is unambiguous.
//   • NO `usage` block is attached: the spawned fork runs with the usage flag OFF (production
//     default), so no `usage_update` is emitted regardless — but omitting it keeps the fixture's
//     intent explicit.
//
// Each `tool_use` id is `toolu_<i>` and is referenced by its `tool_result`'s `tool_use_id`, so the
// fork's per-session toolUseCache resolves the result to its open call and the ordered reference can
// pin the exact id on both the `tool_call` and `tool_call_update`.
import type { PlantMessage } from "./plant-transcript.ts";

/** One entry in the expected-update reference: the kind + the identifying content the test pins. */
export type ExpectedUpdate =
  | { kind: "user_message_chunk"; text: string }
  | { kind: "agent_message_chunk"; text: string }
  | { kind: "tool_call"; toolCallId: string }
  | { kind: "tool_call_update"; toolCallId: string };

export interface LargeTranscript {
  /** The turns to plant (chronological). The planter fills the linear parentUuid chain + uuids. */
  messages: PlantMessage[];
  /** One entry per `session/update` the fork must emit, in order (the linearized reference). */
  expected: ExpectedUpdate[];
}

export interface MakeLargeTranscriptOptions {
  /** Insert a Bash tool round-trip on every Nth slot (default 50). Must be >= 2. */
  toolEvery?: number;
}

/**
 * Build a deterministic `n`-slot synthetic transcript plus its expected-update reference.
 *
 * `n` counts SLOTS, not messages: a text slot contributes one message + one update; a tool slot
 * contributes two messages (`tool_use` + `tool_result`) + two updates (`tool_call` +
 * `tool_call_update`). So `messages.length >= n` and `expected.length === messages-derived update
 * count` — the test reads `expected.length` as the exact linearized count.
 *
 * @param n the number of slots (e.g. 2000 for the burst).
 * @param opts `toolEvery` cadence (default 50).
 * @returns the `{ messages, expected }` pair.
 */
export function makeLargeTranscript(
  n: number,
  opts: MakeLargeTranscriptOptions = {},
): LargeTranscript {
  const toolEvery = opts.toolEvery ?? 50;
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`makeLargeTranscript: n must be a non-negative integer; got ${n}`);
  }
  if (!Number.isInteger(toolEvery) || toolEvery < 2) {
    throw new Error(`makeLargeTranscript: toolEvery must be an integer >= 2; got ${toolEvery}`);
  }

  const messages: PlantMessage[] = [];
  const expected: ExpectedUpdate[] = [];

  for (let i = 0; i < n; i++) {
    const isToolSlot = i % toolEvery === toolEvery - 1;
    if (isToolSlot) {
      // A Bash round-trip: assistant tool_use → user tool_result. No structuredPatch / diff (Bash),
      // and (terminal_output capability OFF over the wire) no separate terminal_output notification:
      // exactly two updates.
      const toolCallId = `toolu_${i}`;
      messages.push({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: toolCallId, name: "Bash", input: { command: "ls" } }],
        },
      });
      messages.push({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: toolCallId, content: "ok" }],
        },
      });
      expected.push({ kind: "tool_call", toolCallId });
      expected.push({ kind: "tool_call_update", toolCallId });
    } else {
      // A text slot: role alternates by parity; tag-free text so no user turn strips to null.
      const isAssistant = i % 2 === 1;
      const text = (isAssistant ? "a" : "u") + i;
      messages.push({
        type: isAssistant ? "assistant" : "user",
        message: {
          role: isAssistant ? "assistant" : "user",
          content: [{ type: "text", text }],
        },
      });
      expected.push(
        isAssistant ? { kind: "agent_message_chunk", text } : { kind: "user_message_chunk", text },
      );
    }
  }

  return { messages, expected };
}
