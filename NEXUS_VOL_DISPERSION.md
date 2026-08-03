# Nexus Module — Volatility Dispersion Signal (VIX EQ − VIX)

Implementation notes for the dispersion-regime qualifier. The spec this
implements is the "Volatility Dispersion Signal" handoff (Hlobo → CC). This
file records what was built, the decisions taken where reality diverged from
the spec, and how the Nexus page wires it in.

---

## What was built

| Piece | File | Status |
|---|---|---|
| Schema + sector map seed | `db/vol_dispersion_schema.sql` | **Applied** to the Supabase project as migration `vol_dispersion_signal` |
| Ingestion job (shared IV function, 3 baskets) | `ingest/vol_dispersion.py` | Built; offline self-test green (`--self-test`) |
| Nightly cron | `.github/workflows/vol-dispersion-nightly.yml` | Built; needs repo secrets (below) |
| Frontend read layer (badge, sector cells, ledger flag) | `web/vol-dispersion.js` | Built as a portable preact module |

One ingestion job, one table, three read paths — as specced. The spread is
precomputed and stored; the frontend only ever does windowed reads.

## Decisions and deviations (read before wiring)

**1. Sector classification source (spec §5) — resolved: none existed.**
Checked the ATLAS data layer before building: no GICS/sector/industry column
exists on any table (`assets` carries only `asset_class` + free-form jsonb
metadata). Per the spec's "if no" branch, this module now owns sector tagging
via `equity_sector_map` (ticker → GICS sector, ~49 large-caps seeded). Any
other module that needs sector — Equity Research, Rotation Map cells — should
**join against this table**, not grow a second taxonomy.

**2. Benchmark leg is SPY, not SPX/VIX.** Alpha Vantage options coverage is
listed equities/ETFs only; there is no SPX index-option or VIX endpoint. The
`market` and `portfolio` benchmark leg is therefore SPY 30D ATM IV computed
with the *identical* interpolation function as the basket legs. This is
arguably cleaner than the spec's letter: mixing a CBOE VIX print (variance-swap
methodology) into a spread whose other leg is our own ATM interpolation would
put two methodologies inside one number. `benchmark_ticker` records `'SPY'`
for traceability. Sector legs use the SPDR ETFs exactly as specced (Option B).

**3. Schema deviation: `sector` is `not null default ''`** instead of
nullable, because Postgres forbids NULL in primary-key columns (the spec DDL
as written would not apply). A check constraint ties `sector <> ''` to
`basket_type = 'sector'`. Read `''` as "not a sector basket".

**4. Basket weights are stored approximations.** `equity_sector_map.weight`
holds approximate S&P 500 weights; baskets renormalise over the names that
actually priced each day, so only relative size matters. Historical
point-in-time index weights aren't available from this data source, so the
backfill applies current weights throughout — acceptable for a regime signal,
worth remembering if anyone tries to trade off the level. BRK.B is excluded
(contract-symbol convention ambiguity + thin chain relative to weight).

**5. Repo placement.** The Nexus surfaces (Rotation Map, Opportunities
Ledger) live in the main ATLAS repo, not this one; this session was scoped
here. Everything is built portable: the schema is already applied to the
shared Supabase project, the ingestion job and cron are self-contained, and
`web/vol-dispersion.js` imports only preact. Porting = copying the web module
into the ATLAS repo and mounting the three entry points. Note that the Codex
CLAUDE.md deliberately keeps market-data pipelines out of this repo — treat
this module's presence here as staging, and move `ingest/vol_dispersion.py` +
the workflow with it when it lands in ATLAS proper.

## The shared IV function (spec §7)

`iv_30d_atm(chain, asof)` in `ingest/vol_dispersion.py`:

1. Bucket the chain by expiry, keep 5–120 DTE.
2. Per expiry: estimate the forward from put–call parity at the strike where
   |C−P| is smallest, then linearly interpolate call-side and put-side IV in
   strike at that forward and average the two legs. No "closest strike wins".
3. Take the expiries bracketing 30 DTE and interpolate **in total variance**
   (σ²·t) to exactly 30 days; fall back to the single nearest expiry when only
   one side of 30D prices.
4. Reject IVs outside (0.01, 4.0).

Verified offline with synthetic chains (`python ingest/vol_dispersion.py
--self-test`): flat-surface recovery, variance-time blend, single-expiry
fallback, garbage rejection. Live verification against `HISTORICAL_OPTIONS`
still pending — the endpoint is premium-gated and this session's key doesn't
carry it. **First manual run should be `--date <yesterday> --dry-run` to
confirm the payload parse before trusting the cron.**

## Degraded data

`constituent_count` is stored on every row. The job refuses to write a row at
all below `max(2, 40%)` of basket size; the frontend additionally shows a
`◈ degraded` marker whenever the latest count is under 60% of the basket's
median count in the window. A thin sample is surfaced, never silently averaged.

## Ops

GitHub repo secrets required by the workflow:

- `ALPHAVANTAGE_API_KEY` — must be a premium key (HISTORICAL_OPTIONS)
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`

Cron runs 01:30 UTC Tue–Sat (after each US session). Backfill: trigger the
workflow manually with `backfill_days` (e.g. 365), or run locally. Backfill is
resumable — already-stored `(date, basket, sector)` rows are skipped — so it
can be run in slices to respect API rate limits (`AV_RPM`, default 70/min).
Full-year backfill is ~15k chain pulls (49 names + 12 ETFs × ~250 sessions);
at 70 rpm that's ~3.5h of straight API time, so expect to slice it.

## Frontend wiring (spec §9)

```js
import {
  fetchDispersionSeries, dispersionSummary, sectorReading,
  DispersionBadge, LedgerReliabilityFlag,
} from "./vol-dispersion.js";

// Rotation Map header — market basket, colors how the page is read
const marketRows = await fetchDispersionSeries(sb, "market");
h(DispersionBadge, { rows: marketRows })

// Rotation Map sector cells — each sector vs its OWN trailing window
const techRows = await fetchDispersionSeries(sb, "sector", { sector: "Technology" });
const cell = sectorReading(techRows); // { spread, pct, regime, degraded, ... }

// Opportunities Ledger — renders only when portfolio regime is compressed
const pfRows = await fetchDispersionSeries(sb, "portfolio");
h(LedgerReliabilityFlag, { rows: pfRows })
```

Regime mapping: latest spread's percentile vs the basket's own trailing ~1yr
window — ≥70th pct `Wide`, ≤30th `Compressed`, else `Neutral`. Thresholds are
exported constants (`WIDE_PCT`, `COMPRESSED_PCT`) in one place.

v1 Ledger treatment is **display-only** by design; reweighting the
isolated-merit vs portfolio-fit scoring legs off this signal is deferred to v2
until the signal has a track record.
