// Story 035 / Task 1.3 — expose the mirror for §9 v1 gating visibility WITHOUT it becoming a
// state source. Validates: a consumer subscribed to the exposed surface (flag ON) receives the
// live chunks for gating visibility; the surface exposes NO mutator that can write back into
// session/engine state (the consumer only ever receives a raw string — an OUTPUT-ONLY surface);
// with the flag OFF the surface yields nothing.
// node:test runner: `npm run test:fork`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { attachAnsiMirror } from "../dist/ansi-mirror.js";

/** Controllable fake PTY whose onData delivers chunks to attached listeners. */
function makeFakePty() {
  const listeners: Array<(chunk: string) => void> = [];
  return {
    onData(listener: (chunk: string) => void) {
      listeners.push(listener);
      return { dispose() { const i = listeners.indexOf(listener); if (i >= 0) listeners.splice(i, 1); } };
    },
    emit(chunk: string) { for (const l of listeners) l(chunk); },
    listenerCount: () => listeners.length,
  };
}

test("flag ON: a consumer subscribed to the exposed surface receives the live chunks (gating visibility)", () => {
  const p = makeFakePty();
  // The host's terminal-view consumer: it renders 'is the prompt alive?' from the live stream.
  const renderedToTerminalView: string[] = [];

  attachAnsiMirror(p as never, {
    enabled: true,
    onAnsiChunk: (chunk) => renderedToTerminalView.push(chunk),
  });

  // The live TUI draws its prompt — the consumer sees it for gating visibility.
  p.emit("\x1b[2J\x1b[H");
  p.emit("Welcome to Claude Code\r\n");
  p.emit("\x1b[38;5;42m> \x1b[0m");

  assert.deepEqual(
    renderedToTerminalView,
    ["\x1b[2J\x1b[H", "Welcome to Claude Code\r\n", "\x1b[38;5;42m> \x1b[0m"],
    "the consumer receives every live chunk verbatim for §9 gating visibility",
  );
});

test("the exposed surface exposes NO mutator that can write back into session/engine state", () => {
  const p = makeFakePty();
  // Capture the FULL argument list the surface delivers to its consumer.
  const deliveries: unknown[][] = [];

  attachAnsiMirror(p as never, {
    enabled: true,
    onAnsiChunk: (...args: unknown[]) => { deliveries.push(args); },
  });

  p.emit("chunk-A");
  p.emit("chunk-B");

  // The surface is OUTPUT-ONLY: each delivery is exactly ONE raw string and nothing else — no
  // engine/session handle, no callback, no mutable object the consumer could use to write back.
  for (const args of deliveries) {
    assert.equal(args.length, 1, "the surface delivers exactly one argument (the chunk) — no back-channel handle");
    assert.equal(typeof args[0], "string", "the sole argument is a raw string — not a mutable engine/session object");
  }
  assert.equal(deliveries.length, 2, "one delivery per live chunk");
});

test("flag OFF (default): the exposed surface yields nothing", () => {
  const p = makeFakePty();
  const rendered: string[] = [];

  // No subscription handle is produced when off; the surface is inert.
  const handle = attachAnsiMirror(p as never, { enabled: false, onAnsiChunk: (c) => rendered.push(c) });
  assert.equal(handle, undefined, "no subscription handle when the surface is off");
  assert.equal(p.listenerCount(), 0, "the surface attaches nothing when off");

  p.emit("nothing should surface");
  assert.deepEqual(rendered, [], "the OFF surface yields nothing for gating visibility");
});

test("the consumer cannot mutate engine state: the sink return value is ignored (one-way surface)", () => {
  const p = makeFakePty();
  // Even if a consumer tries to 'return' something to influence the engine, the mirror ignores it:
  // attachAnsiMirror's handler calls the sink and discards its result — there is no feedback path.
  let sinkInvocations = 0;
  const disposable = attachAnsiMirror(p as never, {
    enabled: true,
    onAnsiChunk: () => { sinkInvocations++; return "attempted-write-back" as unknown as void; },
  });

  p.emit("x");
  // The mirror kept forwarding (the bogus return changed nothing) and exposes only dispose().
  p.emit("y");
  assert.equal(sinkInvocations, 2, "the sink is invoked per chunk; its return value is inert");
  assert.deepEqual(Object.keys(disposable ?? {}), ["dispose"], "the only handle back is dispose() — no state mutator");
});
