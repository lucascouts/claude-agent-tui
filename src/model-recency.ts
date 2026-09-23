import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";

/**
 * Picker recency filter: show only the newest model of each family.
 *
 * The SDK catalogue carries every model the account may reach, superseded ones
 * included — measured 2026-09-23 it returned eleven rows, of which six were
 * older Opus/Fable/Sonnet generations (`claude-opus-4-6` … `claude-fable-5`).
 * This module keeps the newest of each family and drops the rest, so the picker
 * offers one current choice per family instead of a version history.
 *
 * **Why a RULE and not a list.** That catalogue is served by the backend, not
 * baked into the pinned CLI, and it was measured changing twice in one day under
 * a fixed build — five rows, then eleven, with different titles and taglines. A
 * hardcoded set of "current" ids would therefore be stale within hours, and
 * silently: nothing fails when a picker row is wrong, the user simply gets the
 * wrong model. Ranking by parsed version means the next launch promotes itself
 * and retires its predecessor with no edit here.
 *
 * **Total and fail-open.** Anything this cannot place — an alias with no
 * `resolvedModel`, a third-party id, a naming scheme that changes — is KEPT.
 * Hiding a model the user has is worse than showing one row too many, and a
 * parser is exactly the kind of thing a vendor breaks without warning. For the
 * same reason the caller falls back to the unfiltered list if this would empty
 * it.
 *
 * **This module is duplicated in `claude-agent-plus`, deliberately.** The two
 * adapters are independent packages with no shared library between them, and the
 * rule is small enough that a copy costs less than a dependency. If you change
 * the ranking here, change it there — the sibling is
 * `claude-agent-plus/fork/src/model-recency.ts`.
 *
 * @module model-recency
 */

/**
 * A model's family and version, parsed from a canonical wire id such as
 * `claude-opus-5-5` or `claude-haiku-4-5-20251001`.
 */
interface ModelGeneration {
  family: string;
  /** Version components, most significant first: `5-5` becomes `[5, 5]`. */
  version: number[];
}

/**
 * Canonical wire ids look like `claude-<family>-<major>[-<minor>][-<snapshot>]`,
 * optionally carrying a `[1m]` context hint. The snapshot suffix on dated ids
 * (`claude-haiku-4-5-20251001`) is a build stamp, not a version component, so
 * it is excluded by capping the parsed components at two — otherwise a dated
 * row would outrank its own undated sibling.
 */
const WIRE_ID = /claude-([a-z]+)-(\d+(?:-\d+)*)/i;

/** The `[1m]`/`-1m` long-context markers, which name a context lane and never a version. */
const CONTEXT_HINT = /\[\dm\]|-\dm\b/gi;

/**
 * Parse a row's family and version from its canonical id.
 *
 * Reads `resolvedModel` first and falls back to `value`: alias rows (`opus`,
 * `sonnet`) carry no version in `value`, which is the whole reason the SDK
 * ships `resolvedModel`. Returns `null` for anything unparseable, which the
 * caller treats as "keep".
 *
 * @param info - A single SDK model row.
 */
export function modelGeneration(info: ModelInfo): ModelGeneration | null {
  const id = (info.resolvedModel ?? info.value ?? "").replace(CONTEXT_HINT, "");
  const match = WIRE_ID.exec(id);
  if (!match) return null;
  const version = match[2].split("-").slice(0, 2).map(Number);
  if (version.some((part) => !Number.isFinite(part))) return null;
  return { family: match[1].toLowerCase(), version };
}

/** Compare two version component lists, most significant first. Missing components sort as 0. */
function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Return a NEW array holding only the newest row of each model family.
 *
 * Rows preserve their original ORDER and IDENTITY — the same object references
 * come back, not copies — so a caller may compare by reference. Rows this
 * cannot place are kept (see the module doc); rows tying for newest within a
 * family are all kept, because a tie means two spellings of one model
 * (typically an alias and its wire id) and dropping either would be arbitrary.
 *
 * @param infos - The model catalogue to filter.
 * @returns A new array containing only current rows.
 */
export function filterSupersededModels(infos: ModelInfo[]): ModelInfo[] {
  const newest = new Map<string, number[]>();
  for (const info of infos) {
    const generation = modelGeneration(info);
    if (!generation) continue;
    const best = newest.get(generation.family);
    if (!best || compareVersions(generation.version, best) > 0) {
      newest.set(generation.family, generation.version);
    }
  }
  return infos.filter((info) => {
    const generation = modelGeneration(info);
    if (!generation) return true;
    const best = newest.get(generation.family);
    return !best || compareVersions(generation.version, best) === 0;
  });
}
