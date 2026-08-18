# Codex Home — spec v1.0

**From:** the Supabase/spec seat · **To:** CC (frontend seat)
**Date:** 17 August 2026 · **Mockup:** `codex_home_v2.html`
**Replaces:** the current Deficit Board home view

---

## 1. Why this replaces the Deficit Board

The current home page shows ten topics at 0% mastery with an identical `900 fi` focus
index against each, and an average mastery of 0%. It is technically accurate and tells
the user nothing — every row looks the same, so nothing is actionable, and the one figure
that draws the eye is a zero.

There is now real data behind it: 310 logged attempts across two topics, 29 concepts with
hit rates, three topics with a full corpus. The home page should answer three questions in
the first five seconds:

1. How long have I got, and am I on track?
2. What is worth doing right now?
3. Where am I actually weak?

Everything else is secondary.

---

## 2. Structure

Five regions, top to bottom. The mockup implements all of them.

### 2.1 Countdown card

Days to 19 November, rendered large with a cyan-to-teal gradient on the numeral. Beneath
it, two supporting lines that make the number concrete rather than abstract — weekends
remaining and sessions at the user's actual cadence. Then a progress track showing topics
built against a target marker.

Compute days from `now()` against the exam date. Do not hardcode.

### 2.2 Today

Three items maximum, generated from live state. The mockup shows the three that are
currently true, and each maps to a query:

| Item | Source |
|---|---|
| "N concepts never answered correctly" | `codex_concept_stats` where `lt_hits = 0` |
| "Topic untouched for N days" | `max(attempted_at)` per topic |
| "Module ledger incomplete" | gaps in `codex_attempts.q` per module |

Severity drives the dot colour: red for never-answered-correctly, amber for decay, cyan
for informational. If fewer than three conditions are true, show fewer items — do not pad.

### 2.3 Stat strip

Five cells: questions logged, overall accuracy, concepts tracked, never-right count,
corpus size. All from `codex_attempts`, `codex_concept_stats` and `codex_figures`.

### 2.4 Coverage

One row per topic, sorted by exam weight descending. Each row carries a name, exam weight,
an accuracy bar, the percentage, a state label and the attempt count.

Four states, and the distinction matters because they need different responses:

| State | Meaning | Bar |
|---|---|---|
| `REVIEWED` | has attempts, recent | green |
| `STALE` | has attempts, none in 14 days | amber |
| `BUILT · NO DATA` | corpus exists, no attempts logged | cyan |
| `NOT BUILT` | no corpus | faint, row at 45% opacity |

A topic with no data is not the same as a topic scoring zero. The current Deficit Board
conflates them, which is why everything reads 0%.

### 2.5 Activity and relearn queue

Right column. A thirteen-week activity heatmap keyed on `attempted_at` and
`codex_unit_progress`, a thirty-day mastery sparkline, and the relearn queue — concepts
where `remediation = 'RELEARN'`, ordered by hit rate then attempts, showing the same
`hits/attempts` fraction the report card uses.

One call to action at the bottom, routing to the review queue.

---

## 3. Design notes

Same ATLAS tokens, no new colours. Three things differ from the existing pages:

**Ambient gradient.** Two fixed radial gradients at very low opacity behind the content,
cyan top-left and violet top-right. It is what stops the page reading as a flat table.
Keep it under `pointer-events: none` and behind a positioned wrapper.

**The countdown numeral uses a gradient fill** via `background-clip: text`. It is the only
element on the page that does, deliberately — it is the one number that should draw the
eye first.

**Rows lift on hover** with a 2px translate and a border-colour change. Subtle, and it is
what makes the coverage list feel like a control surface rather than a report.

Honour `prefers-reduced-motion`; the mockup disables all transitions under it.

---

## 4. Data contract

```
codex_attempts        topic_id, module, q, is_correct, attempted_at
codex_concept_stats   concept_tag, label, topic_id, lt_hits, lt_attempts,
                      hit_rate, remediation
codex_topics          id, name, weight_low, weight_high
codex_figures         topic_id                      (corpus count)
codex_units           topic_id                      (built vs not built)
codex_unit_progress   unit_id, status, updated_at   (activity heatmap)
```

Everything on this page is derivable from those six. No new tables.

---

## 5. Acceptance

1. Countdown computes from `now()`, not a constant.
2. Topics with no attempts show `BUILT · NO DATA` or `NOT BUILT`, never 0%.
3. Coverage sorts by exam weight descending, with unbuilt topics dimmed.
4. Today shows at most three items, generated from live conditions, no padding.
5. Relearn queue matches the report card's ordering and fractions exactly.
6. Heatmap covers thirteen weeks and keys on real activity dates.
7. 380px: hero and split stack to one column, no horizontal overflow.
8. `prefers-reduced-motion` disables the hover translate and all transitions.
9. Ambient gradient does not intercept pointer events.

---

## 6. Order

1. Coverage list and stat strip — the load-bearing content.
2. Countdown card.
3. Today panel.
4. Heatmap, sparkline, relearn queue.
5. Ambient gradient and hover states last; they are polish, not function.

The mockup is a single self-contained HTML file. Lift the CSS wholesale rather than
reimplementing — the token usage and the gradient setup are fiddlier than they look.
