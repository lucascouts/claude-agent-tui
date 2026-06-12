import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "src");

// The six §3 modules of the upstream anatomy.
const MODULES = ["index", "acp-agent", "tools", "settings", "utils", "lib"];

function moduleExists(name: string): boolean {
  return existsSync(join(srcDir, `${name}.ts`));
}

test("fork modules: all six §3 modules are present under src/ (R4.1)", () => {
  for (const m of MODULES) {
    assert.ok(moduleExists(m), `missing module src/${m}.ts`);
  }
});

test("fork modules: inventory fails loudly for an absent module (R4.4)", () => {
  // Control: a module outside the §3 anatomy must be reported absent — proves
  // the presence check is real, not vacuously true.
  assert.equal(moduleExists("this-module-does-not-exist"), false);
});
