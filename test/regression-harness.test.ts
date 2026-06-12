// Story 036 / Task 2.1 (R3.1, R3.2, R3.3) — per-binary-version regression harness, non-fatal drift.
//
// A node:test DRIVER that iterates the version-labelled fixture sets (2.1.121, 2.1.159) and runs the
// REUSED units against each: the translator (classifyEvent → toAcpNotifications), the billing
// guard-rail (inspectEvent), and the linearization (readOrderedTurns). It authors NO new translation
// logic — it only composes the existing seams.
//
// §16 R6 — drift is LOGGED, NOT FATAL: when a fixture's translation or entrypoint taxonomy diverges
// from its version baseline, the harness records a non-fatal Finding (with the version it belongs to)
// and CONTINUES — it never throws/aborts the run. The harness reports which versions were exercised
// (R3.3). A synthetic injected drift proves the non-fatal + attributable contract.
//
// node:test runner: `node --experimental-strip-types --test test/regression-harness.test.ts`
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classifyEvent } from "../dist/event-switch.js";
import { toAcpNotifications } from "../dist/lib.js";
import { inspectEvent } from "../dist/billing/entrypoint-guard.js";
import { readOrderedTurns } from "../dist/linearize.js";

const logger = { log() {}, error() {} } as any;
const client = {} as any;

interface VersionEntry {
  version: string;
  path: string;
  synthetic: boolean;
  entrypoint: string;
}

function loadManifest(): VersionEntry[] {
  const url = new URL("./fixtures/versions.json", import.meta.url);
  return (JSON.parse(readFileSync(url, "utf8")) as { versions: VersionEntry[] }).versions;
}

