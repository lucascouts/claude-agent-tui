// Shared fakes for the story 014 PTY-lifecycle tests (node:test runner).
//
// NOT a `*.test.ts` file, so the `test/*.test.ts` glob does NOT execute it — it is imported
// by the lifecycle test modules. Run with:
//   node --experimental-strip-types --test test/engine-lifecycle-*.test.ts
//
// These fakes let the lifecycle tests exercise the SessionEngine contract WITHOUT launching a
// real `claude` PTY: a fake IPty records resize/write/kill and lets the test fire `onExit`,
// and a fake watcher counts stop() calls. The set grows with the story — Task 2 adds a
// deterministic timer pair (debounce), Task 4 adds a fake spawn (resume argv/env).
import type { IPty } from "node-pty";

/** Recorded interactions against a {@link makeFakePty} handle. */
export interface FakePtyCalls {
  resize: Array<{ cols: number; rows: number }>;
  write: string[];
  kill: number;
  onDataCount: number;
  onExitCount: number;
}

/** A fake PTY plus its call log and a hook to fire the captured `onExit` callback. */
export interface FakePty {
  pty: IPty;
  calls: FakePtyCalls;
  /** Invoke the registered onExit callback (simulates the real PTY process exiting). */
  fireExit(e?: { exitCode: number; signal?: number }): void;
}

/**
 * Build a fake `IPty`: records `resize`/`write`/`kill`, counts `onData`/`onExit`
 * registrations, and captures the `onExit` callback so a test can fire it on demand.
 */
export function makeFakePty(): FakePty {
  const calls: FakePtyCalls = { resize: [], write: [], kill: 0, onDataCount: 0, onExitCount: 0 };
  let exitCb: ((e: { exitCode: number; signal?: number }) => void) | undefined;
  const pty = {
    onExit(cb: (e: { exitCode: number; signal?: number }) => void) {
      calls.onExitCount++;
      exitCb = cb;
      return { dispose() {} };
    },
    onData(_cb: (d: string) => void) {
      calls.onDataCount++;
      return { dispose() {} };
    },
    resize(cols: number, rows: number) {
      calls.resize.push({ cols, rows });
    },
    write(data: string) {
      calls.write.push(data);
    },
    kill(_signal?: string) {
      calls.kill++;
    },
  } as unknown as IPty;
  return {
    pty,
    calls,
    fireExit(e = { exitCode: 0, signal: 0 }) {
      exitCb?.(e);
    },
  };
}

/** Deterministic, injectable timer pair: pending callbacks fire only on {@link FakeTimers.flush}. */
export interface FakeTimers {
  setTimeoutFn: typeof setTimeout;
  clearTimeoutFn: typeof clearTimeout;
  /** Fire (and clear) every currently-pending timer callback. */
  flush(): void;
  /** Number of timers still armed (a leaked/unclearing debounce timer keeps this > 0). */
  pendingCount(): number;
}

/**
 * Build a fake-timer pair the SessionEngine uses in place of global setTimeout/clearTimeout.
 * Lets the debounce tests advance "time" deterministically and audit that cleanup clears the
 * pending resize timer (no leak) without sleeping.
 */
export function makeFakeTimers(): FakeTimers {
  let seq = 0;
  const pending = new Map<number, () => void>();
  const setTimeoutFn = ((fn: () => void) => {
    const id = ++seq;
    pending.set(id, fn);
    return id as unknown as NodeJS.Timeout;
  }) as unknown as typeof setTimeout;
  const clearTimeoutFn = ((id: NodeJS.Timeout) => {
    pending.delete(id as unknown as number);
  }) as unknown as typeof clearTimeout;
  return {
    setTimeoutFn,
    clearTimeoutFn,
    flush() {
      const fns = [...pending.values()];
      pending.clear();
      for (const fn of fns) fn();
    },
    pendingCount() {
      return pending.size;
    },
  };
}

/** A minimal {@link import("../dist/engine-lifecycle.js").SessionWatcher} fake with a stop counter. */
export function makeFakeWatcher() {
  let stopCount = 0;
  return {
    watcher: {
      stop() {
        stopCount++;
      },
    },
    stopCount: () => stopCount,
  };
}

/** A recorded spawn invocation (file + argv + options). */
export interface SpawnCall {
  file: string;
  args: readonly string[];
  opts: Record<string, unknown>;
}

/**
 * Fake `pty.spawn` that records each call's `(file, args, opts)` and returns a sentinel handle.
 * Shaped exactly like the story 013 spawn fake so the resume spawn spec can be asserted without
 * launching a process.
 */
export function makeFakeSpawn(handle?: unknown) {
  const calls: SpawnCall[] = [];
  const h = handle ?? { __fake: true };
  const spawn = ((file: string, args: readonly string[], opts: Record<string, unknown>) => {
    calls.push({ file, args, opts });
    return h;
  }) as never;
  return { calls, handle: h, spawn };
}
