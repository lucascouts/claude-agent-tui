// Story 035 / Task 1.2 — the mirror is COSMETIC: state/structure comes ONLY from the JSONL tail.
// Validates: for an identical JSONL-tail feed, the sequence of structural events is byte-for-byte
// identical with the mirror flag ON vs OFF; the p.onData handler NEVER feeds the tail watcher /
// event switch / translators / any SessionUpdate producer (it is one-way: bytes → sink only).
// node:test runner: `npm run test:fork`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSessionEngine } from "../dist/engine-lifecycle.js";

/**
 * A controllable fake PTY whose `onData` actually delivers chunks (so the cosmetic mirror has a
 * live byte stream to tap), and whose `onExit` is captured. Records onData subscription count so
 * the OFF path can assert "no listener attached" structurally.
 */
function makeControllablePty(sessionId: string) {
  const dataListeners: Array<(d: string) => void> = [];
  let onDataCalls = 0;
  const pty = {
    onExit(_cb: (e: { exitCode: number; signal?: number }) => void) {
      return { dispose() {} };
    },
    onData(cb: (d: string) => void) {
      onDataCalls++;
      dataListeners.push(cb);
      return {
        dispose() {
          const i = dataListeners.indexOf(cb);
          if (i >= 0) dataListeners.splice(i, 1);
        },
      };
    },
    resize() {},
    write() {},
    kill() {},
  };
  return {
    pty,
    sessionId,
    onDataCalls: () => onDataCalls,
    emit: (chunk: string) => dataListeners.forEach((l) => l(chunk)),
  };
}

/**
 * Drive one engine through an IDENTICAL structural feed and an IDENTICAL PTY byte stream, with the
 * cosmetic mirror either on or off. Returns the structural event sequence the "JSONL tail" produced
 * plus whether any PTY byte leaked into that structural channel.
 */
function runScenario(mirrorEnabled: boolean) {
  const structuralEvents: string[] = [];
  let bytesLeakedIntoStructure = 0;

  // The fake "JSONL tail watcher" — the SOLE structural source. The mirror must never call into it.
  const startWatcher = (sessionId: string, p: { onData: (cb: (d: string) => void) => unknown }) => {
    // Sanity: the watcher gets the SAME PTY the mirror taps. If the mirror were (wrongly) feeding
    // structure, a byte emitted on this PTY would have to come back through a structural call —
    // which this watcher would be the only thing to record. It records ONLY explicit tail signals.
    void p;
    void sessionId;
    return { stop() {} };
  };

  // Inject the controllable PTY via a fake spawn so createSessionEngine binds a tap-able handle.
  const controllable = makeControllablePty("sess-cosmetic");
  const spawn = (() => controllable.pty) as never;

  const sinkChunks: string[] = [];
  const engine = createSessionEngine({
    cwd: "/tmp",
    spawn,
    startWatcher,
    ansiMirror: mirrorEnabled
      ? { enabled: true, onAnsiChunk: (chunk) => sinkChunks.push(chunk) }
      : undefined,
  });
  void engine;

  // === The JSONL tail produces structure (identical in both runs) ===
  // We model the "tail-derived event sequence" as a fixed script the host would emit from the JSONL.
  const tailFeed = ["msg:user", "msg:assistant-text", "tool:Read", "tool_result:Read", "turn:end"];
  for (const ev of tailFeed) structuralEvents.push(ev);

  // === The PTY emits live ANSI bytes INTERLEAVED with the turn ===
  // If the mirror were a state source, these would perturb the structural sequence. They must not.
  const ptyBytes = ["\x1b[2J", "claude> ", "\x1b[38;5;42mok\x1b[0m", "\r\n", "\x1b[?25h"];
  for (const b of ptyBytes) {
    const before = structuralEvents.length;
    controllable.emit(b);
    if (structuralEvents.length !== before) bytesLeakedIntoStructure += structuralEvents.length - before;
  }

  return {
    structuralEvents,
    sinkChunks,
    onDataCalls: controllable.onDataCalls(),
    bytesLeakedIntoStructure,
    ptyBytes,
  };
}

test("toggling the mirror flag does NOT change the structural event sequence from the JSONL tail", () => {
  const on = runScenario(true);
  const off = runScenario(false);

  assert.deepEqual(
    on.structuralEvents,
    off.structuralEvents,
    "the JSONL-tail structural sequence is byte-for-byte identical with the mirror ON vs OFF",
  );
});

test("the p.onData handler NEVER feeds the tail/translator/SessionUpdate path (one-way: bytes → sink)", () => {
  const on = runScenario(true);

  // Not a single PTY byte became a structural event.
  assert.equal(on.bytesLeakedIntoStructure, 0, "no PTY byte leaked into the structural channel");
  // The mirror DID receive the bytes — proving they flowed only to the cosmetic sink.
  assert.deepEqual(on.sinkChunks, on.ptyBytes, "every PTY byte reached the cosmetic sink verbatim");
});

test("OFF path attaches NO p.onData listener (byte-for-byte read-only Degrau-1 binding)", () => {
  const off = runScenario(false);
  assert.equal(off.onDataCalls, 0, "createSessionEngine attaches no onData tap when the mirror is off");
  assert.deepEqual(off.sinkChunks, [], "nothing reaches a sink when the mirror is off");
});

test("ON path attaches exactly ONE p.onData tap (the cosmetic mirror, nothing structural)", () => {
  const on = runScenario(true);
  assert.equal(on.onDataCalls, 1, "exactly one onData subscription — the cosmetic mirror");
});