function loadSet(path: string): Array<Record<string, unknown>> {
  const url = new URL(`./fixtures/${path}`, import.meta.url);
  return readFileSync(url, "utf8")
    .trim()
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** A non-fatal drift finding attributed to a specific binary version (R3.2, R3.3). */
interface Finding {
  version: string;
  unit: "translator" | "guard-rail" | "linearization";
  kind: string;
  detail: string;
}

interface HarnessReport {
  versionsExercised: string[];
  findings: Finding[];
  /** Per-version counts so the report is attributable (R3.3). */
  perVersion: Record<string, { translated: number; guarded: number; turns: number }>;
}

/**
 * The harness: run the three reused units against every version set. Drift is collected into
 * `findings` (NON-FATAL) — a divergence NEVER throws. `injectDrift` lets a test plant a synthetic
 * drift event into one version's stream to prove the non-fatal + attributable behaviour.
 */
async function runHarness(
  sets: VersionEntry[],
  opts: { injectDrift?: { version: string; event: Record<string, unknown> } } = {},
): Promise<HarnessReport> {
  const findings: Finding[] = [];
  const versionsExercised: string[] = [];
  const perVersion: HarnessReport["perVersion"] = {};

  for (const entry of sets) {
    const rows = loadSet(entry.path);
    if (opts.injectDrift && opts.injectDrift.version === entry.version) {
      rows.push(opts.injectDrift.event);
    }
    versionsExercised.push(entry.version);
    perVersion[entry.version] = { translated: 0, guarded: 0, turns: 0 };

    // --- translator unit: each content event → session/update via the reused translator ---------
    const cache = {};
    for (const row of rows) {
      let classification: any;
      try {
        classification = classifyEvent(row as any, { onDrift: () => {} });
      } catch (e) {
        // a throw IS a drift finding — logged, not fatal.
        findings.push({
          version: entry.version,
          unit: "translator",
          kind: "classify-threw",
          detail: `${String(row.type)}: ${(e as Error).message}`,
        });
        continue;
      }
      if (classification.class === "drift") {
        findings.push({
          version: entry.version,
          unit: "translator",
          kind: "unknown-type",
          detail: `event type "${classification.type}" not routed (DEFAULT branch)`,
        });
        continue;
      }
      if (classification.class === "content") {
        try {
          toAcpNotifications(classification.content, classification.role, `sess-${entry.version}`, cache, client, logger, {
            registerHooks: false,
          });
          perVersion[entry.version].translated += 1;
        } catch (e) {
          findings.push({
            version: entry.version,
            unit: "translator",
            kind: "translate-threw",
            detail: `${String(row.type)}: ${(e as Error).message}`,
          });
        }
      }
    }

    // --- guard-rail unit: read entrypoint per billable event; drift if NOT subscription ----------
    for (const row of rows) {
      const decision = inspectEvent(row as any);
      if (decision.action === "skip") continue;
      perVersion[entry.version].guarded += 1;
      if (decision.action !== "allow") {
        // a non-subscription entrypoint on a billable event is a per-version TAXONOMY drift —
        // logged, never aborting the run (the live guard would stop the session; the harness only logs).
        findings.push({
          version: entry.version,
          unit: "guard-rail",
          kind: `entrypoint-${decision.entrypointClass}`,
          detail: `billable event carries entrypoint "${decision.entrypoint}" (class ${decision.entrypointClass})`,
        });
      }
    }

    // --- linearization unit: the set must linearize without throwing -----------------------------
    try {
      const turns = await readOrderedTurns(`sess-${entry.version}`, "/proj", { getMessages: () => rows });
      perVersion[entry.version].turns = turns.length;
    } catch (e) {
      findings.push({
        version: entry.version,
        unit: "linearization",
        kind: "linearize-threw",
        detail: (e as Error).message,
      });
    }
  }

  return { versionsExercised, findings, perVersion };
}

// === R3.1 / R3.3 — both version sets are exercised by all three units ==========================

test("harness runs translator + guard-rail + linearization against BOTH version sets (R3.1, R3.3)", async () => {
  const report = await runHarness(loadManifest());
  assert.deepEqual(report.versionsExercised.sort(), ["2.1.121", "2.1.159"], "both versions exercised");
  for (const v of ["2.1.121", "2.1.159"]) {
    assert.ok(report.perVersion[v].translated > 0, `${v}: translator ran on content events`);
    assert.ok(report.perVersion[v].guarded > 0, `${v}: guard-rail inspected billable events`);
    assert.ok(report.perVersion[v].turns > 0, `${v}: linearization produced turns`);
  }
});

// === R3.2 / R3.3 — the corpus's real per-version taxonomy drift is logged-not-fatal, attributed =

test("the 2.1.121 entrypoint-taxonomy drift is logged as a NON-FATAL finding attributed to 2.1.121 (R3.2, R3.3)", async () => {
  const report = await runHarness(loadManifest()); // does NOT throw despite the drift
  const v121 = report.findings.filter((f) => f.version === "2.1.121" && f.unit === "guard-rail");
  assert.ok(v121.length >= 1, "the 2.1.121 'claude-cli' entrypoint must surface as a guard-rail drift finding");
  assert.ok(
    v121.every((f) => f.kind.startsWith("entrypoint-")),
    "the finding is an entrypoint-taxonomy drift",
  );
  // 2.1.159 ('cli' = subscription) must NOT raise a guard-rail finding — drift is attributable per version.
  const v159 = report.findings.filter((f) => f.version === "2.1.159" && f.unit === "guard-rail");
  assert.equal(v159.length, 0, "2.1.159 'cli' is subscription — no guard-rail drift for that version");
});

// === R3.2 — a SYNTHETIC injected drift is logged-not-fatal and attributed to its version ========

test("a synthetic injected unknown-type drift is logged non-fatally and attributed to its version (R3.2)", async () => {
  let report: HarnessReport | undefined;
  // The injected future-type event must NOT abort the run — the harness completes and logs it.
  await assert.doesNotReject(async () => {
    report = await runHarness(loadManifest(), {
      injectDrift: {
        version: "2.1.159",
        event: {
          type: "future-unknown-type-2_2_0",
          uuid: "inj-1",
          sessionId: "sess-2.1.159",
          version: "2.1.159",
          userType: "external",
          message: { role: "system", content: [] },
        },
      },
    });
  });
  assert.ok(report, "harness completed (did not abort) despite the injected drift");
  const injected = report!.findings.filter(
    (f) => f.version === "2.1.159" && f.unit === "translator" && f.kind === "unknown-type",
  );
  assert.equal(injected.length, 1, "the injected unknown type is logged exactly once as a translator drift");
  assert.match(injected[0].detail, /future-unknown-type-2_2_0/, "the finding names the drifting type");
  // the run still exercised BOTH versions — the drift did not short-circuit iteration.
  assert.deepEqual(report!.versionsExercised.sort(), ["2.1.121", "2.1.159"]);
});

// === R3.3 — the report attributes every finding to a specific version ==========================

test("every finding carries the version it belongs to (attributable) (R3.3)", async () => {
  const report = await runHarness(loadManifest());
  for (const f of report.findings) {
    assert.ok(["2.1.121", "2.1.159"].includes(f.version), `finding ${f.kind} must name a known version, got ${f.version}`);
  }
});
