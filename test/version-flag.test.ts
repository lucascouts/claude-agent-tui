import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  CLAUDE_UNRESOLVED,
  FORK_POINT_SHA,
  FORK_POINT_TAG,
  collectVersionInfo,
  formatVersionInfo,
} from "../dist/version-info.js";

// Story 080 (R3.1-R3.3) — the `--version` short-circuit, ported from upstream
// #813. Two halves are tested here:
//
//   * the pure half (`formatVersionInfo` / `collectVersionInfo`), exercised with
//     faked resolver + detector seams so no `claude` subprocess is ever spawned;
//   * the wiring half (R3.2 — the flag must never reach the ACP wiring), which
//     cannot be import-tested because src/index.ts is a side-effecting entrypoint
//     with a top-level await into runAcp(). Importing it WOULD start the agent,
//     so R3.2 is pinned structurally against the source text instead.
//
// The formatter lives in its own module rather than in index.ts precisely so the
// first half is reachable without a process (task 4.2's "pure exported function").

const here = dirname(fileURLToPath(import.meta.url));
const treeRoot = join(here, "..");

function readProvenance(): Record<string, any> {
  return JSON.parse(readFileSync(join(treeRoot, ".fork-provenance.json"), "utf8"));
}

function readIndexSource(): string {
  return readFileSync(join(treeRoot, "src", "index.ts"), "utf8");
}

const SAMPLE = {
  packageVersion: "1.2.3",
  forkPointTag: "v0.57.0",
  forkPointSha: "2bf865eb42bbe744c476d38a005444eab8f4b624",
  claudeVersion: "2.1.159",
};

test("--version: the formatter prints package version, fork point (tag + sha) and claude version (R3.1)", () => {
  const out = formatVersionInfo(SAMPLE);
  assert.ok(out.includes("1.2.3"), "package version must appear");
  assert.ok(out.includes("v0.57.0"), "fork point tag must appear");
  assert.ok(
    out.includes("2bf865eb42bbe744c476d38a005444eab8f4b624"),
    "fork point sha must appear in full",
  );
  assert.ok(out.includes("2.1.159"), "resolved claude version must appear");
  assert.ok(!out.endsWith("\n"), "the formatter returns a bare string; the caller adds the newline");
});

test("--version: an unresolved claude binary still prints the other fields, marked unresolved (R3.3)", () => {
  const out = formatVersionInfo({ ...SAMPLE, claudeVersion: null });
  assert.ok(out.includes("1.2.3"), "package version must still appear");
  assert.ok(out.includes("v0.57.0"), "fork point tag must still appear");
  assert.ok(out.includes(CLAUDE_UNRESOLVED), "an explicit unresolved marker must appear");
  assert.ok(!out.includes("2.1.159"), "no stale version may be printed when the binary is unresolved");
});

test("--version: collect reports the detected version through the faked resolver seam (R3.1)", () => {
  const info = collectVersionInfo({
    readPackageVersion: () => "9.9.9",
    resolveClaude: () => "/fake/bin/claude",
    detectVersion: (binPath: string) => {
      assert.equal(binPath, "/fake/bin/claude", "the detector must probe the resolved path");
      return "2.1.200";
    },
  });
  assert.equal(info.packageVersion, "9.9.9");
  assert.equal(info.claudeVersion, "2.1.200");
  assert.equal(info.forkPointTag, FORK_POINT_TAG);
  assert.equal(info.forkPointSha, FORK_POINT_SHA);
});

test("--version: a resolver that throws yields claudeVersion null, never an exception (R3.3)", () => {
  const info = collectVersionInfo({
    readPackageVersion: () => "9.9.9",
    resolveClaude: () => {
      throw new Error('Could not resolve an executable "claude" binary.');
    },
    detectVersion: () => {
      throw new Error("the detector must not be reached when resolution failed");
    },
  });
  assert.equal(info.claudeVersion, null, "an unresolvable binary is not an error (R3.3)");
  assert.equal(info.packageVersion, "9.9.9", "the remaining fields must still be collected");
  assert.equal(info.forkPointTag, FORK_POINT_TAG);
});

test("--version: a detector that returns null yields claudeVersion null (R3.3)", () => {
  const info = collectVersionInfo({
    readPackageVersion: () => "9.9.9",
    resolveClaude: () => "/fake/bin/claude",
    detectVersion: () => null,
  });
  assert.equal(info.claudeVersion, null);
});

test("--version: the default package-version reader reports THIS tree's package.json version (R3.1)", () => {
  // Not hardcoded: the fork publishes 0.5.2 and the mirror 0.8.0, and the source
  // file is byte-identical across both (R3.4), so the version must be read, never pinned.
  const expected = JSON.parse(readFileSync(join(treeRoot, "package.json"), "utf8")).version;
  const info = collectVersionInfo({
    resolveClaude: () => {
      throw new Error("no claude in this test");
    },
  });
  assert.equal(info.packageVersion, expected);
});

test("--version: the fork-point constants stay in lockstep with .fork-provenance.json (R3.1)", () => {
  // The constants exist because .fork-provenance.json is NOT in package.json
  // `files` — a published install has no such file to read. This assertion is
  // what stops the constants from drifting the way the release-please manifest did.
  const p = readProvenance();
  assert.equal(FORK_POINT_TAG, p.tag);
  assert.equal(FORK_POINT_SHA, p.sha);
});

test("--version: the short-circuit exits before any ACP wiring is reached (R3.2)", () => {
  const src = readIndexSource();
  const flag = src.indexOf('"--version"');
  const runAcp = src.indexOf("runAcp({");
  assert.ok(flag >= 0, "src/index.ts must handle --version");
  assert.ok(runAcp >= 0, "src/index.ts must still contain the ACP bootstrap");
  assert.ok(flag < runAcp, "the --version branch must be reached before the ACP bootstrap");

  const branch = src.slice(flag, runAcp);
  assert.match(
    branch,
    /process\.exit\(0\)/,
    "the --version branch must exit 0 rather than falling through",
  );
  assert.ok(
    !/runAcp|driveFastModeProbe|resolveSettings/.test(branch.slice(0, branch.indexOf("} else"))),
    "the --version branch must not open a session, spawn a PTY, or start a turn",
  );
});

test("--version: the --cli passthrough is matched before --version, so `--cli --version` reaches claude (R3.2)", () => {
  const src = readIndexSource();
  assert.ok(
    src.indexOf('"--cli"') < src.indexOf('"--version"'),
    "`--cli --version` must ask the claude binary for ITS version, not print ours",
  );
});

test("--version: the version module pulls in no ACP, PTY or engine code (R3.2)", () => {
  const mod = readFileSync(join(treeRoot, "src", "version-info.ts"), "utf8");
  const imports = [...mod.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
  for (const spec of imports) {
    assert.ok(
      !/acp-agent|engine|node-pty|pty/.test(spec),
      `version-info.ts must not import ${spec} — it runs before any session exists`,
    );
  }
});
