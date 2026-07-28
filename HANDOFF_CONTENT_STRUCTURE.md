# ATLAS Codex — Content Structure Problem (Handoff)

**For:** the Claude instance that authored Hlobo's CFA Level II study notes
**From:** the Claude instance building ATLAS Codex (the study terminal)
**Date:** 28 July 2026
**Goal:** make the study terminal *read like the Word notes you wrote* — and work out, at a strategic level, why recreating that has been hard.

---

## 1. What ATLAS Codex is

A CFA Level II study terminal targeting the **November 2026** retake. Vanilla Preact via CDN (no bundler), Supabase Postgres, deployed on Vercel.

Content is stored as **typed pedagogical units**, ordered within a reading:

```
los → concept → example → practice → recap
```

Each unit has a `kind` and a typed JSON `payload`. The relevant shapes:

```jsonc
// kind = "los"
{ "outcomes": [ { "num": 1, "text": "...", "verb": "describe" } ] }

// kind = "concept"
{ "prose_md": "markdown",
  "formulas": [ { "label": "...", "expr": "...", "where": "" } ],
  "key_terms": [ { "term": "...", "def": "..." } ],
  "illustration": null }

// kind = "example"
{ "prompt": "...", "steps": [ { "text": "...", "calc": "" } ], "answer": "..." }

// kind = "practice"
{ "vignette": "...", "question": "...",
  "choices": [ { "key": "A", "text": "..." } ],
  "answer": "B", "solution_md": "...", "difficulty": "medium" }

// kind = "recap"
{ "formulas": [...], "los_revisited": [1,2,3], "next_reading_id": "..." }
```

The reading pane renders `prose_md` through a markdown parser that supports headings, pipe tables, ordered/unordered lists, blockquotes, and `KEY:` / `NOTE:` / `WARNING:` / `EXAM TRAP:` callouts.

**The renderer is not the bottleneck.** It renders whatever structure it is given. The problem is that the content it's given has almost no structure.

---

## 2. The core diagnosis

The corpus was built by extracting text from **PDFs**. Every reading — all 48 — came through that path:

| ingest method | documents | chunks | avg chunks/doc | docs with no LOS |
|---|---|---|---|---|
| `recognizer` (PDF) | **48** | 1,392 | 29.0 | 21 |
| `docx` | **0** | — | — | — |

PDF text extraction is **lossy in a way that specifically destroys pedagogy**:

1. **Tables are flattened to one cell per line.** A three-column table becomes a vertical stream of unlabelled values. The column associations — which is the actual teaching content — are gone before the data reaches the database.
2. **Heading hierarchy is lost.** There is no H1/H2/H3; at best a single bolded line per chunk.
3. **Emphasis becomes shouting.** 126 of 212 concept units have ALL-CAPS titles, because the PDF used capitals for emphasis and there's no styling information to recover.
4. **Callouts, boxes and asides are indistinguishable from body text.** Exam traps, definitions and trivia all arrive as the same flat prose.

### How much is affected

Measured across all 179 concept units with prose:

| Topic | Units | Units dominated by flattened tables | Recoverable (numbered rows) | **Unrecoverable** |
|---|---|---|---|---|
| Equity Investments | 29 | 16 | 0 | **16** |
| Financial Stmt Analysis | 19 | 12 | 0 | **12** |
| Fixed Income | 28 | 16 | 5 | **11** |
| Alternative Investments | 18 | 11 | 1 | **10** |
| Economics | 18 | 11 | 2 | **9** |
| Derivatives | 15 | 10 | 1 | **9** |
| Quantitative Methods | 17 | 9 | 0 | **9** |
| Corporate Issuers | 24 | 9 | 1 | **8** |
| Portfolio Management | 7 | 4 | 0 | **4** |
| Ethics | 4 | 0 | 0 | 0 |
| **Total** | **179** | **98 (55%)** | **10** | **88** |

**55% of all concept content is flattened table data.** Only ~10% of that is mechanically recoverable.

---

## 3. What has already been tried, and where each hit a ceiling

Four rounds of work, in order:

**Round 1 — Fix the markdown renderer.**
It was a stub handling only bold/italic/code. Replaced with a real block parser: headings, pipe tables, lists, blockquotes, callouts.
*Ceiling:* it can only render structure that exists in the text. There were no tables or headings in the source to render.

**Round 2 — Fix the layout.**
43 CSS class names were written against invented names rather than what the components render, so the reading pane had effectively no layout — content ran off the left edge, the progress rail collapsed to a vertical dot column, the light theme was unreadable.
*Ceiling:* real bug, genuinely fixed, but purely cosmetic. Didn't touch content structure.

**Round 3 — Recover structure heuristically.**
Lone `•` glyphs on their own line now form proper list items (33 units affected). Where flattened tables have *numbered rows*, the table is reconstructed by treating bare integers as row boundaries.
*Ceiling:* only 10 of 98 affected units have numbered rows. For the rest there is no anchor. Guessing column counts would pair the wrong value with the wrong label — a table asserting REOCs are tax-exempt when REITs are — which in exam material is worse than an ugly list, because it looks authoritative and would be revised from. **We deliberately stopped here rather than fabricate structure.**

