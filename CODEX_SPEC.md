# ATLAS CODEX — Study Layer Spec

Working name: **Codex**. The academic surface of ATLAS. Same thesis as Nexus, pointed at the curriculum instead of the book: a priority view decides where effort goes, weighted by exam weight times mastery gap rather than conviction. The road to 19 Nov runs through here.

Status: ingestion proven against the full 58-PDF corpus in this session. Schema and seed data ready. This spec is the handoff to CC for the React layer.

---

## 1. Why this exists

The May result was a 15-point miss driven by one topic below 50% (Alternative Investments) and two high-weight topics stuck mid-band (Fixed Income, Derivatives). A generic study tracker treats every topic equally. Codex does not. It ingests the notes you already have, structures them down to the LOS and formula level, and routes you to the deficits first, the same way Nexus routes you to the highest-conviction holding first.

The through-line from the standalone study terminal: that terminal's deficit board becomes `vw_codex_priority` in Postgres, now driven by real per-LOS mastery instead of a manual slider.

---

## 2. Architecture

Three stages, matching the ATLAS division of labour (Supabase layer owned in the diagnosing seat, React owned by CC).

```
  STAGE 1: INGEST (local CLI, run on demand)
  notes/*.pdf
     -> deterministic recognizers  (codex_ingest.py, proven this session)
     -> Claude fallback for the long tail (LOS + classification)
     -> structured records (documents / los / chunks)

  STAGE 2: STORE (Supabase)
     -> upsert rows, idempotent on content_hash
     -> raw PDF to Supabase Storage (bucket: codex-notes)
     -> optional: embed chunks for Ask Codex (pgvector)

  STAGE 3: SURFACE (ATLAS React module)
     -> Codex Home (deficit board)  -> Reading view
     -> Formula Sheet  -> Example Drill  -> LOS Tracker  -> Ask Codex
```

Ingestion is batch, not cron. These are static documents, not market data, so there is no Vercel cron analogue here. You run the CLI when you add notes. That is the whole job.

---

## 3. Data model

Full DDL in `codex_schema.sql`. Six tables plus one view:

- `codex_topics`: the ten topics, carrying the May band (`crit`/`focus`/`hold`) and exam weight bands. Reference data, seeded in the migration.
- `codex_documents`: one row per note PDF. `content_hash` is the idempotency key, so re-running ingest never duplicates.
- `codex_los`: the curriculum spine. One row per learning outcome per reading. This is what mastery attaches to.
- `codex_chunks`: subsection-level study units with `is_example` and `is_formula` flags and an optional `embedding`.
- `codex_progress`: per-LOS mastery, status, and SM-2 spaced-repetition state.
- `codex_reviews`: the review log feeding the scheduler.
- `vw_codex_priority`: focus index per topic = weight_mid times gap to target. The Codex home board reads straight off this.

Every table carries `tenant_id` defaulted to the nil UUID. Single-user today, but it ports into the multi-tenant skeleton with no backfill when you get there.

---

## 4. Ingestion pipeline

### 4.1 What the recognizers proved

`codex_ingest.py` ran clean over all 58 PDFs (987 pages, zero errors). Coverage from this session:

```
TOPIC                            DOCS  LOS  CHUNKS  EXMPL  FORMULA  NO-LOS
Alternative Investments             4   59     124     26       48       1
Fixed Income                        4   43     197     28       43       0
Derivatives                         4   30     155     21       69       2
Corporate Issuers                   4   31      82     11       14       0
Financial Statement Analysis        7   53     290     18       83       4
Quantitative Methods                7   12      53      8       12       5
Economics                           2   25      62     10        3       0
Equity Investments                  6    0     334     27      101       6
Portfolio Management                7   59      74     26       45       0
Ethical & Professional Stds         3    0      21      9        8       3
TOTAL                              48  312    1392    184      426      21
```

Chunking is reliable everywhere (1,392 units, no empty docs). LOS extraction lands cleanly on roughly 56% of docs. The gap is template drift: these notes were generated across four months and the conventions moved, three generations at least.

- Dominant template: `LOS CHECKLIST` table, `SECTION N:` headers, `N.N` subsections.
- April Quant build: `LEARNING OUTCOME STATEMENTS` bullets, `PART I` sections, `N.N —` subsections.
- Ethics: `STANDARD I` to `VII`, no LOS, no decimal subsections.
- And glyph drift inside that: bullets appear as U+2022, U+25CF, U+25E6 across files. FI returned zero LOS until U+25CF was added.

The lesson: deterministic recognizers get you most of the way, and chasing the rest with more regex is a losing game. Equity and Ethics are the residual (Equity buries LOS past the cover, Ethics has none in the conventional sense).

### 4.2 The Claude fallback

For any document where the recognizers return fewer than 2 LOS, or where a chunk needs classifying, hand the page text to the API. This is the same pattern already wired into ATLAS artifacts, so no new dependency.

