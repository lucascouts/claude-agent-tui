# JSONL fixture corpus — provenance & sanitization (story 036, §16)

This directory is the **single source of truth** for the sanitized JSONL → ACP fixture corpus the
downstream suites of stories 018–026 (translator / guard-rail / linearization) test against. It is
assembled and consolidated by story **036** — no new translation logic is authored here.

## Files

| File                     | Role                                                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `multi-turn.jsonl`       | Pre-existing (stories 024/011). Recorded multi-turn replay — PRESERVED, not replaced (R1.4).                                               |
| `no-signal.jsonl`        | Pre-existing (story 024). No-end-of-turn-signal case — PRESERVED (R1.4).                                                                   |
| `corpus-all-types.jsonl` | The all-types corpus: ≥14 event types + all 5 block types + a sidechain + a content string/array pair + a `usage` block (R1.1, R1.2).      |
| `v2.1.121/session.jsonl` | Version-labelled set for `claude` 2.1.121 — see "Version axis" below (R2).                                                                 |
| `v2.1.159/session.jsonl` | Version-labelled set for `claude` 2.1.159 — see "Version axis" below (R2).                                                                 |
| `v2.1.176/session.jsonl` | Version-labelled set for `claude` 2.1.176 (story 049) — synthetic; modern `cli` taxonomy, see "Version axis".                              |
| `v2.1.185/session.jsonl` | Version-labelled set for `claude` 2.1.185 (story 049) — synthetic; the version the live machine ran at authoring time, see "Version axis". |
| `versions.json`          | Machine-readable manifest: the version label, source, and synthetic/real flag of each set (R2.3).                                          |

The story-017 linearization **reference transcript** lives at `fixtures/lin-task-sidechain.jsonl`
(+ `.expected.json`) — a different directory (`fixtures/`, not `test/fixtures/`). The
harness references it at that authoritative location for the R4.2 linearization assertion; it is NOT
copied here (one source of truth per the story-017 owner).

## Sanitization (R1.3 — MANDATORY)

Real `claude` transcripts carry the real `cwd`, absolute user paths, git branch, and prompt/response
content. **No unsanitized capture enters the repo.** Every fixture line here is scrubbed per the
story-004 encoding/cwd rule:

- `cwd` / file paths are reduced to a synthetic project root (`/proj`, `/repo`, `/tmp/...`) — never a
  real `/home/<user>/...` path.
- `sessionId` values are synthetic slugs (`sess-corpus`, `sess-v2_1_121`, …), never real session UUIDs.
- prompt/response/tool text is synthetic placeholder content, never captured user content.

`fixtures-coverage.test.ts` enforces this with a **sanitization assertion**: it fails if any fixture
line contains a real absolute user path (`/home/`, `/Users/`) or a raw home `cwd`.

## Version axis (R2) — HONEST PROVENANCE

§16 / §10 of `IMPLEMENTACAO-FORK-ACP.md` anchor the per-binary-version regression on the documented
drift pair **2.1.121 → 2.1.159**. The whole fork's `entrypoint` taxonomy (`src/billing/`) was
reverse-engineered against **2.1.159** specifically.

**No real capture of `claude` 2.1.121 exists in this repo** (the user's local corpus runs 2.1.13x–2.1.16x;
2.1.121 was never captured). Per the story's RESSALVA, rather than falsify a 2nd version as if it were a
real capture, **both** version sets are **SYNTHESIZED / DERIVED** fixtures — consistent with how every
other fixture in this repo is already handled (e.g. the story-017 reference fixture header states its
content is SYNTHESIZED because the real transcript is a non-committable client project):

- **`v2.1.159/`** — synthesized to be FAITHFUL to the documented 2.1.159 format and `entrypoint`
  taxonomy (the binary the fork was reverse-engineered against; `entrypoint:"cli"`).
- **`v2.1.121/`** — synthesized from the _documented format/taxonomy differences_ 2.1.121→2.1.159, to
  exercise drift. It is **clearly marked synthetic/derived** (in `versions.json` and in this file).
  Its drift markers vs 2.1.159 are: (a) a flatter / older entrypoint label on a billable event, and
  (b) a JSONL-format shape difference (see `versions.json` → `driftNotes`).

**Version axis extended (story 049) — 2.1.176 + 2.1.185.** Story 049 makes binary drift _observable_
(the live machine had silently moved 2.1.159 → 2.1.185 → 2.1.186). Two more SYNTHETIC/DERIVED sets are
added, faithful to the documented changelog deltas (story 050 `REBASE-AND-DRIFT.md`):

- **`v2.1.176/`** — modern `cli` subscription taxonomy unchanged from 2.1.159; its `driftNotes` record
  behavioural changes (subagent-of-subagent nesting ≈2.1.172; permission-rule syntax churn ≈2.1.178)
  that do NOT alter the JSONL shape or stop_reason taxonomy.
- **`v2.1.185/`** — the version the live machine ran when story 049 was authored (drifted to 2.1.186
  within days). `entrypoint:"cli"`; `driftNotes` record stall-hint timing tuning (a cadence concern,
  not a shape/taxonomy change).

Both are flagged `"synthetic": true` with a stated basis. They carry a billable `cli` event + a
linearizable parentUuid chain, so the per-version regression harness reports translated/guarded/turns

> 0 for each — and the offline drift detector runs its four checks over them with no real binary.

This is recorded honestly: `versions.json` flags both sets `"synthetic": true` and names the basis. The
drift-check therefore runs against the available (synthesized) sets and the harness documents that the
2.1.121 set is derived, NOT a real binary capture. If a real 2.1.121 transcript is ever captured, it can
replace `v2.1.121/session.jsonl` and re-run the same harness unchanged.