**Round 4 — Ingest the Word notes directly.**
Hlobo supplied four of your `.docx` notes. They have *real* headings, *real* tables and explicit `!` trap markers. A converter (`ingest/codex_docx.py`) maps them onto the unit model losslessly. Verified: 36 units across QM LM1/LM3/LM5 and Ethics LM2, rendering with correct tables, headings and callouts.
*Status:* **built, merged, but not yet run.** There are still zero `docx` documents in the database.

---

## 4. Important confound — what Hlobo is currently seeing

The two screenshots that prompted this handoff show `LM1: Basics of Multiple Regression` and `MODEL SPECIFICATION ERRORS` still looking flat. Both are **PDF-derived readings** (`ingest_method = 'recognizer'`), *not* the `.docx` versions. The `.docx` ingest has not been run.

Worth noting how thin the PDF versions are:

| Reading | Chunks from PDF | Units | Units the `.docx` version yields |
|---|---|---|---|
| LM1 Multiple Regression | 7 | 3 | **6** |
| LM3 Model Misspecification | 5 | 7 | **7** |
| LM2 Evaluating Model Fit | 3 | 4 | — |
| LM4 Extensions | 4 | 5 | — |

The PDF pipeline captured **3–7 chunks** for readings your notes cover in far greater depth. So this isn't only a formatting loss — it's a **content volume loss**. The terminal is showing a thin, flattened shadow of the notes.

---

## 5. The strategic question for you

The tactical fix is known: run the `.docx` ingest. The higher-level question is **what the source of truth should be.**

Three options, and we'd value your view given you produced the notes:

### Option A — Word notes become the primary source
Hlobo authors (or you generate) notes as `.docx` in the established format; `codex_docx.py` ingests them. PDF becomes fallback only.
- *Pro:* lossless, already built and verified, human-readable and editable.
- *Con:* depends on all 48 readings existing as `.docx`. **Unknown how many do — currently four.** Structure is carried by Word styling conventions, which are easy to break accidentally.

### Option B — You author directly into the unit schema
Rather than generating Word documents that get parsed back out, emit JSON matching the payload shapes in §1 directly.
- *Pro:* zero parsing loss and no format-convention fragility. Gives access to fields the parser can't populate well — `key_terms`, `illustration`, worked `example` units with discrete `steps`, and real `practice` items with distractors and `solution_md`.
- *Con:* not human-editable in the way a Word document is; needs a schema contract to be maintained.

### Option C — LLM restructuring pass over the existing PDF corpus
Feed the 1,392 flattened chunks through a model to re-impose headings, rebuild tables and tier content.
- *Pro:* fixes all 48 readings without re-authoring.
- *Con:* **the information may genuinely be gone.** For a flattened table, recovering the columns means inferring which value belongs to which label — for CFA material that risks confidently wrong output. Would need careful evaluation of whether it's reconstruction or invention.

### Specific things we'd like your input on

1. **How were the notes produced?** If you generated them, could you emit Option B's JSON directly, or a strict markdown that maps to it cleanly?
2. **Do notes exist for all 48 readings, or only some?** This determines whether Option A is a complete solution or a partial one.
3. **On Option C:** for the 88 unrecoverable units, is LLM reconstruction of flattened tables defensible for exam material, or should we treat that content as needing re-authoring?
4. **What structure actually made your notes effective?** We've inferred the visible grammar — sections tied to LOS, comparison tables, `!` exam traps, worked examples as numbered steps. But if there's pedagogical intent behind the format we've missed, we're currently reproducing form without understanding purpose.

---

## 6. The authoring format we reverse-engineered

For reference, this is the grammar `codex_docx.py` keys off. If notes deviate from it, conversion degrades:

| Element | Word styling | Becomes |
|---|---|---|
| Title block | Bold paragraphs before first Heading 1 | reading title, topic |
| `LEARNING OUTCOMES` | Heading 1 + 2-col table `LOS n \| Outcome` | `los` unit |
| `SECTION n: TITLE (LOS x)` | Heading 1 | one `concept` unit, tagged with that LOS |
| Sub-topic | Heading 2 / 3 | `##` / `###` in prose |
| Comparison table | Any table, 2+ cols, 2+ rows | markdown pipe table |
| Exam trap | 1×2 table, first cell `!` | `EXAM TRAP:` callout |
| Formula box | 1×2 table, first cell titled | entry in `formulas[]` |
| Worked example / steps | Single-column table, first row = title | `###` heading + list |

Observed in the four samples: QM LM1 (5 H1, 3 H2, 17 tables, 7 traps), QM LM3 (6 H1, 7 H2, 21 tables), QM LM5 (12 H1, 7 H2, 54 tables, 16 traps), Ethics LM2 (9 H1, 23 H2, **224 tables**).

Ethics is organised by Standard rather than by LOS and has no `LEARNING OUTCOMES` table — the converter handles this, but it shows the format isn't uniform across topics.

---

## 7. Summary

- The terminal doesn't read like the notes because **it was never given the notes** — it was given PDF-extracted text that lost the tables, headings and emphasis those notes are built on.
- **55% of concept content is flattened table data**; roughly 10% is mechanically recoverable, and we stopped short of guessing at the rest because wrong column associations in exam material are worse than ugly ones.
- The renderer, layout and ingest tooling are all now in place and verified. **The binding constraint is source fidelity, not presentation.**
- The immediate unblock is running the `.docx` ingest. The strategic question is whether authored notes — as Word, or as structured JSON — should replace PDFs as the source of truth for all 48 readings.
