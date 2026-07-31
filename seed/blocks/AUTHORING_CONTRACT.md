# Codex authoring contract — v2

**For:** the Claude instance that authors Hlobo's CFA Level II notes
**From:** the Claude instance building ATLAS Codex
**Status:** v1 (concept units only) is applied and live for Alternatives LM1–LM4.
This extends it to cover the rest of a reading.

---

## 1. Do not route content through a PDF

`recorder.py` shadows the builder that produces the study PDFs, so the same
authoring source emits block JSON directly. That is why Alternatives rendered
correctly on the first attempt.

Every defect in the terminal today traces to content that went through a PDF and
was re-extracted. Measured on the 44 readings still on that path:

| Field | Should hold | Actually holds |
|---|---|---|
| `example.steps` | discrete solution steps | wrapped lines of prose — 171 of 184 units |
| `formulas[].expr` | an expression | paragraphs averaging 251–608 chars; 181 truncated at exactly 300, 148 of those ending mid-word |
| `is_formula` chunks | formulas | 426 chunks averaging 786 chars; only 209 contain an `=` |
| `practice` | questions | placeholders — 152 of 152 |

None of that is recoverable by parsing. Please emit JSON, never a PDF.

## 2. What v1 covered, and what it missed

v1 emitted `concept` units and their blocks. It did not emit `los`, `practice`
or `recap`, so those four kinds silently kept their PDF-derived originals — which
is why a reading with beautifully authored concepts still hits a truncated recap
and a shredded example a few units later.

`example` units need no constructor. A worked example belongs **inside** the
concept it teaches, as a `worked` block — v1 already does this well, and the
23 worked blocks in Alternatives read correctly. The standalone `example` units
are a PDF-pipeline artefact: in Alternatives they are titled "Residential
Properties", "Commercial Use Properties", "Appraisal-Based Indexes" — concept
sections mis-typed, not examples. The seeder now deletes them alongside the
concept blobs.

## 3. The JSON shape

One file per reading. Fields marked **new** did not exist in v1.

```jsonc
{
  "module": "LM1",
  "module_title": "Introduction to Commodities and Commodity Derivatives",
  "topic_id": "alt",
  "source_ref": "CFA 2026 L2 V8/LM1",
  "reading_id": "9e4f73e51fc88d63",     // new — see §4. no more hardcoded map

  "los": [                               // new
    { "num": 1, "verb": "describe",
      "text": "types of commodity sectors and their characteristics" }
  ],

  "units": [                             // unchanged from v1
    { "ordinal": 1, "title": "Why Commodities Are Different",
      "blocks": [ /* lead, prose, key, trap, exam, formula, worked, table_*, ... */ ] }
  ],

  "practice": [                          // new
    { "ordinal": 1,
      "los": 2,
      "difficulty": "medium",            // easy | medium | hard
      "vignette": "Ndlovu Capital holds 11 September crude contracts at £10 …",
      "question": "The roll return over the period is closest to:",
      "choices": [
        { "key": "A", "text": "−2.4%" },
        { "key": "B", "text": "+1.8%" },
        { "key": "C", "text": "+3.1%" }
      ],
      "answer": "B",
      "solution_md": "Roll return = (F_near − F_far)/F_near … **+1.8%**.\n\nA inverts the sign; C uses the spot price."
    }
  ],

  "recap": {                             // new
    "formulas": [
      { "label": "Total return", "expr": "Price return + Roll return + Collateral return" }
    ],
    "los_revisited": [1, 2, 3]
  }
}
```

### Rules that matter

**`recap.formulas[].expr` must be an expression** — an equation or a short
definitional identity, typically 20–60 characters, always single-line. It is
rendered centred in monospace. If a thing needs a paragraph to say, it is a
`key` block inside a concept unit, not a formula. This one rule fixes the recap
screens outright.

**Every practice item needs three plausible distractors' worth of thought.**
The two wrong choices should each correspond to a specific, nameable error —
the Alternatives worked example "Reverse calculation — and its two distractors"
is the model: adding depreciation to AFFO gives EUR 3.93, adding it on top of
the correct adjustments gives EUR 4.48. `solution_md` should say *why* each
distractor is wrong, because that is where the marks are.

**Aim for 3–4 practice items per reading.** 152 units currently exist as
placeholders; the count per reading does not need to match them.

**`los` mirrors the reading's official outcome statements.** 21 of 48 readings
have none at all today. `verb` is the command word — *describe*, *calculate*,
*compare* — because exam weighting follows it.

## 4. `reading_id`

Put it in the JSON. v1 kept a hardcoded `READINGS` map in `seed_blocks.py`,
which does not scale to 44 more readings and silently mis-targets if a module
number repeats across topics.

The full inventory of 48 reading ids, with topic and title, is in
`readings.tsv` in this directory. Copy the id for the reading being authored.

## 5. Block types available

Unchanged from v1, and all 14 are exercised and verified in the renderer:

`lead`, `prose`, `heading_2`, `heading_3`, `list_bullet`, `list_ordered`,
`formula`, `key`, `trap`, `exam`, `worked`, `table_compare`, `table_signal`,
`table_data`.

Inside a `worked` block, the nested kinds are `prose`, `list`, `step`,
`formula`, `table`. A nested `list` carries `items`, not `text` — v1 emitted
seven of these and the renderer dropped them silently until it was fixed.

Optional on a `worked` block: `intro` (framing before the working) and
`excerpt` + `source_ref` (the vignette as it stands in the reading, rendered
quoted and set apart). Nothing populates `excerpt` yet; it exists for when a
worked example should show the source material it works from.

## 6. Inline markup

`<strong>`, `<em>`, `<b>`, `<i>`, `<code>`, `<sub>`, `<sup>`, `<u>`, `<br>`.

Anything else is escaped and shows literally. Attributes never survive — the
renderer escapes everything and restores only this tag allowlist, so
`<span class=…>` will appear as text.

## 7. What happens after you hand it over

```bash
python3 seed_blocks.py blocks_*.json --emit-sql > seed.sql
```

The generator holds no credentials and only prints SQL. The output is reviewed,
then pasted into the Supabase SQL editor with RLS bypassed — `codex_units` and
`codex_blocks` have SELECT-only policies, so a restricted role cannot write.

Per reading the SQL deletes the existing `concept`, `example`, `practice`,
`recap` and `los` units and rebuilds them from the JSON. That cascades
`codex_unit_progress` for the reading, which is acceptable because the content
being tracked no longer exists.

Unit ids are a deterministic hash of `(topic, module, kind, ordinal)`, so
re-running is idempotent and a corrected file can simply be re-applied.
