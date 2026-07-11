// === §6 Tolerant event-type switch over the documented §6 taxonomy (story 016, Task Group 1) ===
//
// `classifyEvent` is the type-routing SEAM between story 015's typed-event watcher (`projectEvent`
// in ./jsonl.ts) and the §7 translators (stories 018/019). The event already arrives TYPED from
// the REUSE-live `getSessionMessages` read path — there is NO custom parser here, and we add NO
// custom parsing: this module ONLY dispatches on `event.type`.
//
// Dependency-free on purpose: like ./jsonl.ts, ONLY node: builtins are permitted (and this slice
// needs none). Everything stays READ-ONLY — we consume the event, we never re-project it.
//
// The switch has EXPLICIT, individually-removable `case` arms for every documented type so that
// drift against the DEFAULT branch (Task 1.2) is OBSERVABLE: a documented type that silently stops
// being routed would have to be deleted as a visible `case` label, not vanish behind a membership
// check. Do NOT collapse the arms into a `KNOWN_TYPES.has(type)` test.
//
// SCOPE — the routing skeleton + drift telemetry (1.1 routing, 1.2 telemetry):
//   - `assistant` / `user`  → the content-block dispatch path (input to the §7 translators), with a
//     content normaliser (array verbatim; raw string → `[{type:'text',text}]`; else `[]`, Task 1.3).
//   - the 13 lifecycle/metadata types → a recognised, classified, NON-content path.
//   - `default:` → a LOGGED, NON-FATAL drop (1.2): emit an `unknown-type` drift record through
//     `onDrift`, then return a `drift` classification WITHOUT throwing and WITHOUT a SessionUpdate.
//     Documented types never reach it.
// Field-level drift (1.2): a KNOWN routed type carrying unexpected top-level field(s) emits an
// `unknown-fields` record WITHOUT changing its routing. The `onDrift` seam (default: stderr) makes
// both flavours unit-testable without globals. Telemetry is billing-free and side-effect-free
// beyond logging — the read path never assumes a fixed `.type` set (R1.2, R3, R6).
import type { JsonlEvent } from "./jsonl.js";

// === §6 content-block model (story 016, Task 1.4) ===========================================
//
// The §6 content-block shapes the §7 tool translator (story 019) reads. These are a TYPED VIEW
// over the blocks story 016 carries through `normaliseContent` — they are runtime-invisible
// (no translation to ACP happens here; that is story 019). They exist so stories 018/019 can
// `import` the block types AND so the typed model can never silently start dropping the §6
// extras (`tool_use.caller`, `tool_result.tool_reference`, string-or-array `tool_result.content`).
//
// Field names follow §6 (snake_case, as they arrive in `message.content`). Every block is
// OPTIONAL-heavy because the read path is tolerant: absent `caller` / `tool_reference` is the
// normal optional case, NOT drift. The {@link ContentBlock} union ends in a forward-compat
// catch-all (`{ type: string; [key: string]: unknown }`) so a block type §6 does not yet model
// is still structurally assignable — this is what makes the array passthrough in
// {@link normaliseContent} a sound cast that preserves arbitrary block fields (R6).

/** A §6 `text` block — the only block {@link normaliseContent} ever synthesises (from a raw string). */
export interface TextBlock {
  type: "text";
  text: string;
}

/** A §6 `thinking` block. `signature` is optional (present on signed extended-thinking blocks). */
export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  signature?: string;
}

/**
 * A §6 `tool_use` block. `caller` is the §6 extra story 019 reads to attribute the call; it is
 * PRESERVED here (never dropped) and OPTIONAL — its absence is the normal case, not drift.
 */
export interface ToolUseBlock {
  type: "tool_use";
  id?: string;
  name?: string;
  input?: unknown;
  caller?: unknown;
}

/**
 * A §6 `tool_result` block. Two §6 facts story 019 depends on are modelled here:
 *   - `content` is a raw STRING **or** an array of {@link ContentBlock}s — story 016 preserves
 *     whichever form arrives UNTRANSFORMED (the nested `tool_reference` sub-block lives inside the
 *     array form). Story 019's unmodified `toolUpdateFromToolResult` consumes both forms.
 *   - `is_error` may be `null` (not just `boolean`), per §6/§7.
 * `tool_reference` is the §6 extra that may also appear; it is PRESERVED and OPTIONAL.
 */
export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id?: string;
  content?: string | ContentBlock[];
  is_error?: boolean | null;
  tool_reference?: unknown;
}

/** A §6 `image` block. `source` is preserved opaquely (story 019 owns image handling). */
export interface ImageBlock {
  type: "image";
  source?: unknown;
}

