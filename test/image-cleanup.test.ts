// Story 058 / Task 2.1 — cleanupMaterializedImages: best-effort unlink of a turn's temp images.
//
// The pure unlink path shared by prompt()'s turn-settle cleanup (catch + finally) and the
// teardownSession backstop (acp-agent.ts). It must (R2.1/R2.2): remove EVERY materialized temp
// image; cover the multi-image case; stay idempotent (a second/teardown pass over an already-gone
// set is a no-op); and NEVER throw — a missing file (ENOENT), undefined, or an empty list all
// return normally. These are exercised here against REAL files under os.tmpdir() (created via the
// production materializeImage, so the prefix/extension match what cleanup unlinks at runtime),
// asserting existsSync flips to false.
// node:test runner: `node --experimental-strip-types --test test/image-cleanup.test.ts`
// (run `npm run build` first — the behavioral imports resolve against ../dist)
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, unlinkSync, writeFileSync, rmSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import { cleanupMaterializedImages, materializeImage, MATERIALIZED_IMAGE_PREFIX } from "../dist/image-input.js";

// A tiny valid base64 payload (a PNG signature) so materializeImage writes a real, non-empty file.
const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");

/** Materialize `n` real temp images (the production path) and return their absolute paths. */
function materializeN(n: number): string[] {
  const paths: string[] = [];
  for (let i = 0; i < n; i++) paths.push(materializeImage(PNG_B64, "image/png"));
  return paths;
}

/** Safety-net rm so a failed assertion never leaks a temp file. */
function hardRemove(paths: string[]): void {
  for (const p of paths) rmSync(p, { force: true });
}

// --- Scenario 1: turn-settle — 2 materialized files, both gone after one cleanup. ----------------
test("turn-settle: cleanup unlinks every materialized temp image (multi-image, R2.2)", () => {
  const made = materializeN(2);
  try {
    assert.equal(made.length, 2, "two temp images materialized for the turn");
    for (const p of made) {
      assert.ok(existsSync(p), `precondition: ${p} exists on disk`);
      assert.ok(p.includes(MATERIALIZED_IMAGE_PREFIX), "materialized file uses the fork-acp-img- prefix");
    }
    cleanupMaterializedImages(made);
    for (const p of made) assert.equal(existsSync(p), false, `turn-settle removed ${p}`);
  } finally {
    hardRemove(made);
  }
});

// --- Scenario 2: teardown — the SAME helper clears a fresh set (single unlink path for both). -----
test("teardown: the same helper removes a fresh set — no orphans survive (R2.1)", () => {
  const made = materializeN(3);
  try {
    for (const p of made) assert.ok(existsSync(p), `precondition: ${p} exists on disk`);
    // teardownSession calls the identical cleanupMaterializedImages — there is ONE unlink path.
    cleanupMaterializedImages(made);
    for (const p of made) assert.equal(existsSync(p), false, `teardown removed ${p}`);
  } finally {
    hardRemove(made);
  }
});

// --- Scenario 3: cancel mid-turn — a partially-removed set; cleanup finishes the rest, no throw. --
test("cancel mid-turn: a partially-unlinked set is finished and the already-gone file does not throw", () => {
  const made = materializeN(3);
  try {
    // Simulate a race/partial teardown: one of the three temp files is already gone before cleanup.
    unlinkSync(made[1]);
    assert.equal(existsSync(made[1]), false, "precondition: the middle file is already unlinked");
    assert.ok(existsSync(made[0]) && existsSync(made[2]), "precondition: the other two still exist");
    // cleanup must remove the survivors AND not throw on the already-gone middle one.
    assert.doesNotThrow(() => cleanupMaterializedImages(made), "cleanup never throws on a raced/gone file");
    for (const p of made) assert.equal(existsSync(p), false, `nothing survives cleanup (${p})`);
    // Idempotent: a second pass (e.g. the teardown backstop after the prompt-finally) is a safe no-op.
    assert.doesNotThrow(() => cleanupMaterializedImages(made), "a second pass over an all-gone set is a no-op");
  } finally {
    hardRemove(made);
  }
});

// --- Scenario 4: failure swallowed — ENOENT path, undefined, and empty array all return normally. -
test("unlink failure is swallowed: ENOENT path, undefined, and [] never throw", () => {
  // A path that was never created (guaranteed ENOENT on unlink).
  const ghost = path.join(os.tmpdir(), MATERIALIZED_IMAGE_PREFIX + randomUUID() + ".png");
  assert.equal(existsSync(ghost), false, "precondition: the ghost path does not exist");
  assert.doesNotThrow(() => cleanupMaterializedImages([ghost]), "a non-existent (ENOENT) path is swallowed");
  // The sink is `turnTempImagePaths?: string[]` on the Session — undefined when the turn made no image.
  assert.doesNotThrow(() => cleanupMaterializedImages(undefined), "undefined (no image this turn) returns normally");
  assert.doesNotThrow(() => cleanupMaterializedImages([]), "an empty list returns normally");
});

// --- Real survivors are deleted even when an ENOENT entry is interleaved (best-effort per file). --
test("best-effort: a real survivor is removed even alongside an ENOENT entry in the same list", () => {
  const real = materializeImage(PNG_B64, "image/png");
  const ghost = path.join(os.tmpdir(), MATERIALIZED_IMAGE_PREFIX + randomUUID() + ".png");
  // A plain (non-materialized) temp file also gets unlinked — cleanup keys off the path list, not the prefix.
  const plain = path.join(os.tmpdir(), MATERIALIZED_IMAGE_PREFIX + randomUUID() + ".img");
  writeFileSync(plain, Buffer.from([0x00]));
  try {
    assert.ok(existsSync(real) && existsSync(plain), "precondition: the two real files exist");
    assert.doesNotThrow(() => cleanupMaterializedImages([real, ghost, plain]));
    assert.equal(existsSync(real), false, "the materialized survivor was removed");
    assert.equal(existsSync(plain), false, "the plain temp survivor was removed");
  } finally {
    hardRemove([real, ghost, plain]);
  }
});
