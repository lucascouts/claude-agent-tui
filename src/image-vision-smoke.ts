// === Story 058 / Task 3.1 (R3.1, R3.2) — version-aware image-vision smoke (pure verdict + fail-loud) ==
//
// The whole "image input via @path" feature rests on a VERSION-FRAGILE claude behavior: a prompt
// containing `@<path>` makes the native TUI invoke the Read tool, and Read vision-encodes the image so
// the model can see it. This was PROVEN on claude 2.1.195 (story 058 research — two-arm proof: a blue
// image vs a green image under the same filename, each correctly described). It did NOT work on claude
// 2.1.170 (story 030): there, `@path` did not vision-encode, so an image prompt silently dropped its
// picture.
//
// Because the behavior is version-fragile, this module makes a too-old / unknown `claude` LOUD instead
// of silently dropping the image. It mirrors story 049's drift discipline:
//   - the VERDICT is PURE (no I/O — like src/drift-checks.ts's `{surface, ok, detail}` checks), and
//   - the REPORTER is best-effort + fail-loud one-liner (like src/claude-path.ts's reportVersionDrift,
//     `[claude-path] …`); here the prefix is `[image-vision]`.
//
// CRITICAL — OBSERVABILITY ONLY, NEVER A GATE (R3.1): this smoke NEVER blocks the prompt and NEVER
// touches `promptCapabilities.image`, which stays literally `image: true` (acp-agent.ts:1413),
// UNCONDITIONALLY. The verdict's only output is `{confirmed, detail}` — there is deliberately NO field
// or return shape here that could disable a capability. A too-old `claude` produces a WARNING, not a
// degraded capability: the image still rides the @path delivery; we just warn that this `claude` is not
// a version we have confirmed vision-encodes it.
//
// LIMITATION (documented honestly): this is an OFFLINE `>= anchor` version-gate. It catches too-old and
// undetected/unparseable versions, but it CANNOT catch a *future regression* — a hypothetical 2.1.300
// that re-breaks @path-vision would still parse as `>= 2.1.195` and report confirmed. Catching a future
// regression needs the LIVE smoke (opt-in — story 058 R4 probe: actually send @image and check the
// model saw it), which this offline gate intentionally does NOT implement.
//
// node:test runner: `node --experimental-strip-types --test test/image-vision-smoke.test.ts`

/**
 * The claude version where `@<path>` → Read-vision was PROVEN to work (story 058 research).
 *
 * WHY this exact anchor: on claude 2.1.170 a `@path` image prompt did NOT vision-encode the picture —
 * the TUI did not turn it into a Read the model could see (story 030). On claude 2.1.195 it DOES: the
 * two-arm proof (a blue vs a green image under the same uuid filename, each described correctly) showed
 * `@path` → Read vision-encodes. So 2.1.195 is the earliest version we are willing to call "confirmed";
 * anything below is treated as unconfirmed and warned about.
 */
export const VISION_CONFIRMED_CLAUDE_VERSION = "2.1.195";

/** The verdict {@link imageVisionSmoke} returns. Observability only — there is NO capability toggle here. */
export interface VisionSmokeResult {
  /** True iff the running `claude` version is one we have CONFIRMED vision-encodes `@image` via Read. */
  confirmed: boolean;
  /**
   * Human-readable one-liner. On `confirmed=true` it is a positive note. On `confirmed=false` it is the
   * fail-loud WARNING text and NAMES the detected version (or "undetected") plus the confirmed anchor
   * (mirrors drift-checks.ts's "name the offending value" habit).
   */
  detail: string;
}

/**
 * Compare two `x.y.z` semver strings: `true` iff `a >= b` componentwise (major, then minor, then patch).
 *
 * Splits on `.`, parses the three leading numeric components; a missing/non-numeric component counts as
 * `0` (so `"2.1"` reads as `2.1.0`). Private to this module — exported only so the unit test can pin the
 * ordering directly. Pure.
 */
export function versionGte(a: string, b: string): boolean {
  const partsA = a.split(".");
  const partsB = b.split(".");
  for (let i = 0; i < 3; i++) {
    const na = toComponent(partsA[i]);
    const nb = toComponent(partsB[i]);
    if (na !== nb) {
      return na > nb;
    }
  }
  return true; // all three components equal → a >= b holds
}

/** Parse one semver component to a non-negative integer; missing / non-numeric → 0. */
function toComponent(part: string | undefined): number {
  if (part === undefined) {
    return 0;
  }
  const n = Number.parseInt(part, 10);
  return Number.isNaN(n) ? 0 : n;
}

/** Matches a leading `x.y.z` triple — same shape parseClaudeVersion extracts (claude-path.ts:58). */
const SEMVER_RE = /^(\d+\.\d+\.\d+)/;

/**
 * PURE verdict: is the running `claude` `version` one we have CONFIRMED vision-encodes `@image` via Read?
 *
 * `confirmed: true` IFF `version` is a parseable leading `x.y.z` that is `>= {@link
 * VISION_CONFIRMED_CLAUDE_VERSION}`. In that case `detail` is a positive one-liner.
 *
 * Otherwise (`null` / `undefined` / unparseable, OR a parseable version BELOW the anchor) `confirmed:
 * false` and `detail` is the fail-loud WARNING text — it NAMES the detected version (or "undetected")
 * and the confirmed anchor, and states that the image is NOT blocked (R3.1). No I/O; depends only on
 * its argument.
 */
export function imageVisionSmoke(version: string | null | undefined): VisionSmokeResult {
  const parsed = typeof version === "string" ? SEMVER_RE.exec(version) : null;
  if (parsed && versionGte(parsed[1], VISION_CONFIRMED_CLAUDE_VERSION)) {
    return {
      confirmed: true,
      detail: `claude ${parsed[1]} >= ${VISION_CONFIRMED_CLAUDE_VERSION} — @image is confirmed to vision-encode via Read`,
    };
  }
  const named = parsed ? parsed[1] : "undetected";
  return {
    confirmed: false,
    detail:
      `@image vision-encoding is UNCONFIRMED on this claude (detected ${named}; confirmed at ` +
      `${VISION_CONFIRMED_CLAUDE_VERSION}+). Sending images anyway — image input is NOT blocked — but ` +
      `if the picture is ignored, upgrade claude to ${VISION_CONFIRMED_CLAUDE_VERSION} or newer`,
  };
}

/**
 * Best-effort fail-loud reporter: compute {@link imageVisionSmoke} and, WHEN unconfirmed, log the
 * verdict's `detail` EXACTLY ONCE via `log` with an `[image-vision]` prefix (mirrors claude-path.ts's
 * reportVersionDrift `[claude-path] …` style). Returns the verdict.
 *
 * Logs NOTHING on a confirmed version (a confirmed `claude` is the expected case — no news is good news,
 * matching reportVersionDrift which is silent when there is no drift). NEVER blocks and NEVER throws out
 * of the caller's intent — it is pure aside from the single conditional `log` call (R3.1, R3.2).
 */
export function reportImageVisionSmoke(
  version: string | null | undefined,
  log: (...args: unknown[]) => void = console.error,
): VisionSmokeResult {
  const result = imageVisionSmoke(version);
  if (!result.confirmed) {
    log(`[image-vision] ${result.detail}`);
  }
  return result;
}