/**
 * The §6 content-block union story 016 carries through {@link normaliseContent} to the §7
 * translators. The trailing catch-all member keeps the union OPEN: any `{ type, ... }` object is
 * structurally assignable, so the array form of `message.content` passes through as
 * {@link ContentBlock}[] without losing unmodelled blocks or arbitrary extra fields (R6).
 */
export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | ToolUseBlock
  | ToolResultBlock
  | ImageBlock
  | { type: string; [key: string]: unknown };

/**
 * A drift-telemetry record handed to {@link ClassifyOptions.onDrift}. Two flavours, discriminated by
 * {@link DriftRecord.kind}:
 *   - `"unknown-type"`  — `event.type` is NOT a documented §6 type; it reached the DEFAULT branch and
 *     was logged-and-ignored (no routing, no SessionUpdate). `fields` carries any unrecognised
 *     top-level keys on the event (possibly empty).
 *   - `"unknown-fields"` — a KNOWN (routed) type carried unexpected top-level field(s); `fields`
 *     names them. Routing is UNCHANGED — this is observational only.
 * Telemetry is billing-free and side-effect-free beyond logging.
 */
export interface DriftRecord {
  /** Which flavour of drift this is — an unknown `.type`, or unknown field(s) on a known type. */
  kind: "unknown-type" | "unknown-fields";
  /** The event type — the unrecognised type (unknown-type) or the routed type (unknown-fields). */
  type: string;
  /** The unrecognised top-level keys on the event (possibly empty for an unknown-type with none). */
  fields: string[];
  /** The event's `version` when present (e.g. the `claude` version that introduced the drift). */
  version?: string;
  /** The source event that drifted, carried through for downstream diagnostics. */
  event?: JsonlEvent;
}

/** Options for {@link classifyEvent}. */
export interface ClassifyOptions {
  /**
   * Injectable drift sink — invoked (a) when an event's `.type` is NOT a documented type and falls
   * through to the DEFAULT branch (an `unknown-type` record), and (b) when a KNOWN, routed type
   * carries unexpected top-level field(s) (an `unknown-fields` record). The injectable-seam pattern
   * mirrors ./jsonl.ts so the telemetry is unit-testable without globals.
   *
   * When omitted, drift is logged via {@link defaultDriftSink} to STDERR (never stdout — stdout is
   * the ACP protocol channel). A fully-documented known event emits NOTHING.
   */
  onDrift?: (record: DriftRecord) => void;
}

/** The two content-bearing roles — the only `type`s routed to the §7 translator content path. */
type ContentType = "assistant" | "user";

/**
 * Classification of a content-bearing event (`assistant` / `user`). Routed to the content-block
 * dispatch path consumed by the §7 translators.
 */
export interface ContentClassification {
  class: "content";
  /** The content-bearing type, echoed for the consumer. */
  type: ContentType;
  /** The message role — equal to {@link ContentClassification.type} for these two types. */
  role: ContentType;
  /**
   * The NORMALISED content-block array (Task 1.3): `message.content` verbatim when it is an array,
   * a raw string wrapped as `[{ type: 'text', text }]`, else `[]`. Always a real array so the §7
   * translators can `.map`/index without tripping on the string form. Typed as {@link ContentBlock}[]
   * (Task 1.4) so stories 018/019 read modelled blocks; the open catch-all union member keeps the §6
   * extras (`tool_use.caller`, `tool_result.tool_reference`) and any unmodelled block surviving.
   */
  content: ContentBlock[];
  /** The source typed event, carried through (universal fields preserved for downstream §7). */
  event: JsonlEvent;
}

/**
 * Classification of a recognised lifecycle/metadata event — one of the 13 documented non-content
 * types. Recognised and classified, but it NEVER reaches a content translator.
 */
export interface LifecycleClassification {
  class: "lifecycle";
  /** The lifecycle/metadata type, echoed for the consumer. */
  type: string;
  /** The source typed event, carried through. */
  event: JsonlEvent;
}

/**
 * Classification of an UNRECOGNISED event — one whose `.type` is not documented and fell through to
 * the DEFAULT branch. The DEFAULT arm emits an `unknown-type` drift record through `onDrift` before
 * returning this marker; the marker itself carries NO content, so it produces no ACP SessionUpdate.
 */
export interface DriftClassification {
  class: "drift";
  /** The unrecognised type, echoed for the consumer. */
  type: string;
  /** The source typed event, carried through. */
  event: JsonlEvent;
}

/** Discriminated union over the `class` field — the result of {@link classifyEvent}. */
export type EventClassification =
  ContentClassification | LifecycleClassification | DriftClassification;

