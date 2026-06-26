# CLAUDE.md — ATLAS Codex

Source of truth for this repo. Read this first, every session, before touching code. If something here conflicts with a stale assumption, this file wins. Keep it current: when a PR lands, update the build state in section 8.

---

## 1. What this is

Codex is the study layer of ATLAS, split into its own repo. It ingests CFA Level II study notes, structures them down to the LOS and formula level, and routes study effort to the deficits first. Same thesis as Nexus, pointed at the curriculum instead of the book: a priority view decides where effort goes, weighted by exam weight times mastery gap rather than conviction.

**The mission.** L2 retake on 19 Nov 2026. May 2026 was a 15-point miss (2585 vs 2600 MPS). One topic below 50%, two high-weight topics stuck mid-band. Codex exists to close that specific gap, not to be a generic tracker. Every design call gets weighed against "does this move the November number."

**The deficits, in priority order:**
- Alternative Investments — critical, was below 50%
- Fixed Income — focus, mid-band but 10 to 15% weight makes it expensive
- Derivatives — focus, mid-band
- Corporate Issuers, FSA, Quant — focus, mid-band secondary
- Economics, Equity, Portfolio Management, Ethics — hold, protect with light touches

Deficit-first is the core principle. When a surface has to rank or default-sort anything, it sorts by `focus_index` descending. Strengths sink, gaps rise.

---

## 2. Who does what

The ATLAS seat model carries over:
- **Claude (chat/diagnosing seat):** owns the Supabase layer, writes specs, designs schema and pipeline, diagnoses.
- **CC (this repo):** implements React and JS against the spec. Owns the frontend and the loader wiring.
- **Hlobo:** reviews and merges. Final call on every PR.

CC does not invent schema. If a table or column is missing, flag it for the Supabase seat rather than creating it ad hoc.

---

## 3. Stack and conventions

Unchanged from ATLAS. Do not introduce a bundler or a framework.
- Vanilla CDN React, no build step. `React.createElement` aliased to `h`.
- Supabase (Postgres + Storage + Edge Functions where needed). New org and project for this repo, not the ATLAS prod project.
- Vercel hosting.
- Anthropic API for the ingestion fallback and Ask Codex. Model string: `claude-sonnet-4-6`.

**Design tokens (identical to ATLAS, this is one product family):**
- `--cyan` #3ad6e0, `--amber`, `--card`, `--bg` #0a0d12
- Fonts: Syne (display), DM Sans (body), JetBrains Mono (data)
- Deficit colour language: crit in red/amber, focus in amber, hold in muted cyan marked Maintain

**Rendering the notes.** The source notes use navy EXACT boxes for formulas and green check boxes for worked examples. Preserve that visual language in the Reading view so the rendered chunk looks like the note it came from.

---

## 4. Repo layout (proposed)

```
/CLAUDE.md                 this file
/CODEX_SPEC.md             architecture spec, the detail behind this anchor
/.claude/commands/         slash commands for CC (add as the build matures)
/db/
  codex_schema.sql         DDL, applied via Supabase migration flow
/ingest/
  codex_ingest.py          stage 1 recognizers, proven on the full corpus
  fallback.py              stage 2 Claude LOS + classification (PR3)
  load.py                  upsert + Storage push (PR2)
/seed/
  documents.jsonl          48 docs from the proving run
  los.jsonl                312 LOS
  chunks.jsonl             1392 chunks
/web/                      the React module (CC territory)
  app.js, codex-home.js, reading.js, formula-sheet.js, drill.js, los-tracker.js
```

---

## 5. Data model (summary)

Full DDL in `/db/codex_schema.sql`. Six tables, one view. Invariants CC must respect:
- `content_hash` (sha256 of raw PDF bytes) is the idempotency key. Re-running ingest never duplicates.
- `tenant_id` is on every table, defaulted to the nil UUID. Single user now, multi-tenant later, no backfill.
- `codex_los` is the curriculum spine. Mastery and spaced repetition attach to LOS, not to documents.
- `focus_index = weight_mid * max(target_mastery - avg_mastery, 0)`. Computed in `vw_codex_priority`. Never recompute it client-side from scratch, read the view.

The view `vw_codex_priority` is the academic analogue of `vw_nexus_holdings`. The Codex home board reads straight off it.

---

## 6. Ingestion reality

`codex_ingest.py` ran clean over all 58 PDFs (987 pages, zero errors). What CC needs to know:
- Chunking is reliable everywhere. 1,392 units, no empty docs.
- LOS extraction lands on about 56% of docs with recognizers alone. The corpus drifted across three note-template generations over four months, including different bullet glyphs (U+2022, U+25CF, U+25E6).
- Do not close the LOS gap with more regex. The residual (Equity, Ethics) goes to the Claude fallback in PR3. Equity buries its LOS past the cover page, Ethics has Standards not LOS.
- Ingestion is batch, run on demand when notes are added. No cron. These are static documents, not market data.

---

## 7. Build sequence

Usable to study from after PR4. Everything before is plumbing. Stop at PR6 for the retake, Ask Codex is post-exam.

- [ ] **PR1 Schema + seed.** Apply `codex_schema.sql`, load `/seed/`. Verify `vw_codex_priority` orders by focus index with the deficits on top.
- [ ] **PR2 Loader + Storage.** `load.py` upserts and pushes PDFs to the `codex-notes` bucket. Prove idempotency on a re-run.
- [ ] **PR3 Claude fallback.** `fallback.py` closes Equity and Ethics LOS. NO-LOS count drops to zero.
- [ ] **PR4 Codex Home + Reading view.** Deficit board off the view, plus the chunk reader. First usable surface.
- [ ] **PR5 Formula Sheet + Example Drill.** Highest-leverage surfaces. Formula sheet from `is_formula` chunks, deficit-sorted. Drill from `is_example` chunks.
- [ ] **PR6 LOS Tracker + spaced repetition.** Per-LOS status, SM-2 scheduling, daily due queue.
- [ ] **PR7 Ask Codex.** pgvector, grounded Q and A. Optional, defer.

---

## 8. Current state

- Schema written, not yet applied.
- Parser proven on the full corpus, seed JSONL ready to load.
- Spec complete in `CODEX_SPEC.md`.
- Next: PR1.

Update this section as PRs land.

---

## 9. Guardrails

- Do not touch the ATLAS prod Supabase project. This is a separate org and project.
- Do not duplicate the ATLAS repo's market-data pipeline here. Codex has no Alpaca, Finnhub, or AlphaVantage dependency, and that is deliberate: these are Hlobo's own generated notes, so none of the data-licensing constraints apply. Keep it that way.
- Do not add schema without the Supabase seat. Flag gaps instead.
- Deficit-first is not negotiable. Any default sort is `focus_index` descending.
- Keep the build honest. If a surface is not yet wired to real data, say so in the PR, do not stub fake numbers.
