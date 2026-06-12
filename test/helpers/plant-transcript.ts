// Story 038 / Task 1.2 — Isolated-HOME transcript planter for replay-only `session/load`.
//
// The spawned production fork's `session/load` is REPLAY-ONLY (story 027): it locates the prior
// thread on disk and replays it, never spawning a live `claude --resume`. The discovery path is
// `loadSession → replaySessionHistory → readOrderedMessages(sessionId, cwd, {getMessages})`. In the
// child the `getMessages` seam is undefined, so it falls through to the REAL SDK reader,
// `getSessionMessages(sessionId, { dir: cwd })` from `@anthropic-ai/claude-agent-sdk`. Because the
// fork is a SEPARATE child process, the harness CANNOT inject `getMessages` — it must satisfy the
// genuine SDK disk reader. This planter writes a fixture transcript at the EXACT path that reader
// resolves, under a THROWAWAY config dir, so discovery is deterministic and the user's real
// `~/.claude` is never read or written (R1.4, R5.1).
//
// The recipe below was verified by reading the compiled SDK (`sdk.mjs`) this session:
//   • configDir = process.env.CLAUDE_CONFIG_DIR ?? join(os.homedir(), ".claude")   (memoized per process)
//   • projectKey F0(cwd) = cwd.replace(/[^a-zA-Z0-9]/g, "-")                         (ALL non-alnum → "-")
//   • file path = configDir/projects/<F0(cwd)>/<sessionId>.jsonl
//   • getSessionMessages returns [] SILENTLY unless sessionId matches the UUID regex
//       /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
//   • the thread is reconstructed by following `parentUuid` from the leaf, so the lines MUST form a
//     LINEAR CHAIN (first parentUuid null, each next = the previous line's uuid) or only the LAST
//     line is returned.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

/** The UUID shape `getSessionMessages` requires of `sessionId` (else it silently returns `[]`). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The SDK project-key slug: ALL non-alphanumeric characters become `-`. Mirrors the SDK's `F0`
 * exactly (NOT the Degrau-0 `/[/_. ]/g` rule). A non-existent `cwd` is fine — the SDK's realpath
 * step falls back to the literal resolved path, so a FIXED FICTIONAL cwd is the deterministic choice.
 */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/** One ergonomic input turn: the caller supplies only the semantic bits; the chain is auto-filled. */
export interface PlantMessage {
  /** SDK message kind. Only {user,assistant,attachment,system,progress} survive the SDK filter. */
  type: "user" | "assistant" | "attachment" | "system" | "progress";
  /**
   * The message body, mirroring the `fixtures/multi-turn.jsonl` shape: `{ role, content:[...] }`.
   * `usage` is the sibling-of-role API token block that `getSessionMessages` round-trips intact
   * (verified: assistant `message` keys come back `[role, usage, content]`); the pump/replay reads
   * it via `turn.message.message.usage.{input_tokens,output_tokens}` for the optional usage_update
   * (story 038). Index-permissive so a planted transcript may carry the full message shape verbatim.
   */
  message: {
    role?: "user" | "assistant";
    content?: unknown;
    usage?: { input_tokens?: number; output_tokens?: number };
    [key: string]: unknown;
  };
  /** Optional explicit line uuid; auto-filled as `m0`,`m1`,… when omitted (need NOT be a UUID). */
  uuid?: string;
  /** Optional `tool_use` id for a `tool_result` line; defaults to `null`. */
  parent_tool_use_id?: string | null;
}

export interface PlantTranscriptInput {
  /** The session id — MUST be a valid UUID (e.g. `crypto.randomUUID()`); defaults to a fresh UUID. */
  sessionId?: string;
  /** The session cwd, fed to `F0` for the project dir. Keep FIXED + FICTIONAL (e.g. `/zedsim/proj`). */
  cwd: string;
  /** The turns to plant, in chronological order; the linear `parentUuid` chain is built across them. */
  messages: PlantMessage[];
  /** Override the temp-dir parent (tests only); defaults to `os.tmpdir()`. */
  tmpRoot?: string;
}

