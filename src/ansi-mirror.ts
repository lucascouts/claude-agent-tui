// === §5 Espelho ANSI ao vivo (opcional) — cosmetic live PTY mirror (story 035) ===
//
// Optional, flag-gated tap on the story-013/014 PTY's `p.onData(chunk => …)` stream that
// forwards the RAW TUI bytes to a "live-view" sink, for the §5 "ao vivo" effect ONLY. Its sole
// purpose is the §9 v1 gating-visibility surface: a human can render this stream to confirm the
// real `claude` prompt is alive and drawing in-TUI, WITHOUT it ever becoming a structural input.
//
// ── tail-as-source-of-truth fence (§2 ordering) ──────────────────────────────────────────────
// This mirror is STRICTLY subordinate to the JSONL tail (stories 015/016/017). It:
//   • holds NO parsed state — it is stateless and one-way (bytes → sink, nothing read back);
//   • emits NO ACP `SessionUpdate` — it never calls the tail watcher, the event switch, the
//     translators, or any `SessionUpdate` producer (structure/state come ONLY from the JSONL);
//   • does NOT decode/parse ANSI — the byte stream is interleaved/partial across chunks, so any
//     parse attempt would corrupt state; it forwards the chunk verbatim and nothing else;
//   • touches NO billing and has NO IO side-effect beyond the single sink call.
// ANY future code that derives session state from `onData` bytes is a §2 violation by construction.
//
// ── OFF is byte-for-byte the read-only Degrau-1 path (story 023) ─────────────────────────────
// The flag is OFF by default. When disabled, {@link attachAnsiMirror} returns WITHOUT calling
// `p.onData` at all — no listener is ever attached — so the engine path is identical to the
// read-only Degrau-1 behaviour. Enabling/disabling the mirror changes NOTHING in the structural
// output: the JSONL tail produces the identical event sequence with the mirror on or off.
//
// ── §7 caveat: streamEventToAcpNotifications stays UNWIRED in v1 ──────────────────────────────
// `streamEventToAcpNotifications` (`content_block_delta` deltas) is left without a source in the
// JSONL (which is per-block granular, §7); it would ONLY be viable layered ON TOP of this cosmetic
// mirror. But this mirror has NO ordering or structural guarantees (structure still comes from the
// JSONL tail per §2), so wiring deltas onto it is DELIBERATELY left undone in v1. This module
// implements NO delta-to-`SessionUpdate` translation, and no such wiring exists in this path.

import type { IPty, IDisposable } from "node-pty";

/**
 * The live-view sink: receives each raw PTY chunk verbatim. This is the OUTPUT-ONLY surface a
 * host may pipe to a terminal view for §9 "is the prompt alive?" gating visibility. It is a sink,
 * not a source — there is deliberately NO return channel by which a consumer could write back into
 * engine/session state. Consumers MUST NOT parse this stream back into session state (§2): state
 * comes only from the JSONL tail.
 */
export type AnsiChunkSink = (chunk: string) => void;

/** Options for {@link attachAnsiMirror}. */
export interface AnsiMirrorOptions {
  /**
   * Master flag — OFF by default (§5/§9). When false/absent, NO `p.onData` listener is attached
   * and the engine path is byte-for-byte the read-only Degrau-1 behaviour. Only when true AND a
   * sink is supplied is the cosmetic tap subscribed.
   */
  enabled?: boolean;
  /**
   * The live-view sink that receives each raw chunk verbatim. The tap is a no-op (and no listener
   * is attached) when this is absent, so the mirror cannot accidentally subscribe with nowhere to
   * forward to.
   */
  onAnsiChunk?: AnsiChunkSink;
}

/**
 * Conditionally tap the PTY's `p.onData` stream for the cosmetic live ANSI mirror (§5).
 *
 * When the mirror is ENABLED (flag on AND a sink supplied), subscribes a stateless `p.onData`
 * listener that forwards each raw chunk VERBATIM to the sink — no parsing, no ANSI decoding, no
 * state accumulation, no `SessionUpdate`, no billing — and returns the `IDisposable` so the caller
 * can detach it on teardown.
 *
 * When the mirror is DISABLED (the default — flag off OR no sink), `p.onData` is NEVER touched and
 * the function returns `undefined`. This is the load-bearing guarantee that the OFF path is
 * byte-for-byte the read-only Degrau-1 engine path: a disabled mirror attaches no listener at all.
 *
 * The mirror is structurally subordinate to the JSONL tail (§2): it is one-way (bytes → sink) and
 * feeds NOTHING into the structural path. Toggling it on/off does not change the structural event
 * sequence the JSONL tail produces.
 */
export function attachAnsiMirror(
  p: Pick<IPty, "onData">,
  opts: AnsiMirrorOptions = {},
): IDisposable | undefined {
  // OFF path (default): do NOT touch p.onData. No listener is attached → byte-for-byte the
  // read-only Degrau-1 path. The `onAnsiChunk` guard means an enabled-but-sinkless config is also
  // a no-op (it would have nowhere to forward to), never a dangling subscription.
  if (!opts.enabled || !opts.onAnsiChunk) {
    return undefined;
  }

  const sink = opts.onAnsiChunk;
  // ON path: forward the raw chunk verbatim. STATELESS and one-way — bytes → sink ONLY. This
  // handler deliberately does NOT call the tail watcher (015), the event switch (016), the
  // translators, or any `SessionUpdate` producer (§2). Deriving any state from `chunk` here would
  // be a §2 violation: structure/state come solely from the JSONL tail.
  return p.onData((chunk) => {
    sink(chunk);
  });
}
