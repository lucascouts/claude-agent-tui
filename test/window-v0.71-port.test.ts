// Story 009 / Task 8.2 — the reachable half of the `v0.71.0` → `v0.75.1` window (R5.2, R7.3, R7.4).
//
// CONTRACT. §16 of docs/REBASE-AND-DRIFT.md classified 13 upstream commits and found three
// portable FRAGMENTS, no whole commits. This file pins one behaviour per ported fragment, plus
// the catalogue entry R5.2 asks for.
//
//   R5.2  Fable 5.1 joins the curated catalogue. The alias is read from the installed binary
//         (`strings /opt/bin/claude` → `fable51`, `claude-fable-5-1`), never guessed, and the
//         entry declares its effort capability like every other Claude-5-family surface.
//   R7.3  `#1079` and `#1080` are PORTABLE IN PART, so the reachable part lands AND the code
//         records which half was cut.
//   R7.4  A port that would deliver upstream's degraded path, or produce data no client renders,
//         says so at the call site instead of presenting itself as parity. `CUT_FROM_UPSTREAM`
//         is that statement, made machine-checkable rather than left in prose.
//
// What is NOT here, deliberately: `#991`'s outcome. §16.7 made it conditional on a client asking
// for a compaction event, and none does — this engine already keeps continuity across the
// boundary through the JSONL `summary` row (linearize.ts:106-109).
//
// node:test runner (build first):
//   npm run build && node --experimental-strip-types --test test/window-v0.71-port.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MODEL_CATALOG,
  MODEL_CONTEXT_WINDOWS,
  MODEL_ID_CONTEXT_WINDOWS,
  MODEL_VERSION_LABELS,
  REASONING_EFFORT_LEVELS,
} from "../dist/model-catalog.js";
import {
  billsClaudeSubscription,
  holdsNonSubscriptionCredential,
  CUT_FROM_UPSTREAM as HIDE_AUTH_CUT,
} from "../dist/hide-claude-auth.js";
import {
  gatewayAuthStatus,
  notLoggedInAuthStatus,
  CUT_FROM_UPSTREAM as AUTH_STATUS_CUT,
} from "../dist/auth-status.js";

// ---- R5.2 — Fable 5.1 in the curated catalogue ---------------------------------------------

test("R5.2 the catalogue offers Fable 5.1 under the alias the installed CLI accepts", () => {
  const entry = MODEL_CATALOG.find((m) => m.value === "fable51");
  assert.ok(
    entry,
    "MODEL_CATALOG must carry a `fable51` entry — the alias is in the installed binary " +
      "(fable51, claude-fable-5-1), so the catalogue is what is behind, not the CLI",
  );
});

test("R5.2 the Fable 5.1 entry declares its effort capability", () => {
  const entry = MODEL_CATALOG.find((m) => m.value === "fable51");
  assert.equal(
    entry?.supportsEffort,
    true,
    "every Claude-5-family surface in this catalogue is effort-capable; an entry that omits it " +
      "silently drops the effort selector for anyone who picks that model",
  );
  assert.deepEqual(
    entry?.supportedEffortLevels,
    REASONING_EFFORT_LEVELS,
    "the levels must be the same enum the rest of the catalogue advertises, not a subset",
  );
});

test("R5.2 Fable 5.1 leads Fable 5 in the picker, newest first", () => {
  const i51 = MODEL_CATALOG.findIndex((m) => m.value === "fable51");
  const i5 = MODEL_CATALOG.findIndex((m) => m.value === "fable5");
  assert.ok(i51 >= 0 && i5 >= 0, "both Fable entries must exist");
  assert.equal(
    i51,
    i5 - 1,
    "Fable 5.1 must sit IMMEDIATELY BEFORE Fable 5 — the newest member of the family leads it, " +
      "the way `fable5` itself sits right after `default`. Adjacency is the assertion: a 5.1 " +
      "parked at the end of the list is present but not offered",
  );
});

test("R5.2 Fable 5.1 carries a version label, so the selector description composes", () => {
  assert.match(
    MODEL_VERSION_LABELS.fable51 ?? "",
    /Fable 5\.1/,
    "modelSelectorDescription() composes `<version label> · <tagline>`; without a label the entry " +
      "renders as a bare tagline and is indistinguishable from Fable 5 in the picker",
  );
});

test("R5.2 Fable 5.1's window is declared in BOTH tables, which are not the same table", () => {
  assert.equal(
    MODEL_CONTEXT_WINDOWS.fable51,
    1_000_000,
    "the alias table seeds the window from what `/model fable51` sends",
  );
  assert.equal(
    MODEL_ID_CONTEXT_WINDOWS["claude-fable-5-1"],
    1_000_000,
    "the ID table is the exact-ID source of truth that AUTHORITATIVELY refines the window from a " +
      "turn's actual `model` field in the JSONL. Seeding only the alias leaves the refinement " +
      "step with no entry, so the correction silently does not happen",
  );
});