export interface PlantedTranscript {
  /** The resolved session id (UUID) — pass this as `loadSession({ sessionId })`. */
  sessionId: string;
  /** The session cwd echoed back — pass this as `loadSession({ cwd })`. */
  cwd: string;
  /** `<tmpDir>/.claude` — feed to the child as `CLAUDE_CONFIG_DIR` (the SDK's config-dir override). */
  configDir: string;
  /** `<tmpDir>` — feed to the child as `HOME` (defense-in-depth: the fork's own glob uses homedir()). */
  home: string;
  /** The absolute path the transcript was written to (for diagnostics / isolation assertions). */
  transcriptPath: string;
  /** Remove the whole throwaway temp dir. Idempotent + best-effort (safe to call from dispose). */
  cleanup: () => void;
}

/**
 * Plant a fixture `.jsonl` transcript so the spawned fork's replay-only `session/load` discovers it
 * under an ISOLATED config dir, never touching the user's real `~/.claude`.
 *
 * Creates a throwaway temp dir, writes the transcript at
 * `<tmpDir>/.claude/projects/<F0(cwd)>/<sessionId>.jsonl`, and returns the `configDir`/`home` the
 * caller threads into the spawned child's env plus a `cleanup` for `dispose`.
 *
 * Ergonomics: the caller supplies only `{ type, message }` per turn; this fills the LINEAR
 * `parentUuid` chain (first `null`, each next = the previous line's `uuid`), the per-line `uuid`
 * (`m0`,`m1`,…) and `session_id`, and an ISO `timestamp`, so the SDK reader returns every turn in
 * chronological order rather than only the leaf.
 */
export function plantTranscript(input: PlantTranscriptInput): PlantedTranscript {
  const sessionId = input.sessionId ?? crypto.randomUUID();
  if (!UUID_RE.test(sessionId)) {
    // Fail LOUD at plant time — `getSessionMessages` would otherwise return `[]` silently and the
    // wire test would mis-attribute the empty replay to the harness rather than a bad sessionId.
    throw new Error(
      `plantTranscript: sessionId must be a UUID (getSessionMessages returns [] silently otherwise); got "${sessionId}"`,
    );
  }

  const tmpRoot = input.tmpRoot ?? os.tmpdir();
  const tmpDir = fs.mkdtempSync(path.join(tmpRoot, "zedsim-"));
  const configDir = path.join(tmpDir, ".claude");
  const projectDir = path.join(configDir, "projects", projectSlug(input.cwd));
  const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);

  fs.mkdirSync(projectDir, { recursive: true });

  // Build the LINEAR parentUuid chain: line 0's parent is null, each subsequent line's parent is the
  // previous line's uuid. Without this the SDK returns only the leaf (COUNT 1). `session_id` is the
  // UUID on every line; timestamps step monotonically so chronological order is unambiguous.
  let prevUuid: string | null = null;
  const lines = input.messages.map((m, i) => {
    const uuid = m.uuid ?? `m${i}`;
    const record = {
      type: m.type,
      uuid,
      parentUuid: prevUuid,
      session_id: sessionId,
      timestamp: isoStep(i),
      message: m.message,
      parent_tool_use_id: m.parent_tool_use_id ?? null,
    };
    prevUuid = uuid;
    return JSON.stringify(record);
  });
  // Trailing newline so the reader sees N complete records (mirrors the production transcript shape).
  fs.writeFileSync(transcriptPath, lines.join("\n") + "\n", "utf8");

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    // Best-effort: a dispose during teardown must never throw on an already-removed dir.
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* already gone — fine */
    }
  };

  return { sessionId, cwd: input.cwd, configDir, home: tmpDir, transcriptPath, cleanup };
}

/** A monotonically increasing ISO timestamp so chronological order is deterministic per line index. */
function isoStep(i: number): string {
  // Stays valid well past index 9 (e.g. 70 → 2026-06-03T10:01:10.000Z) via Date arithmetic.
  const base = Date.UTC(2026, 5, 3, 10, 0, 0);
  return new Date(base + i * 1000).toISOString();
}
