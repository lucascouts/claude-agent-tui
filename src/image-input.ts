// Story 058 / Task 1.1 — materialize an ACP `image` block to a temp file for the @path vision path.
//
// The fork drives the real `claude` TUI over a PTY; it has no API surface to push raw image bytes.
// The proven claude-2.1.195 path to get an image vision-encoded is to write the bytes to a file and
// reference it with `@<path>` in the prompt text, then ask the model to Read it — the TUI's Read tool
// then vision-encodes the file. This module is the standalone, OFFLINE-testable materialize seam:
//
//   extFor(mimeType)            → ".png" | ".jpg" | ".gif" | ".webp" | ".img"   (PURE — mime → ext)
//   materializeImage(data, mt)  → <abs temp path>   (DURABLE — base64 → temp file, returns the path)
//
// `promptToClaude` (acp-agent.ts) is SYNCHRONOUS and runs before the `await` at its call site, so the
// write here is synchronous (`writeFileSync`) by design — do NOT make it async. The temp path is
// uuid-named and fork-controlled (no user input in the filename), which is what lets a later cleanup
// task (Task 2) treat it as shell-safe. The decoded bytes are not logged.

import { writeFileSync, unlinkSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";

/** Filename prefix for every materialized image — shared so a later cleanup task can match it. */
export const MATERIALIZED_IMAGE_PREFIX = "fork-acp-img-";

/**
 * Map an ACP `image` block `mimeType` to a file extension the TUI's Read tool recognizes.
 *
 * Tolerant of a `;`-parameterized mimeType (e.g. `image/png; charset=binary`): only the media type
 * before the first `;` is matched. Anything unrecognized — including `undefined`/`null` — falls back
 * to `.img` so a path is still produced (the Read tool sniffs the bytes regardless of extension).
 * Never throws.
 */
export function extFor(mimeType: string | undefined | null): string {
  // Strip any `;`-delimited parameters and normalize, so `image/JPEG; q=…` still matches.
  const media = (mimeType ?? "").split(";", 1)[0].trim().toLowerCase();
  switch (media) {
    case "image/png":
      return ".png";
    case "image/jpeg":
      return ".jpg";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    default:
      return ".img";
  }
}

/**
 * Decode a base64 `image` payload to a uniquely-named temp file and return its absolute path.
 *
 * The file lives under {@link os.tmpdir} with a uuid name (no user-controlled characters) and an
 * extension derived from `mimeType` via {@link extFor}. The write is SYNCHRONOUS on purpose — the
 * caller (`promptToClaude`) is sync. May throw if the decode or write fails; the caller isolates that
 * in its per-block try/catch (R1.3), so a bad image is skipped rather than aborting the whole prompt.
 */
export function materializeImage(data: string, mimeType: string | undefined | null): string {
  const bytes = Buffer.from(data, "base64");
  const tempPath = path.join(
    os.tmpdir(),
    MATERIALIZED_IMAGE_PREFIX + randomUUID() + extFor(mimeType),
  );
  writeFileSync(tempPath, bytes);
  return tempPath;
}

/**
 * Story 058 / Task 2.1 (R2.1/R2.2) — best-effort unlink of every materialized temp image.
 *
 * The single unlink path shared by the turn-settle cleanup (prompt()'s catch + finally) and the
 * session-teardown backstop, kept here so it stays OFFLINE-testable. NEVER throws: each unlink is
 * isolated so a missing file (already removed, or a torn-down/raced turn) is a no-op rather than an
 * error — which makes the teardown backstop idempotent with the prompt-finally cleanup. `undefined`
 * (no image materialized this turn) returns immediately.
 */
export function cleanupMaterializedImages(paths: readonly string[] | undefined): void {
  if (!paths) return;
  for (const p of paths) {
    try {
      unlinkSync(p);
    } catch {
      /* best-effort: the file is already gone, or a raced teardown removed it first */
    }
  }
}
