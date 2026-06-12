// Story 027 / Task 1.2 — Zed `agent_servers` registration helpers (§15, R1.2, R6.2).
//
// The fork is registered in Zed by merging ONE `agent_servers` entry into the user's
// settings.json. Two invariants:
//   - NON-DESTRUCTIVE: every pre-existing key is preserved (read-modify-write a parsed
//     copy, never overwrite wholesale).
//   - env LEFT EMPTY (R6.2): the §15 entry's `env` is `{}` because billing sanitization
//     is internal to the PTY spawn (story 013) — a single authoritative scrub point.
//
// NOTE on JSONC: Zed settings.json is JSONC (// comments + trailing commas). parseJsonc
// tolerates both for programmatic reads/merges. For the USER'S real file (which also
// carries header comments worth keeping), registration is applied as a surgical edit
// that preserves comments; this module is the tested programmatic merge over parsed
// JSON. No new dependency is added (the frozen base forbids one) — parseJsonc is a
// minimal, string-aware scrubber, not a full JSONC editor.

import { isAbsolute } from "node:path";

export interface ZedAgentEntry {
  type: "custom";
  command: "node";
  args: [string];
  env: Record<string, string>;
}

/**
 * Build the single §15 `agent_servers` entry: a custom node spawn of the built
 * dist/index.js with an EMPTY env (R6.2). Rejects a non-absolute path or a target that
 * is not the built dist/index.js — a wrong `args[0]` makes the agent un-launchable.
 */
export function buildZedAgentEntry(absDistPath: string): ZedAgentEntry {
  if (!isAbsolute(absDistPath)) {
    throw new Error(`Zed agent_servers args[0] must be an ABSOLUTE path, got: ${absDistPath}`);
  }
  if (!absDistPath.endsWith("dist/index.js")) {
    throw new Error(
      `Zed agent_servers args[0] must point at the built dist/index.js, got: ${absDistPath}`,
    );
  }
  return { type: "custom", command: "node", args: [absDistPath], env: {} };
}

/**
 * Tolerant JSONC parse: strip // line comments and block comments that are NOT inside a
 * string, drop trailing commas, then JSON.parse. String-aware so a `//` or `,` inside a
 * value is never mangled.
 */
export function parseJsonc(text: string): any {
  let out = "";
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inLineComment) {
      if (c === "\n") {
        inLineComment = false;
        out += c;
      }
      continue;
    }
    if (inBlockComment) {
      if (c === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (c === "\\") {
        out += next ?? "";
        i++;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (c === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    out += c;
  }
  out = out.replace(/,(\s*[}\]])/g, "$1"); // drop trailing commas
  return JSON.parse(out);
}

/**
 * Merge a single `agent_servers[name] = entry` into JSONC settings text, preserving
 * every other key. Returns canonical JSON text. Idempotent: re-merging the same entry
 * is a fixed point. (The user's real comment-bearing file is edited surgically instead;
 * this is the programmatic merge used in tests and tooling.)
 */
export function mergeAgentServer(settingsText: string, name: string, entry: ZedAgentEntry): string {
  const settings = parseJsonc(settingsText);
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
    throw new Error("Zed settings root must be a JSON object");
  }
  const merged = structuredClone(settings);
  if (typeof merged.agent_servers !== "object" || merged.agent_servers === null) {
    merged.agent_servers = {};
  }
  merged.agent_servers[name] = entry;
  return JSON.stringify(merged, null, 2);
}
