-- =====================================================================
-- ATLAS NEXUS // Volatility Dispersion Signal (VIX EQ - VIX)
-- Single-name-vs-index implied vol spread, computed three ways from one
-- underlying function. Regime qualifier on the macro -> rotation ->
-- transmission -> names funnel. Spec: NEXUS_VOL_DISPERSION.md.
--
-- Apply via the Supabase MCP migration flow or `supabase db push`.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Sector tagging source of truth.
-- Checked before build (spec section 5): no GICS classification exists
-- anywhere in the ATLAS data layer today (assets carries only
-- asset_class + free-form metadata). Per the spec's "if no" branch this
-- table becomes the source of truth for sector tagging, and any other
-- module that needs sector should join against it rather than growing
-- its own taxonomy.
--
-- weight is the approximate S&P 500 index weight in percent. Baskets
-- normalise weights internally, so only relative size matters; refresh
-- the numbers occasionally, exactness is not required for a regime
-- signal.
-- ---------------------------------------------------------------------
create table if not exists equity_sector_map (
  ticker            text primary key,
  gics_sector       text not null check (gics_sector in (
    'Technology','Financials','Energy','Health Care',
    'Consumer Discretionary','Consumer Staples','Industrials',
    'Materials','Utilities','Real Estate','Communication Services'
  )),
  weight            numeric not null check (weight > 0),
  is_market_basket  boolean not null default false,
  updated_at        timestamptz not null default now()
);

comment on table equity_sector_map is
  'GICS sector tagging source of truth + vol-dispersion basket membership. '
  'is_market_basket marks the top-SPX-weight names used for the market basket; '
  'every row participates in its sector basket.';

-- BRK.B is deliberately excluded: OCC/vendor symbol conventions for the
-- class-B contract vary and its chain is thin relative to its weight.
insert into equity_sector_map (ticker, gics_sector, weight, is_market_basket) values
  -- Technology
  ('NVDA', 'Technology',             7.5, true),
  ('MSFT', 'Technology',             6.5, true),
  ('AAPL', 'Technology',             6.0, true),
  ('AVGO', 'Technology',             2.4, true),
  ('ORCL', 'Technology',             0.9, true),
  ('AMD',  'Technology',             0.8, true),
  ('CRM',  'Technology',             0.5, false),
  -- Consumer Discretionary
  ('AMZN', 'Consumer Discretionary', 3.9, true),
  ('TSLA', 'Consumer Discretionary', 1.9, true),
  ('HD',   'Consumer Discretionary', 0.8, true),
  ('MCD',  'Consumer Discretionary', 0.4, false),
  ('LOW',  'Consumer Discretionary', 0.3, false),
  -- Communication Services
  ('GOOGL','Communication Services', 4.0, true),
  ('META', 'Communication Services', 2.8, true),
  ('NFLX', 'Communication Services', 0.8, true),
  ('DIS',  'Communication Services', 0.4, false),
  ('TMUS', 'Communication Services', 0.3, false),
  -- Financials
  ('JPM',  'Financials',             1.5, true),
  ('V',    'Financials',             1.1, true),
  ('MA',   'Financials',             0.9, true),
  ('BAC',  'Financials',             0.7, false),
  ('GS',   'Financials',             0.5, false),
  ('WFC',  'Financials',             0.4, false),
  -- Health Care
  ('LLY',  'Health Care',            1.5, true),
  ('UNH',  'Health Care',            1.0, true),
  ('JNJ',  'Health Care',            0.9, true),
  ('ABBV', 'Health Care',            0.6, false),
  ('MRK',  'Health Care',            0.4, false),
  -- Consumer Staples
  ('WMT',  'Consumer Staples',       1.2, true),
  ('COST', 'Consumer Staples',       0.9, true),
  ('PG',   'Consumer Staples',       0.9, true),
  ('KO',   'Consumer Staples',       0.6, false),
  ('PEP',  'Consumer Staples',       0.5, false),
  -- Energy
  ('XOM',  'Energy',                 1.1, true),
  ('CVX',  'Energy',                 0.6, false),
  ('COP',  'Energy',                 0.3, false),
  -- Industrials
  ('GE',   'Industrials',            0.5, false),
  ('CAT',  'Industrials',            0.5, false),
  ('HON',  'Industrials',            0.4, false),
  ('UNP',  'Industrials',            0.3, false),
  -- Materials
  ('LIN',  'Materials',              0.5, false),
  ('SHW',  'Materials',              0.2, false),
  ('FCX',  'Materials',              0.2, false),
  -- Utilities
  ('NEE',  'Utilities',              0.4, false),
  ('SO',   'Utilities',              0.3, false),
  ('DUK',  'Utilities',              0.2, false),
  -- Real Estate
  ('PLD',  'Real Estate',            0.25, false),
  ('AMT',  'Real Estate',            0.2,  false),
  ('EQIX', 'Real Estate',            0.2,  false)
on conflict (ticker) do nothing;

-- ---------------------------------------------------------------------
-- The signal store. One row per (date, basket, sector). Precomputed by
-- the nightly job; the frontend only ever does windowed reads.
--
-- Deviation from the spec DDL: Postgres forbids NULL in primary-key
-- columns, so sector is NOT NULL DEFAULT '' instead of nullable, with a
-- check tying it to basket_type. '' means "not a sector basket".
-- ---------------------------------------------------------------------
create table if not exists vol_dispersion_daily (
  date              date not null,
  basket_type       text not null check (basket_type in ('market','portfolio','sector')),
  sector            text not null default '',  -- GICS label; '' unless basket_type='sector'
  basket_iv         numeric not null,          -- weighted avg 30D ATM IV across basket names
  benchmark_iv      numeric not null,          -- IV of the relevant index/ETF leg
  benchmark_ticker  text not null,             -- e.g. 'SPY', 'XLK' -- traceability
  spread            numeric not null,          -- basket_iv - benchmark_iv
  constituent_count int not null,              -- # names actually priced that day
  created_at        timestamptz default now(),
  primary key (date, basket_type, sector),
  check ((basket_type = 'sector') = (sector <> ''))
);

comment on table vol_dispersion_daily is
  'Daily single-name-vs-index implied vol spread (dispersion proxy). '
  'constituent_count is the degraded-data flag: materially below basket '
  'size means options data was missing/stale for several names that day.';

-- Windowed percentile/z-score reads: latest N rows per basket.
create index if not exists idx_vol_disp_basket_date
  on vol_dispersion_daily (basket_type, sector, date desc);

-- ---------------------------------------------------------------------
-- RLS: frontend reads with the anon key (read-only); the nightly job
-- writes with the service role, which bypasses RLS.
-- ---------------------------------------------------------------------
alter table equity_sector_map enable row level security;
alter table vol_dispersion_daily enable row level security;

drop policy if exists "anon read sector map" on equity_sector_map;
create policy "anon read sector map" on equity_sector_map
  for select using (true);

drop policy if exists "anon read dispersion" on vol_dispersion_daily;
create policy "anon read dispersion" on vol_dispersion_daily
  for select using (true);