// ---- R7.3 — `#1079`'s reachable half: pure credential classification ------------------------

test("R7.3 billsClaudeSubscription is an allowlist: every field must prove the subscription pays", () => {
  assert.equal(
    billsClaudeSubscription({ subscriptionType: "max" }),
    true,
    "a plain subscription account bills the subscription",
  );
  assert.equal(
    billsClaudeSubscription(undefined),
    false,
    "no account cannot bill anything",
  );
  assert.equal(
    billsClaudeSubscription({}),
    false,
    "without subscriptionType the CLI reports no subscription",
  );
  assert.equal(
    billsClaudeSubscription({ subscriptionType: "max", tokenSource: "bearer" }),
    false,
    "a bearer/OAuth environment token pays instead of the subscription",
  );
  assert.equal(
    billsClaudeSubscription({ subscriptionType: "max", apiProvider: "bedrock" }),
    false,
    "the Anthropic OAuth login applies only to firstParty; a third-party backend authenticates externally",
  );
  assert.equal(
    billsClaudeSubscription({ subscriptionType: "max", apiKeySource: "ANTHROPIC_API_KEY" }),
    false,
    "credential precedence puts that key above the /login subscription, so the key pays",
  );
});

test("R7.3 an unknown apiKeySource keeps the guard on rather than assuming a subscription", () => {
  assert.equal(
    billsClaudeSubscription({ subscriptionType: "max", apiKeySource: "something-new" }),
    true,
    "the SDK types apiKeySource as an open string, so this is an ALLOWLIST of keys that outrank " +
      "the subscription — an unrecognised source is not one of them and the subscription still pays",
  );
});

test("R7.3 holdsNonSubscriptionCredential is the complement, and false means no way to pay", () => {
  assert.equal(holdsNonSubscriptionCredential(undefined), false);
  assert.equal(
    holdsNonSubscriptionCredential({ subscriptionType: "max" }),
    false,
    "a subscription-only account holds no credential this integration accepts",
  );
  assert.equal(holdsNonSubscriptionCredential({ apiProvider: "vertex" }), true);
  assert.equal(holdsNonSubscriptionCredential({ tokenSource: "oauth" }), true);
  assert.equal(
    holdsNonSubscriptionCredential({ apiKeySource: "apiKeyHelper" }),
    true,
  );
});

// ---- R7.3 — `#1080`'s reachable half: pure AuthStatus constructors --------------------------

test("R7.3 notLoggedInAuthStatus is the signed-out identity, and is not shared state", () => {
  const a = notLoggedInAuthStatus();
  assert.deepEqual(a, { kind: "none", label: "Not logged in" });
  a.label = "mutated";
  assert.equal(
    notLoggedInAuthStatus().label,
    "Not logged in",
    "it must return a fresh object; a shared constant would let one caller's edit reach every other",
  );
});

test("R7.3 gatewayAuthStatus reduces a base URL to its host, and survives a malformed one", () => {
  assert.deepEqual(gatewayAuthStatus("https://gw.example.com/v1"), {
    kind: "gateway",
    label: "Custom model gateway",
    detail: "gw.example.com",
  });
  assert.deepEqual(
    gatewayAuthStatus(),
    { kind: "gateway", label: "Custom model gateway" },
    "no URL means no detail key at all, not an empty one",
  );
  assert.equal(
    gatewayAuthStatus("not a url").detail,
    "not a url",
    "an unparseable base URL falls back to the raw string rather than throwing — the gateway owns " +
      "the credentials either way, and losing the identity to a URL typo would be the worse failure",
  );
});

// ---- R7.4 — the cut halves say so, at the call site -----------------------------------------

test("R7.4 the hide-claude-auth port records which half was cut and why", () => {
  assert.equal(HIDE_AUTH_CUT.pr, 1079);
  assert.ok(
    HIDE_AUTH_CUT.cut.includes("refuseClaudeSubscriptionTurn"),
    "the turn-refusal half is the cut one — it acts on a turn, and this fork's prompt() loop is " +
      "story 011's stub (ENGINE_NOT_IMPLEMENTED_011) pending 023",
  );
  assert.match(
    HIDE_AUTH_CUT.why,
    /turn|023|stub/i,
    "R7.4 wants the REASON at the call site, not just a list of missing names",
  );
});

test("R7.4 the auth-status port records that the notification is unreachable chain-wide", () => {
  assert.equal(AUTH_STATUS_CUT.pr, 1080);
  assert.ok(
    AUTH_STATUS_CUT.cut.includes("_auth/status_update"),
    "the notification is the cut half",
  );
  assert.match(
    AUTH_STATUS_CUT.why,
    /schema|capability|zed/i,
    "the reason is that no client in this chain negotiates it — zero occurrences in the packaged " +
      "Zed's crates AND in agent-client-protocol-schema-1.5.0 — which is a stronger claim than " +
      "'not wired yet' and must not be softened into one",
  );
});
