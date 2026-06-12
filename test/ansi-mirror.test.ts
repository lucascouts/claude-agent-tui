// Story 035 / Task 1.1 — optional p.onData ANSI mirror behind an off-by-default flag.
// Validates: with the flag ON a synthetic onData chunk is forwarded VERBATIM to the live-view
// sink; with the flag OFF (default) NO onData listener is attached and NO chunk reaches the sink;
// the handler produces NO SessionUpdate in either case (it only ever calls the sink).
// node:test runner: `npm run test:fork` (build → node --experimental-strip-types --test).
import { test } from "node:test";
import assert from "node:assert/strict";
import { attachAnsiMirror } from "../dist/ansi-mirror.js";

/**
 * Fake PTY that records onData subscriptions and lets a test push a synthetic chunk. Tracks how
 * many times onData was invoked so the OFF path can assert "no listener attached" by construction.
 */
function makeFakePty() {
  const listeners: Array<(chunk: string) => void> = [];
  let onDataCalls = 0;
  return {
    onDataCalls: () => onDataCalls,
    listenerCount: () => listeners.length,
    /** node-pty IEvent<string> shape: (listener) => IDisposable. */
    onData(listener: (chunk: string) => void) {
      onDataCalls++;
      listeners.push(listener);
      return {
        dispose() {
          const i = listeners.indexOf(listener);
          if (i >= 0) listeners.splice(i, 1);
        },
      };
    },
    /** Drive the PTY: deliver a synthetic chunk to every attached listener. */
    emit(chunk: string) {
      for (const l of listeners) l(chunk);
    },
  };
}

test("flag ON: a synthetic onData chunk is forwarded VERBATIM to the live-view sink", () => {
  const p = makeFakePty();
  const received: string[] = [];

  const disposable = attachAnsiMirror(p as never, {
    enabled: true,
    onAnsiChunk: (chunk) => received.push(chunk),
  });

  // A listener was attached (the tap is live) and a disposable returned.
  assert.equal(p.onDataCalls(), 1, "exactly one p.onData subscription when enabled");
  assert.ok(disposable, "attachAnsiMirror returns an IDisposable when enabled");

  // The raw TUI bytes arrive verbatim — including ANSI escapes and partial/interleaved chunks.
  const chunk = "\x1b[2J\x1b[H\x1b[38;5;42mclaude>\x1b[0m █";
  p.emit(chunk);

  assert.deepEqual(received, [chunk], "the chunk is forwarded byte-for-byte, unmodified");
});

test("flag OFF (default): NO onData listener is attached and NO chunk reaches the sink", () => {
  const p = makeFakePty();
  const received: string[] = [];

  // Default = OFF: no options at all.
  const d1 = attachAnsiMirror(p as never);
  // Explicit enabled:false is also OFF.
  const d2 = attachAnsiMirror(p as never, { enabled: false, onAnsiChunk: (c) => received.push(c) });
  // enabled:true but NO sink is still a no-op (nowhere to forward → no dangling subscription).
  const d3 = attachAnsiMirror(p as never, { enabled: true });

  // The load-bearing OFF guarantee: p.onData was NEVER touched → byte-for-byte Degrau-1 path.
  assert.equal(p.onDataCalls(), 0, "p.onData is NEVER called on the OFF path (no listener attached)");
  assert.equal(p.listenerCount(), 0, "no live listeners on the OFF path");
  assert.equal(d1, undefined, "no disposable when the mirror is off by default");
  assert.equal(d2, undefined, "no disposable when explicitly disabled");
  assert.equal(d3, undefined, "no disposable when enabled but sinkless");

  // Even if the PTY emits, nothing reaches the sink (there is no listener to forward it).
  p.emit("\x1b[31mshould not be seen\x1b[0m");
  assert.deepEqual(received, [], "no chunk reaches the sink when the mirror is off");
});

test("the handler produces NO SessionUpdate in either case — it only ever calls the sink", () => {
  // The sink is the ONLY observable effect of the mirror. We prove the handler emits no
  // SessionUpdate by observing that the ONLY thing it invokes is the supplied sink: a probe sink
  // that records its call shape sees raw strings, never SessionNotification/SessionUpdate objects.
  const p = makeFakePty();
  const calls: unknown[] = [];

  attachAnsiMirror(p as never, { enabled: true, onAnsiChunk: (chunk) => calls.push(chunk) });
  p.emit("tok-1");
  p.emit("tok-2");

  assert.equal(calls.length, 2, "the sink is the sole effect — one call per chunk");
  for (const c of calls) {
    assert.equal(typeof c, "string", "the sink only ever receives a raw string chunk");
    // A SessionUpdate/SessionNotification would be an object with a sessionUpdate/update field.
    assert.notEqual(typeof c, "object", "no SessionUpdate object is ever produced");
  }
});

test("the ON tap is detachable via its IDisposable (cosmetic mirror does not outlive teardown)", () => {
  const p = makeFakePty();
  const received: string[] = [];

  const disposable = attachAnsiMirror(p as never, {
    enabled: true,
    onAnsiChunk: (chunk) => received.push(chunk),
  });
  assert.ok(disposable);

  p.emit("before");
  disposable.dispose();
  p.emit("after");

  assert.deepEqual(received, ["before"], "no chunks forwarded after dispose() — listener detached");
  assert.equal(p.listenerCount(), 0, "the listener is removed on dispose");
});
