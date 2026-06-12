// Story 016 / Task 1.2 — DEFAULT branch: ignore unknown types, log drift telemetry.
//
// `classifyEvent`'s `switch(.type)` gets a `default:` arm that makes an unknown `.type` a
// LOGGED, NON-FATAL drop: it emits a structured drift-telemetry record through the injectable
// `onDrift` sink, then returns a `drift` classification WITHOUT throwing and WITHOUT producing
// any ACP SessionUpdate (an unknown type contributes nothing to the thread). Field-level drift
// on a KNOWN type — an unexpected top-level field — is also surfaced (its new field names
// logged) WITHOUT changing routing. The read path never assumes a fixed `.type` set (R6, R3).
//
// node:test runner: `node --experimental-strip-types --test test/event-drift.test.ts`
// (run `npm run build` first — the behavioral import resolves against ../dist).
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyEvent } from "../dist/event-switch.js";

test("classifyEvent: an unknown .type is logged-and-ignored (drift), never throws", () => {
  const drift: any[] = [];
  let c: any;
  assert.doesNotThrow(() => {
    c = classifyEvent(
      {
        uuid: "drift-1",
        type: "new-future-type",
        userType: "external",
        message: {},
        version: "2.1.999",
      } as any,
      { onDrift: (r) => drift.push(r) },
    );
  });
  // (a) the switch does NOT throw, (b) exactly ONE drift record carrying the unknown type name,
  // (c) it is an `unknown-type` drift kind.
  assert.equal(drift.length, 1, "exactly one drift record for an unknown type");
  assert.equal(drift[0].kind, "unknown-type");
  assert.equal(drift[0].type, "new-future-type");
});

test("classifyEvent: an unknown .type produces NO SessionUpdate (drift class, no content)", () => {
  const c: any = classifyEvent(
    { uuid: "drift-2", type: "totally-unknown", userType: "external", message: {} } as any,
    { onDrift: () => {} },
  );
  // A drift classification contributes nothing downstream — it is neither content nor lifecycle,
  // so the §7 translators never see it and no ACP SessionUpdate is produced.
  assert.equal(c.class, "drift");
  assert.notEqual(c.class, "content");
  assert.equal(c.content, undefined, "a drift classification carries no content to translate");
});

test("classifyEvent: the unknown-type drift record carries unrecognised top-level field names", () => {
  const drift: any[] = [];
  classifyEvent(
    {
      uuid: "drift-3",
      type: "future-type",
      userType: "external",
      message: {},
      brand_new_field: 7,
    } as any,
    { onDrift: (r) => drift.push(r) },
  );
  assert.equal(drift.length, 1);
  assert.ok(
    Array.isArray(drift[0].fields) && drift[0].fields.includes("brand_new_field"),
    "drift.fields must list the unrecognised top-level key(s)",
  );
});

test("classifyEvent: field-level drift on a KNOWN type is logged WITHOUT changing routing", () => {
  const drift: any[] = [];
  const c: any = classifyEvent(
    {
      uuid: "fd-1",
      type: "assistant",
      userType: "external",
      message: { content: [] },
      surprise_field: 123,
    } as any,
    { onDrift: (r) => drift.push(r) },
  );
  // Routing is UNCHANGED — a known type with an extra field still routes to its handler.
  assert.equal(c.class, "content");
  // A field-drift record is logged carrying the new field name.
  const fieldDrift = drift.filter((r) => r.kind === "unknown-fields");
  assert.equal(fieldDrift.length, 1, "exactly one field-drift record for the unexpected field");
  assert.equal(fieldDrift[0].type, "assistant");
  assert.ok(
    fieldDrift[0].fields.includes("surprise_field"),
    "field-drift must name the unexpected top-level field",
  );
});

test("classifyEvent: a KNOWN type with only documented fields logs NO drift", () => {
  const drift: any[] = [];
  classifyEvent(
    {
      uuid: "clean-1",
      type: "user",
      timestamp: "2026-06-03T00:00:00.000Z",
      sessionId: "s",
      message: { content: [] },
      parentToolUseId: null,
      userType: "external",
    } as any,
    { onDrift: (r) => drift.push(r) },
  );
  assert.equal(drift.length, 0, "a fully-documented known event must emit no drift");
});

test("classifyEvent: default sink — an unknown type does not throw even without onDrift", () => {
  // No onDrift supplied → the default sink (stderr) is used; the call must still not throw and
  // must still classify as drift.
  let c: any;
  assert.doesNotThrow(() => {
    c = classifyEvent({ uuid: "d", type: "no-sink-type", userType: "external", message: {} } as any);
  });
  assert.equal(c.class, "drift");
});