/**
 * Narrowing helper: a non-null plain object (mirrors ./jsonl.ts `isObject`). Arrays and `null` are
 * excluded so we can read string-keyed props safely.
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Default drift sink: log the record to STDERR via `console.error`. NEVER `console.log`/stdout —
 * stdout is the ACP protocol channel (see ./index.ts, which redirects all `console.*` to stderr for
 * exactly this reason). Used when the caller supplies no `onDrift`. Logging-only: billing-free and
 * side-effect-free beyond the log line.
 */
function defaultDriftSink(record: DriftRecord): void {
  console.error(
    `[jsonl-drift] ${JSON.stringify({
      kind: record.kind,
      type: record.type,
      fields: record.fields,
      version: record.version,
    })}`,
  );
}

/**
 * The documented top-level keys of {@link JsonlEvent} (the universal fields + per-type extras).
 * Used ONLY for KEY-drift detection — naming top-level fields that are NOT in this set. This is a
 * SEPARATE concern from the type-routing `switch`, whose arms stay explicit and individually
 * removable; this Set is NOT a `KNOWN_TYPES.has(type)` membership shortcut and never gates routing.
 */
const KNOWN_EVENT_FIELDS: ReadonlySet<string> = new Set([
  "uuid",
  "type",
  "timestamp",
  "sessionId",
  "message",
  "parentToolUseId",
  "userType",
  "parentUuid",
  "cwd",
  "gitBranch",
  "version",
  "isSidechain",
  "entrypoint",
  "requestId",
  "promptId",
  "toolUseResult",
  "permissionMode",
]);

/**
 * The event's top-level keys that are NOT in {@link KNOWN_EVENT_FIELDS} — the "unrecognised" fields.
 * A non-object event yields `[]` (nothing to inspect).
 *
 * @param event the typed event (or any value — non-objects yield no fields).
 * @returns the unrecognised top-level key names (empty when all keys are documented).
 */
function unrecognisedFields(event: JsonlEvent): string[] {
  if (!isObject(event)) return [];
  return Object.keys(event).filter((key) => !KNOWN_EVENT_FIELDS.has(key));
}

/**
 * Field-level drift for a KNOWN, routed type: if the event carries unrecognised top-level field(s),
 * emit ONE `unknown-fields` drift record naming them. Routing is UNCHANGED — this is observational
 * only. A fully-documented event emits nothing. Called from every documented arm (via {@link
 * classifyContent} / {@link classifyLifecycle}) so the check covers all routed types in one place.
 *
 * @param event the routed typed event.
 * @param onDrift the resolved drift sink.
 */
function reportFieldDrift(event: JsonlEvent, onDrift: (record: DriftRecord) => void): void {
  const fields = unrecognisedFields(event);
  if (fields.length === 0) return;
  onDrift({ kind: "unknown-fields", type: event.type, fields, version: event.version, event });
}

/**
 * Content normaliser for the content path: produce a UNIFORM block array so every downstream branch
 * (and the §7 translators of story 018) can `.map`/index over content without ever tripping on the
 * raw-string form documented in §6. Three shapes:
 *   - ARRAY  → returned VERBATIM (same reference; arbitrary block fields preserved untouched, which
 *     Task 1.4's block typing relies on). We never mutate it.
 *   - STRING → wrapped as a single `[{ type: 'text', text: <string> }]` block (a FRESH array, so the
 *     input event is left untouched).
 *   - absent / anything else → `[]`.
 * This is the SINGLE source for both the `assistant` and `user` content arms, applied BEFORE any
 * block-type inspection so a string `message.content` can never throw an indexing/`.map` (Task 1.3).
 *
 * @param message the API message object (or any value — non-matching shapes yield `[]`).
 * @returns the normalised {@link ContentBlock} array (string → one text block; non-array/non-string → `[]`).
 */
function normaliseContent(message: unknown): ContentBlock[] {
  if (!isObject(message)) return [];
  const content = message.content;
  // The array passes through UNCHANGED (no mutation). `Array.isArray` only narrows to `unknown[]`,
  // so we assert to `ContentBlock[]`: the open catch-all union member (`{type,...}`) makes any block
  // structurally assignable, so this cast is sound and PRESERVES arbitrary extras (caller, tool_reference).
  if (Array.isArray(content)) return content as ContentBlock[];
  // A raw string becomes a single TextBlock (a FRESH array; the input event is left untouched).
  if (typeof content === "string") return [{ type: "text", text: content }];
  return []; // absent / non-string / non-array
}

/**
 * Build the content-path classification for a content-bearing event. Factored out so both the
 * `assistant` and `user` arms route through one place and the extraction stays naive-but-isolated.
 * Surfaces field-level drift (via {@link reportFieldDrift}) WITHOUT altering routing.
 */
