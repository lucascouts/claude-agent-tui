// Story 012 / Task 1.1 (R1.1) — the SDK-embedded binary resolver is CUT.
//
// Static guarantee that the fork source no longer references the SDK-embedded
// `claude` binary path: a grep-style scan over src/** asserts (a) the identifier
// `claudeCliPath` appears nowhere, and (b) no `@anthropic-ai/claude-agent-sdk`
// *binary-path* resolution survives (the platform-specific `claude-agent-sdk-*`
// subpackage candidates). The SDK package itself is still a legitimate
// dependency (types, `getSessionMessages` reused live) — only the binary-path
// resolution is forbidden. A runtime check confirms the resolved engine path is
// never under the SDK package directory.
//
// Uses the built-in node:test runner (run: `node --experimental-strip-types
// --test test/claude-path-no-sdk.test.ts`). `npm test` is vitest and only scans
// src/**, so it does not pick this file up — fork tests live under test/.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, sep } from "node:path";
// Story 059: dist over src — claude-path.ts gained a src→src `./image-vision-smoke.js` import (story 058)
// that does not resolve from src/ under --experimental-strip-types; import the built module (dist over src).
// The src/** scan below still reads source files directly via fs, so the no-SDK guarantee is unchanged.
import { resolveClaudePath } from "../dist/claude-path.js";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "src");

/** All `.ts` files under src/** (recursive), as [relativePath, contents]. */
function srcFiles(): Array<[string, string]> {
  const entries = readdirSync(srcDir, { recursive: true, withFileTypes: true });
  const out: Array<[string, string]> = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".ts")) continue;
    // Node's recursive Dirent.parentPath gives the containing dir.
    const full = join(e.parentPath ?? srcDir, e.name);
    out.push([full.slice(srcDir.length + 1), readFileSync(full, "utf8")]);
  }
  return out;
}

test("no-sdk (R1.1): src/** contains no `claudeCliPath` reference", () => {
  const offenders = srcFiles()
    .filter(([, body]) => /\bclaudeCliPath\b/.test(body))
    .map(([rel]) => rel);
  assert.deepEqual(
    offenders,
    [],
    `claudeCliPath must be cut from the whole fork tree; still referenced in: ${offenders.join(", ")}`,
  );
});

test("no-sdk (R1.1): src/** resolves no SDK-embedded `claude` binary path", () => {
  // The platform-specific binary subpackages the old resolver reached into.
  // The plain `@anthropic-ai/claude-agent-sdk` import (types, live readers) is
  // allowed — only these binary-path candidates are forbidden.
  const forbidden = [/claude-agent-sdk-linux-/, /claude-agent-sdk-\$\{/];
  const offenders: string[] = [];
  for (const [rel, body] of srcFiles()) {
    if (forbidden.some((re) => re.test(body))) offenders.push(rel);
  }
  assert.deepEqual(
    offenders,
    [],
    `SDK binary-path resolution must be cut; still present in: ${offenders.join(", ")}`,
  );
});

test("no-sdk (R1.1): resolved engine path is not under the SDK package dir", () => {
  let resolved: string | undefined;
  try {
    resolved = resolveClaudePath();
  } catch {
    // No subscription `claude` installed in this environment — there is no
    // resolved path that could point at the SDK package, so nothing to assert.
    return;
  }
  const sdkMarker = `node_modules${sep}@anthropic-ai${sep}claude-agent-sdk`;
  assert.ok(
    !resolved.includes(sdkMarker),
    `resolved engine path must not be under the SDK package dir, got "${resolved}"`,
  );
});
