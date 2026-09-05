# ACP-wire regression harness (story 038)

A **protocol-faithful** ACP test client that spawns the built fork
(`node dist/index.js`) as a child process and drives it over **real stdio**
(JSON-RPC + the `initialize` handshake) using `ClientSideConnection` +
`ndJsonStream` from `@agentclientprotocol/sdk` 1.2.0 — the version the fork ships (bumped
from the original 0.22.1 over stories 045/047/056/074), matching the protocol surface
the user's Zed 1.7.0+nightly negotiated (FORK.md verdict #1).

It closes the three client-compat probes that story 025 left to **manual
observation in the real Zed** (`toolCallId` reuse, `usage_update` resilience,
large-burst throughput) as **deterministic, offline, CI-runnable** regression
tests — no GUI, no Zed, no `claude` binary, no network.

## How to run

```bash
# build first (the harness spawns the built dist/index.js)
npm --prefix fork run build

# run every wire probe (shell expands the glob)
node --experimental-strip-types --test test/acp-wire-*.test.ts

# or a single probe
node --experimental-strip-types --test test/acp-wire-smoke.test.ts

# or the whole fork suite (Node v26 needs the recursive glob form)
node --experimental-strip-types --test "test/**/*.test.ts"
```

`--experimental-strip-types` runs the `.ts` tests directly (matches
`package.json`'s `test:fork`). The wire probes are **un-gated** (no
`RUN_INTEGRATION_TESTS`) — they are offline and deterministic. No
`--test-force-exit` is needed: `loadSession` is replay-only (story 027), so no
`claude`/PTY child is spawned and every spawned fork is reaped by `dispose()`.

## What the harness covers (automated)

| Test file                         | Req (025 probe)      | Asserts over real stdio                                                                                                                                                             |
| --------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `acp-wire-smoke.test.ts`          | R1.1, R1.2           | `initialize` handshake negotiates `protocolVersion === 1` (integer) + `agentCapabilities.loadSession`; `dispose()` idempotent, no leaked child                                      |
| `acp-wire-load-replay.test.ts`    | R1.3, R1.4           | `session/load` replays a planted transcript in chronological order; planted under an **isolated** `CLAUDE_CONFIG_DIR`/`HOME` — the user's real `~/.claude` is never read or written |
| `acp-wire-toolcall-reuse.test.ts` | R2.1 (025/2.1)       | one `tool_call` + a correlated `tool_call_update` on the **same raw** `toolCallId` (`toolu_…`); no duplicate, no drop                                                               |
| `acp-wire-usage-flag.test.ts`     | R3.1                 | `USAGE_UPDATE=1` ⇒ ≥1 `usage_update` over the wire; unset ⇒ **zero** (default-OFF, byte-for-byte stream)                                                                            |
| `acp-wire-usage-reject.test.ts`   | R3.2 (025/3.3)       | a client that **rejects** every `usage_update` does not break the replay — text/tool stream delivered complete + in order, no crash (see the honest caveat below)                   |
| `acp-wire-large-burst.test.ts`    | R4.1, R4.2 (025/4.1) | an n≈2000 synthetic transcript ⇒ **one ordered** `session/update` per linearized event; no drop/merge/reorder; read-only; no crash; fork-side throughput logged                     |

Helpers (under `test/helpers/`): `startZedSim` (spawn + connect + capture +
isolated-config-dir + idempotent dispose), `plantTranscript` (writes a transcript
the real `getSessionMessages` discovers), `makeLargeTranscript` (deterministic
burst generator).

### Planter recipe (for maintainers)

The replay-only `loadSession` reads via the **real SDK** `getSessionMessages`
(the fork is a separate process — the `getMessages` seam cannot be injected). A
planted transcript is only discovered when ALL of these hold:

- **`sessionId` is a valid UUID** (`/^[0-9a-f]{8}-…-[0-9a-f]{12}$/i`) — otherwise
  `getSessionMessages` returns `[]` **silently**.
- file at `<CLAUDE_CONFIG_DIR>/projects/<F0(cwd)>/<sessionId>.jsonl`, where
  `F0(cwd) = cwd.replace(/[^a-zA-Z0-9]/g, "-")` (the SDK's project slug).
- lines form a **linear `parentUuid` chain** (first `null`, each next = the
  previous line's `uuid`) — the SDK rebuilds the thread from the leaf, so without
  the chain only the last line is returned.
- isolation via `CLAUDE_CONFIG_DIR` (+ `HOME`) pointed at a throwaway temp dir.

## Honest caveat — `usage_update` rejection over the wire

`acp-wire-usage-reject` proves **resilience**, not suppression. Over the real
transport the fork does **NOT** suppress `usage_update` after a client rejection:
`session/update` is a fire-and-forget notification (`AgentSideConnection` →
`sendNotification`, no ACK) and the SDK catches the client's throw inside
`tryCallNotificationHandler`, so the fork never observes the rejection and emits
**every** `usage_update`. The R8 catch+suppress latch is the **in-process**
protection, proven by `usage-reject.test.ts`. See FORK.md verdict #3.

## What the harness does NOT cover

- **GPUI visual render** of the Zed Agent Panel — no reliable automation for
  native GPUI. Use the manual `dev: open acp logs` fallback below.
- **The REAL Zed's accept / reject / throttle behaviour** for `usage_update` and
  large bursts — that is the sibling static study, **story 039** (reads the Zed
  Rust source). This harness asserts the FORK's behaviour under a configurable
  client, not the Zed client's behaviour.

## Manual fallback — `dev: open acp logs` (the one thing not automated)

To eyeball the GPUI render / inspect the real ACP traffic in Zed:

1. Register the built fork in Zed `settings.json` under `agent_servers`, e.g.
   `"agent_servers": { "claude-fork": { "command": "node", "args": ["<repo>/dist/index.js"] } }`.
2. Open the **Agent Panel** and start (or reopen) a thread with the fork.
3. From the **Command Palette**, run **`dev: open acp logs`**.
4. Drive one `session/load` (reopen a prior thread) and watch the captured ACP
   traffic; export/copy the log for the record.
5. Confirm the panel renders text / thinking / tool calls / diffs as expected —
   the visual check this harness intentionally does not automate.

## References

- FORK.md → **Zed client-compat verdicts** (#1–#4; verdict #3 updated by this story)
- Story 027 → in-product live acceptance precedent (the live render)
- Story 039 → static study of the real Zed's `usage_update`/throttle behaviour