function classifyContent(
  type: ContentType,
  event: JsonlEvent,
  onDrift: (record: DriftRecord) => void,
): ContentClassification {
  // Field-drift is observational and must not change the result — report before building it.
  reportFieldDrift(event, onDrift);
  return {
    class: "content",
    type,
    // For `assistant` / `user`, the message role equals the event type.
    role: type,
    content: normaliseContent(event.message),
    event,
  };
}

/**
 * Build the lifecycle-path classification for a recognised non-content event. Surfaces field-level
 * drift (via {@link reportFieldDrift}) WITHOUT altering routing.
 */
function classifyLifecycle(
  event: JsonlEvent,
  onDrift: (record: DriftRecord) => void,
): LifecycleClassification {
  reportFieldDrift(event, onDrift);
  return { class: "lifecycle", type: event.type, event };
}

/**
 * Route a story-015 typed {@link JsonlEvent} by its `.type` to the appropriate classification.
 *
 * The two content-bearing types are dispatched to the content-block path consumed by the §7
 * translators; the 13 documented lifecycle/metadata types (`system`, `result`, `started`, `mode`,
 * `permission-mode`, `file-history-snapshot`, `attachment`, `queue-operation`, `last-prompt`,
 * `ai-title`, `pr-link`, `agent-name`, and the post-`/compact` `summary`) are classified as
 * recognised, NON-content events that neither crash nor reach a content translator. Every documented
 * type has its OWN explicit `case` arm (no membership check) so drift against the DEFAULT branch is
 * observable.
 *
 * No custom parsing is performed — the event already arrives typed from story 015's `projectEvent`;
 * this function ONLY dispatches on `event.type`.
 *
 * Drift telemetry (R1.2, R3, R6): an UNRECOGNISED `.type` is a LOGGED, NON-FATAL drop — it emits an
 * `unknown-type` record through `onDrift`, then returns a `drift` classification WITHOUT throwing and
 * WITHOUT producing any ACP SessionUpdate. A KNOWN, routed type carrying unexpected top-level field(s)
 * additionally emits an `unknown-fields` record (its routing is UNCHANGED). When `opts.onDrift` is
 * omitted, drift is logged to STDERR via {@link defaultDriftSink}. Telemetry is billing-free and
 * side-effect-free beyond logging, so the read path never assumes a fixed `.type` set.
 *
 * @param event the typed event projected by story 015's `projectEvent`.
 * @param opts injectable `onDrift` seam; defaults to the stderr {@link defaultDriftSink}.
 * @returns the {@link EventClassification} for the event.
 */
export function classifyEvent(event: JsonlEvent, opts: ClassifyOptions = {}): EventClassification {
  // Resolve the drift sink once: caller-supplied seam, else the stderr default (never stdout).
  const onDrift = opts.onDrift ?? defaultDriftSink;

  switch (event.type) {
    // --- Content-bearing types → the §7 translator content-block path -------------------------
    case "assistant":
      return classifyContent("assistant", event, onDrift);
    case "user":
      return classifyContent("user", event, onDrift);

    // --- Lifecycle / metadata types → recognised, classified, NON-content ---------------------
    // Each is an EXPLICIT, individually-removable `case` label (NOT a membership check) so that
    // drift against the DEFAULT branch stays observable. The post-`/compact` `summary` is included.
    case "system":
      return classifyLifecycle(event, onDrift);
    case "result":
      return classifyLifecycle(event, onDrift);
    case "started":
      return classifyLifecycle(event, onDrift);
    case "mode":
      return classifyLifecycle(event, onDrift);
    case "permission-mode":
      return classifyLifecycle(event, onDrift);
    case "file-history-snapshot":
      return classifyLifecycle(event, onDrift);
    case "attachment":
      return classifyLifecycle(event, onDrift);
    case "queue-operation":
      return classifyLifecycle(event, onDrift);
    case "last-prompt":
      return classifyLifecycle(event, onDrift);
    case "ai-title":
      return classifyLifecycle(event, onDrift);
    case "pr-link":
      return classifyLifecycle(event, onDrift);
    case "agent-name":
      return classifyLifecycle(event, onDrift);
    case "summary":
      return classifyLifecycle(event, onDrift);

    // --- DEFAULT (drift) ----------------------------------------------------------------------
    // An UNRECOGNISED type: a type added in a future `claude` 2.1.x. Emit ONE `unknown-type` drift
    // record (naming the new type + any unrecognised top-level fields + version), then return a
    // `drift` classification WITHOUT throwing. A drift contributes nothing downstream — it is neither
    // content nor lifecycle, so the §7 translators never see it and NO ACP SessionUpdate is produced.
    default:
      onDrift({
        kind: "unknown-type",
        type: event.type,
        fields: unrecognisedFields(event),
        version: event.version,
        event,
      });
      return { class: "drift", type: event.type, event };
  }
}