- Model: `claude-sonnet-4-6`.
- LOS extraction: pass the first ~2 pages, ask for strict JSON `[{los_num, outcome, command_verb}]`, no prose, no fences. Parse and insert with `source = 'claude_fallback'`.
- Chunk classification: for the long tail of `is_formula` / `is_example`, the navy-box colour heuristic already catches most. Use Claude only to backfill chunks where colour data is absent.
- Idempotency holds: the fallback writes the same `content_hash`-keyed rows, so a document never double-loads.

Net effect: recognizers do the cheap 56%, Claude closes Equity and Ethics, and the corpus reaches full LOS coverage without a regex zoo.

### 4.3 Loader

After parsing, the CLI:
1. Computes `content_hash` (sha256 of raw bytes), skips if already present for the tenant.
2. Uploads the PDF to Storage bucket `codex-notes` at `{topic_id}/{filename}`, stores `storage_path`.
3. Upserts documents, then los, then chunks (FK order).
4. If pgvector is on, embeds chunk bodies and writes `embedding`.

Seed JSONL from this session is in `codex_seed/` (documents, los, chunks), loadable directly while the loader is being wired.

---

## 5. The ATLAS Codex module (CC build)

Stack and house style are the ATLAS defaults: vanilla CDN React, `h` alias, Supabase client, no bundler. Design tokens unchanged: `--cyan` #3ad6e0, `--amber`, `--card`, `--bg` #0a0d12; Syne display, DM Sans body, JetBrains Mono data.

### 5.1 Codex Home — the deficit board
Reads `vw_codex_priority`. Topics ranked by focus index, the three deficits at top in amber/crit, strengths sinking to the bottom marked Maintain. Same visual language as the study terminal. Each row expands to its readings (`codex_documents` for that topic) with a per-reading progress ring from `codex_progress`.

### 5.2 Reading view
Renders `codex_chunks` for a document in `ord`. Formula chunks get the navy EXACT treatment, examples render as collapsible green blocks, matching how the source notes already look. Section headers from `section_title`. A right rail lists the document's LOS with mastery dots.

### 5.3 Formula Sheet
Auto-assembled from `is_formula` chunks, filterable by topic. Default sort puts deficit topics first. This is the single highest-leverage surface for the retake: it turns 426 scattered formula boxes into one reviewable sheet, weighted to where you bled points. The FFO chunk extracted this session is a clean example of what populates it.

### 5.4 Example Drill
`is_example` chunks (184 of them) as active-recall cards. Heading and prompt shown, body hidden behind a reveal, then a 0 to 5 self-rating that writes to `codex_reviews` and updates the SM-2 schedule in `codex_progress`.

### 5.5 LOS Tracker
The curriculum spine as a checklist per topic. Each LOS shows status, mastery, and next-due date. The `command_verb` (calculate, explain, derive) hints at difficulty, calculate-LOS in your weak topics are where item-set points concentrate.

### 5.6 Ask Codex (optional, pgvector)
Semantic search over `codex_chunks.embedding`. Natural-language question, top-k chunks, Claude synthesizes an answer grounded in your own notes with citations back to reading and subsection. Defer until the base module is merged.

---

## 6. Build sequence

Staged for incremental merge, the way the Cortex six-PR sequence ran:

1. **PR1 Schema + seed.** Apply `codex_schema.sql`, load `codex_seed/` JSONL. Verify `vw_codex_priority` returns sensible focus ordering.
2. **PR2 Loader + Storage.** Wire `codex_ingest.py` to upsert and to push PDFs to the `codex-notes` bucket. Idempotency check on a re-run.
3. **PR3 Claude fallback.** Close Equity and Ethics LOS. Confirm NO-LOS drops to zero.
4. **PR4 Codex Home + Reading view.** The deficit board and the reader. First usable surface.
5. **PR5 Formula Sheet + Example Drill.** The two highest-leverage study surfaces.
6. **PR6 LOS Tracker + spaced repetition.** Progress, scheduling, the daily due queue.
7. **PR7 Ask Codex.** Embeddings and grounded Q and A. Optional.

Usable to study from after PR4. Everything before that is plumbing.

---

## 7. Decisions for you

- **Home or new repo.** Default is main ATLAS now, tenant_id carried so it lifts into the multi-tenant skeleton later. Say the word if you want it born in the new org instead.
- **Data licensing.** Not a concern here. These are your own generated notes, not redistributed vendor data, so none of the Alpaca/Finnhub/AlphaVantage constraints apply. Codex sidesteps the licensing question that gates the rest of commercial ATLAS.
- **docx handling.** Two loose .docx files in the corpus are not yet parsed. Trivial to add via the docx path, flag if you want them in.
- **Scope of v1.** I would stop at PR6 for the retake and treat Ask Codex as a post-exam build. The formula sheet and example drill are what move the November number.
