// Story 032 / Task 1.1 — dynamic free-port allocator with 127.0.0.1 bind verification (R1).
//
// findFreePort() OS-assigns an ephemeral port and PROVES it is free by binding 127.0.0.1:<port>
// before returning it (global port-in-use rule). A pre-bound candidate triggers re-selection; an
// exhausted retry budget fails loudly naming the attempt count. Fully OFFLINE — binds loopback
// sockets only, spawns no claude.
//
// node:test: build first, then
//   node --experimental-strip-types --test test/gate-port.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:net";
import * as Port from "../dist/gate/port.js";

const LOOPBACK = "127.0.0.1";

/** Bind a real loopback server on `port` (0 = OS-assigned) and resolve its handle + actual port. */
function listen(port: number): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, LOOPBACK, () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        reject(new Error("no numeric port"));
        return;
      }
      resolve({ server, port: addr.port });
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** Assert a port is bindable RIGHT NOW on 127.0.0.1 (i.e. actually free), then release it. */
async function assertBindableNow(port: number): Promise<void> {
  const { server } = await listen(port);
  await close(server);
}

// ── R1.1 / R1.2 — OS-assigned + verified-free by an actual bind ────────────────

test("1.1 findFreePort returns an ephemeral-range port that is bindable immediately after", async () => {
  const port = await Port.findFreePort();
  assert.equal(typeof port, "number", "must return a number");
  assert.ok(Number.isInteger(port), "must be an integer port");
  // Ephemeral / non-privileged range. The OS picks from the high range; assert it is at least
  // above the privileged 0-1023 band (a hard-coded low constant would fail this).
  assert.ok(port > 1023 && port <= 65535, `port ${port} must be a non-privileged ephemeral port`);
  // The contract: the returned port is ACTUALLY free — bindable on 127.0.0.1 at adoption time.
  await assertBindableNow(port);
});

test("1.1 findFreePort is dynamic — repeated calls are not a hard-coded constant", async () => {
  // Hold the first port open so the allocator cannot hand the same one back; the second call must
  // therefore yield a DIFFERENT, still-free port (proves dynamic allocation, not a fixed constant).
  const first = await Port.findFreePort();
  const held = await listen(first);
  try {
    const second = await Port.findFreePort();
    assert.notEqual(second, first, "with the first port held, a different free port must be chosen");
    await assertBindableNow(second);
  } finally {
    await close(held.server);
  }
});

// ── R1.3 — a pre-bound candidate triggers re-selection (does not reuse the occupied port) ──

test("1.3 a candidate already in use is skipped and a different free port returned", async () => {
  // Occupy an OS-assigned port, then prove findFreePort never returns THAT one.
  const occupied = await listen(0);
  try {
    for (let i = 0; i < 5; i++) {
      const port = await Port.findFreePort();
      assert.notEqual(port, occupied.port, "must never return the occupied port (re-selection, R1.3)");
      await assertBindableNow(port);
    }
  } finally {
    await close(occupied.server);
  }
});

// ── R1.4 — exhausted retry budget fails LOUDLY naming the attempt count ─────────

test("1.4 an impossible attempts budget fails loudly naming the attempt count", async () => {
  // attempts = 0 is not a valid budget — the allocator must reject loudly rather than spin or
  // return an unverified port. The diagnostic names the (invalid) attempt budget.
  await assert.rejects(
    () => Port.findFreePort(0),
    (err: Error) => {
      assert.match(err.message, /attempts/, "diagnostic must mention the attempts budget");
      return true;
    },
  );
});

test("1.4 with all bind attempts forced to fail, it rejects naming the count and last error", async () => {
  // Inject a server factory whose every `listen` raises EADDRINUSE — simulating a box where no
  // candidate can be adopted. findFreePort must exhaust its bounded budget and reject loudly (R1.4),
  // NOT hang and NOT return an unverified port. Uses the public injection seam (no monkey-patching).
  const alwaysBusy: Port.ServerFactory = () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    return {
      listen() {
        // Defer the error so the one-shot 'error' handler fires asynchronously, like a real bind.
        setImmediate(() => {
          const e = new Error("EADDRINUSE simulated") as NodeJS.ErrnoException;
          e.code = "EADDRINUSE";
          listeners.get("error")?.(e);
        });
      },
      close(cb?: () => void) {
        cb?.();
      },
      address() {
        return null;
      },
      once(event: "listening" | "error", cb: (...args: unknown[]) => void) {
        listeners.set(event, cb);
      },
      removeListener(event: "listening" | "error") {
        listeners.delete(event);
      },
    };
  };

  await assert.rejects(
    () => Port.findFreePort(3, alwaysBusy),
    (err: Error) => {
      assert.match(err.message, /3 attempt/, "diagnostic must name the attempt count");
      assert.match(err.message, /EADDRINUSE|bind error/i, "diagnostic must surface the last bind error");
      return true;
    },
  );
});
