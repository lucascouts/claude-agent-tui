// Story 016 / Task 1.1 — tolerant event-type switch over the documented §6 taxonomy.
//
// `classifyEvent` routes a story-015 typed `JsonlEvent` by its `.type`:
//   - `assistant` / `user`        → the content-block dispatch path (input to the §7 translators)
//   - the 13 lifecycle/metadata   → a recognised, non-content classification
//     types (`system`, `result`, `started`, `mode`, `permission-mode`,
//     `file-history-snapshot`, `attachment`, `queue-operation`, `last-prompt`,
//     `ai-title`, `pr-link`, `agent-name`, `summary` [post-`/compact`])
// and NO documented type falls through to the DEFAULT (drift) branch — that branch
// is story 016 / Task 1.2.
//
// node:test runner: `node --experimental-strip-types --test test/event-switch.test.ts`
// (run `npm run build` first — the behavioral import resolves against ../dist).
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyEvent } from "../dist/event-switch.js";

/** Minimal story-015-shaped typed event (the deduped per-`uuid` event the switch consumes). */
function ev(type: string, message: unknown): Record<string, unknown> {
  return { uuid: `uuid-${type}`, type, userType: "external", message };
}

/** The two content-bearing types — routed to the §7 translator content path. */
const CONTENT_TYPES = ["assistant", "user"];

/** The 13 lifecycle/metadata types — recognised, classified, never reaching a content translator. */
const LIFECYCLE_TYPES = [
  "system",
  "result",
  "started",
  "mode",
  "permission-mode",
  "file-history-snapshot",
  "attachment",
  "queue-operation",
  "last-prompt",
  "ai-title",
  "pr-link",
  "agent-name",
  "summary",
];

test("classifyEvent: assistant/user route to the content path", () => {
  for (const type of CONTENT_TYPES) {
    const drift: unknown[] = [];
    const c = classifyEvent(ev(type, { role: type, content: [{ type: "text", text: "hi" }] }), {
      onDrift: (r) => drift.push(r),
    });
    assert.equal(c.class, "content", `${type} must classify as content`);
    assert.equal(c.type, type);
    assert.equal(c.role, type);
    assert.ok(Array.isArray(c.content), `${type} content must be an array`);
    assert.equal(drift.length, 0, `${type} must not emit drift`);
  }
});

test("classifyEvent: lifecycle/metadata types classify as non-content (recognised, not drift)", () => {
  for (const type of LIFECYCLE_TYPES) {
    const drift: unknown[] = [];
    const c = classifyEvent(ev(type, {}), { onDrift: (r) => drift.push(r) });
    assert.equal(c.class, "lifecycle", `${type} must classify as lifecycle`);
    assert.equal(c.type, type);
    assert.equal(drift.length, 0, `${type} must not emit drift`);
  }
});

test("classifyEvent: every documented type is routed — none falls through to DEFAULT (drift)", () => {
  for (const type of [...CONTENT_TYPES, ...LIFECYCLE_TYPES]) {
    const c = classifyEvent(ev(type, {}));
    assert.notEqual(c.class, "drift", `${type} must not fall through to the DEFAULT branch`);
  }
});

test("classifyEvent: the typed event is carried through on the classification", () => {
  const input = ev("assistant", { role: "assistant", content: [{ type: "text", text: "x" }] });
  const c = classifyEvent(input);
  // The classification carries the source event (universal fields preserved for downstream §7).
  assert.equal(c.event.uuid, "uuid-assistant");
  assert.equal(c.event.type, "assistant");
  assert.equal(c.event.userType, "external");
});
