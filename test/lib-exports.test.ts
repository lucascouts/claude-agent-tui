import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as lib from "../dist/lib.js";

// Story 011 / Task 4.2 — pin the `lib.ts` public export surface so the fork cannot
// silently add, remove, rename, or change the type of a public export relative to
// frozen upstream v0.39.0 (§3 module lib.ts = API pública).

const here = dirname(fileURLToPath(import.meta.url));
const forkRoot = join(here, "..");

const EXPECTED_VALUE_EXPORTS = [
  "ClaudeAcpAgent",
  "isLocalCommandMetadata",
  "stripLocalCommandMetadata",
  "runAcp",
  "toAcpNotifications",
  "streamEventToAcpNotifications",
  "nodeToWebReadable",
  "nodeToWebWritable",
  "Pushable",
  "unreachable",
  "toolInfoFromToolUse",
  "toDisplayPath",
  "planEntries",
  "toolUpdateFromToolResult",
  "SettingsManager",
];

const EXPECTED_TYPE_EXPORTS = [
  "ToolUpdateMeta",
  "NewSessionMeta",
  "SDKMessageFilter",
  "SettingsManagerOptions",
  "ClaudePlanEntry",
];

test("lib exports: runtime (value) exports match the frozen surface exactly", () => {
  const actual = Object.keys(lib).sort();
  assert.deepEqual(
    actual,
    [...EXPECTED_VALUE_EXPORTS].sort(),
    "lib.js value exports drifted (added/removed/renamed)",
  );
});

test("lib exports: every public value export is callable (function/class signature preserved)", () => {
  for (const name of EXPECTED_VALUE_EXPORTS) {
    assert.equal(typeof lib[name], "function", `lib.${name} must be exported as a function/class`);
  }
});

test("lib exports: source declares exactly the frozen value+type export set (locks type exports too)", () => {
  const src = readFileSync(join(forkRoot, "src", "lib.ts"), "utf8");
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}\s+from/g)) {
    for (const raw of m[1].split(",")) {
      const name = raw.trim().replace(/^type\s+/, "");
      if (name) names.add(name);
    }
  }
  const expected = [...EXPECTED_VALUE_EXPORTS, ...EXPECTED_TYPE_EXPORTS].sort();
  assert.deepEqual([...names].sort(), expected, "lib.ts export identifier set drifted from frozen v0.39.0");
});
