// Story 058 / Task 3.1 (R3.1, R3.2) — unit tests for the version-aware image-vision smoke.
//
// `image-vision-smoke.ts` mirrors story 049's drift discipline: a PURE verdict (`imageVisionSmoke` →
// `{confirmed, detail}`, like src/drift-checks.ts) + a best-effort fail-loud REPORTER
// (`reportImageVisionSmoke`, like src/claude-path.ts's reportVersionDrift `[claude-path] …`, prefixed
// here `[image-vision]`). It records whether the running `claude` is a version we have CONFIRMED
// vision-encodes `@image` via Read (proven on 2.1.195; broken on 2.1.170, story 030/058). When it
// cannot confirm, it warns LOUDLY — exactly once — but NEVER blocks: `promptCapabilities.image` stays
// `image: true` UNCONDITIONALLY (R3.1), and these tests assert the verdict is observability-only with
// no capability toggle in its shape.
//
// node:test runner: `node --experimental-strip-types --test test/image-vision-smoke.test.ts`
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  imageVisionSmoke,
  reportImageVisionSmoke,
  versionGte,
  VISION_CONFIRMED_CLAUDE_VERSION,
  type VisionSmokeResult,
} from "../src/image-vision-smoke.ts";

/** Collect every line a `reportImageVisionSmoke` call emits, so we can count + inspect warnings. */
function captureSink(): { log: (...args: unknown[]) => void; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    log: (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    },
  };
}

// === the anchor itself ==========================================================================

test("VISION_CONFIRMED_CLAUDE_VERSION is the proven 2.1.195 anchor (story 058)", () => {
  // 2.1.195 is where @image → Read-vision was PROVEN (2.1.170 did NOT vision-encode — story 030).
  assert.equal(VISION_CONFIRMED_CLAUDE_VERSION, "2.1.195");
});

// === imageVisionSmoke — CONFIRMED branch (>= anchor) ============================================

test("imageVisionSmoke: CONFIRMED at the exact boundary 2.1.195 and above (R3.2)", () => {
  for (const v of ["2.1.195", "2.1.200", "2.2.0", "3.0.0"]) {
    const r = imageVisionSmoke(v);
    assert.equal(r.confirmed, true, `expected ${v} >= ${VISION_CONFIRMED_CLAUDE_VERSION} to be confirmed`);
    // positive one-liner that names the detected version + the anchor
    assert.match(r.detail, new RegExp(v.replace(/\./g, "\\.")), `detail should name ${v}`);
    assert.match(r.detail, /2\.1\.195/, "detail should reference the confirmed anchor");
  }
});

// === imageVisionSmoke — UNCONFIRMED branch (too old / unparseable / absent) =====================

test("imageVisionSmoke: UNCONFIRMED just below the anchor (2.1.194, 2.1.170) — names version + anchor (R3.2)", () => {
  for (const v of ["2.1.194", "2.1.170"]) {
    const r = imageVisionSmoke(v);
    assert.equal(r.confirmed, false, `expected ${v} < ${VISION_CONFIRMED_CLAUDE_VERSION} to be unconfirmed`);
    assert.match(r.detail, /UNCONFIRMED/i, "unconfirmed detail must read as a warning");
    assert.match(r.detail, new RegExp(v.replace(/\./g, "\\.")), `warning must name the detected version ${v}`);
    assert.match(r.detail, /2\.1\.195/, "warning must name the confirmed anchor");
  }
});

test("imageVisionSmoke: UNCONFIRMED on null / undefined / garbage — names 'undetected' + anchor (R3.2)", () => {
  for (const v of [null, undefined, "garbage"]) {
    const r = imageVisionSmoke(v);
    assert.equal(r.confirmed, false, `expected ${String(v)} to be unconfirmed`);
    assert.match(r.detail, /UNCONFIRMED/i, "unconfirmed detail must read as a warning");
    assert.match(r.detail, /undetected/, "warning must say 'undetected' when no version parses");
    assert.match(r.detail, /2\.1\.195/, "warning must name the confirmed anchor");
  }
});

test("imageVisionSmoke: UNCONFIRMED detail states the image is NOT blocked (R3.1 — observability only)", () => {
  // The warning must make clear it is a heads-up, not a gate: the image still goes through.
  const r = imageVisionSmoke("2.1.170");
  assert.equal(r.confirmed, false);
  assert.match(r.detail, /NOT blocked/i, "warning must state image input is not blocked");
});

