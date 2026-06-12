// Story 032 / Task 1.1 — dynamic free-port allocator with 127.0.0.1 bind verification (R1).
//
// The Degrau-2 permission gate (HYBRID prototype, story 007 / GATE_FINDINGS.md) attaches a
// `PreToolUse` type:http hook to the real `claude` TUI over **TCP loopback**. That hook needs an
// endpoint port for the fork's local hook server. Per the global project rule on port-in-use, the
// port MUST be:
//   - allocated DYNAMICALLY (OS-assigned / ephemeral) — NEVER a hard-coded constant; and
//   - PROVEN free by actually binding `127.0.0.1:<port>` before it is adopted (a stale "looks free"
//     check is not enough — a service could be on the box).
//
// STRATEGY (TOCTOU-aware): we OS-assign a candidate by listening on `127.0.0.1:0` (the kernel hands
// back a currently-free ephemeral port), read it, close that probe, then RE-BIND `127.0.0.1:<port>`
// to confirm it is still free at adoption time. A small race window remains between the two binds —
// that is inherent to any "pick then use" scheme — but if the re-bind races a `EADDRINUSE`/`EACCES`
// we simply re-select another candidate rather than returning an unverified port. After a bounded
// retry budget we REJECT loudly with the attempt count and the last bind error (R1.4) so the spawn
// path fails fast instead of hanging on an endless retry loop.
//
// OFFLINE: this module binds/closes loopback sockets only; it spawns NO `claude` and bills nothing.

import { createServer } from "node:net";

/** Bounded retry budget — re-select this many times before failing loudly (R1.4). */
export const DEFAULT_PORT_ATTEMPTS = 10;

/** Loopback host the gate hook server binds; the hook URL is `http://127.0.0.1:<port>` (story 007). */
export const LOOPBACK_HOST = "127.0.0.1";

/**
 * Minimal `net`-server surface {@link findFreePort} needs. Factored out as an injectable seam (the
 * same discipline as `AgentDeps.schedule` / `GuardHooks`) so a test can drive bind exhaustion
 * deterministically WITHOUT monkey-patching the frozen `node:net` module namespace (which is
 * read-only under ESM). Defaults to `node:net`'s real `createServer`.
 */
export interface PortServer {
  listen(port: number, host: string): void;
  close(cb?: () => void): void;
  address(): { port: number } | string | null;
  once(event: "listening" | "error", cb: (...args: unknown[]) => void): void;
  removeListener(event: "listening" | "error", cb: (...args: unknown[]) => void): void;
}

/** Factory for a fresh, unbound {@link PortServer}. Injected for tests; defaults to `node:net`. */
export type ServerFactory = () => PortServer;

const defaultServerFactory: ServerFactory = () => createServer() as unknown as PortServer;

/**
 * Listen on `host:port` and resolve once bound, or reject on the bind error. The caller decides
 * whether to keep the server open (to read its assigned port) or close it. Every error path removes
 * the `listening` handler implicitly via the one-shot promise, and the server is the caller's to
 * close — `listenOnce` itself never leaks a half-open socket because a failed `listen` does not bind.
 */
function listenOnce(makeServer: ServerFactory, host: string, port: number): Promise<PortServer> {
  return new Promise((resolve, reject) => {
    const server = makeServer();
    const onError = (...args: unknown[]) => {
      server.removeListener("listening", onListening);
      // A server that failed to listen holds no bound socket; close defensively and surface the error.
      try {
        server.close();
      } catch {
        // ignore — nothing was bound
      }
      reject((args[0] as NodeJS.ErrnoException) ?? new Error("listen failed"));
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve(server);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

/** Close a probe server, swallowing any close error (a probe must never leak a socket — R1 note). */
function closeQuietly(server: PortServer): Promise<void> {
  return new Promise((resolve) => {
    try {
      server.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

/**
 * Allocate an OS-assigned ephemeral port and PROVE it is actually free by binding `127.0.0.1:<port>`
 * before returning it (global port-in-use rule; R1.1, R1.2). On a bind conflict
 * (`EADDRINUSE`/`EACCES`) the candidate is discarded and another is selected (R1.3). After
 * {@link DEFAULT_PORT_ATTEMPTS} exhausted attempts the promise REJECTS with a diagnostic naming the
 * attempt count and the last bind error rather than returning an unverified port (R1.4).
 *
 * @param attempts bounded retry budget (default {@link DEFAULT_PORT_ATTEMPTS}); each attempt
 *   OS-assigns a fresh candidate and re-verifies it binds free.
 * @param makeServer injectable `net`-server factory (defaults to `node:net`'s `createServer`);
 *   tests drive bind exhaustion through it without monkey-patching the frozen module.
 * @returns a port number, in the ephemeral range, that bound free on `127.0.0.1` at adoption time.
 * @throws {Error} if no candidate binds free within `attempts` tries — message names the count and
 *   the last bind error.
 */
export async function findFreePort(
  attempts: number = DEFAULT_PORT_ATTEMPTS,
  makeServer: ServerFactory = defaultServerFactory,
): Promise<number> {
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error(`findFreePort: attempts must be a positive integer, got ${String(attempts)}`);
  }

  let lastError: unknown = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    // 1) OS-assign a currently-free ephemeral port by listening on :0.
    let probe: PortServer;
    try {
      probe = await listenOnce(makeServer, LOOPBACK_HOST, 0);
    } catch (err) {
      lastError = err;
      continue;
    }
    const address = probe.address();
    if (address === null || typeof address === "string") {
      // Unexpected (a TCP server should yield an AddressInfo); discard and retry.
      lastError = new Error("findFreePort: OS-assigned listener returned no numeric port");
      await closeQuietly(probe);
      continue;
    }
    const candidate = address.port;
    await closeQuietly(probe);

    // 2) Re-bind the SAME port to PROVE it is still free at adoption time (verification bind).
    let verify: PortServer;
    try {
      verify = await listenOnce(makeServer, LOOPBACK_HOST, candidate);
    } catch (err) {
      // EADDRINUSE / EACCES — the port got taken (or is privileged); re-select another candidate.
      lastError = err;
      continue;
    }
    await closeQuietly(verify);
    return candidate;
  }

  const detail =
    lastError instanceof Error
      ? `${lastError.message}`
      : lastError === null
        ? "no candidate could be OS-assigned"
        : String(lastError);
  throw new Error(
    `findFreePort: could not obtain a verified-free 127.0.0.1 port after ${attempts} attempt(s); ` +
      `last bind error: ${detail}. Refusing to return an unverified port (global port-in-use rule).`,
  );
}