// === reportImageVisionSmoke — warns EXACTLY ONCE when unconfirmed, SILENT when confirmed ========

test("reportImageVisionSmoke: emits NO warning on a confirmed version (R3.2)", () => {
  for (const v of ["2.1.195", "2.1.200", "2.2.0", "3.0.0"]) {
    const sink = captureSink();
    const r = reportImageVisionSmoke(v, sink.log);
    assert.equal(r.confirmed, true);
    assert.equal(sink.lines.length, 0, `confirmed ${v} must not warn (no news is good news)`);
  }
});

test("reportImageVisionSmoke: emits EXACTLY ONE [image-vision] warning when unconfirmed (R3.2)", () => {
  for (const v of ["2.1.194", "2.1.170", null, undefined, "garbage"]) {
    const sink = captureSink();
    const r = reportImageVisionSmoke(v, sink.log);
    assert.equal(r.confirmed, false);
    assert.equal(sink.lines.length, 1, `unconfirmed ${String(v)} must warn exactly once`);
    assert.match(sink.lines[0], /^\[image-vision\] /, "warning must carry the [image-vision] prefix");
    // the warning names the version (or 'undetected') AND the anchor
    const expectedName = typeof v === "string" && /^\d+\.\d+\.\d+/.test(v) ? v : "undetected";
    assert.match(sink.lines[0], new RegExp(expectedName.replace(/\./g, "\\.")), "warning names the version/undetected");
    assert.match(sink.lines[0], /2\.1\.195/, "warning names the confirmed anchor");
  }
});

test("reportImageVisionSmoke: returns the same verdict it logged (confirmed flag round-trips)", () => {
  const sinkOk = captureSink();
  assert.equal(reportImageVisionSmoke("2.1.195", sinkOk.log).confirmed, true);
  const sinkBad = captureSink();
  assert.equal(reportImageVisionSmoke("2.1.100", sinkBad.log).confirmed, false);
});

// === versionGte — the semver ordering helper ====================================================

test("versionGte: componentwise >= across major / minor / patch (incl. boundary equality)", () => {
  assert.equal(versionGte("2.1.195", "2.1.195"), true, "equal → >= holds");
  assert.equal(versionGte("2.1.196", "2.1.195"), true, "patch greater");
  assert.equal(versionGte("2.2.0", "2.1.195"), true, "minor greater outranks patch");
  assert.equal(versionGte("3.0.0", "2.1.195"), true, "major greater outranks the rest");
  assert.equal(versionGte("2.1.194", "2.1.195"), false, "patch lower");
  assert.equal(versionGte("2.0.999", "2.1.195"), false, "minor lower outranks patch");
  assert.equal(versionGte("1.9.9", "2.1.195"), false, "major lower outranks the rest");
});

test("versionGte: a missing component reads as 0 (so '2.1' == '2.1.0')", () => {
  assert.equal(versionGte("2.1", "2.1.0"), true, "'2.1' fills patch with 0 → equal");
  assert.equal(versionGte("2.1", "2.1.195"), false, "'2.1' == 2.1.0 which is below 2.1.195");
});

// === R3.1 honesty — the verdict is OBSERVABILITY-ONLY, never a capability toggle =================

test("R3.1: VisionSmokeResult carries ONLY {confirmed, detail} — no field that could disable a capability", () => {
  // Structural guard: the verdict's surface is exactly two keys. There is deliberately NO `image` /
  // `enabled` / `capability` field here — promptCapabilities.image (acp-agent.ts:1413) stays
  // `image: true` UNCONDITIONALLY and is INDEPENDENT of this verdict. The smoke only ever LOGS.
  const r: VisionSmokeResult = imageVisionSmoke("2.1.170");
  assert.deepEqual(Object.keys(r).sort(), ["confirmed", "detail"]);
  assert.equal(typeof r.confirmed, "boolean");
  assert.equal(typeof r.detail, "string");
});

test("R3.1: an UNCONFIRMED verdict does not imply the image is disabled — only that it is unverified", () => {
  // Honesty check: `confirmed:false` is "we couldn't verify this claude vision-encodes @image", NOT
  // "image is off". The capability is unconditional; the verdict influences logging only. We assert the
  // reporter's sole effect is the log line (it returns the verdict and mutates nothing else).
  const sink = captureSink();
  const before = sink.lines.length;
  const r = reportImageVisionSmoke("2.1.170", sink.log);
  assert.equal(r.confirmed, false);
  assert.equal(sink.lines.length - before, 1, "the ONLY side-effect is the single warning line");
});
