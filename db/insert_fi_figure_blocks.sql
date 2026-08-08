-- ATLAS Codex: point the Fixed Income readings at their figures.
--
-- load_fi_figures.sql puts 21 rows in codex_figures. Nothing references them:
-- Fixed Income has no `figure` blocks at all, so the artwork sits in the table
-- and no reading shows it. This adds the 26 blocks that do the referencing —
-- 21 figures, five of which serve two units each.
--
-- Placement follows §3 of the FI figures addendum, with one correction: the
-- addendum's target for FI.LM2.02 is "Calibrating the Tree", and the unit is
-- actually titled "Calibrating the Tree to the Term Structure". All 26 targets
-- were resolved against the database before this was written.
--
-- Idempotent: a figure already referenced by its unit is skipped, so re-running
-- inserts nothing. Paste into the Supabase SQL editor and run.

begin;

with placement(fig_id, lm, unit_title) as (values
  ('FI.LM1.01',1,'Spot Rates, Forward Rates, and the Forward Rate Model'),
  ('FI.LM1.02',1,'Spot Rates, Forward Rates, and the Forward Rate Model'),
  ('FI.LM1.03',1,'Riding the Yield Curve'),
  ('FI.LM1.04',1,'Spreads as Gauges of Credit and Liquidity Risk'),
  ('FI.LM1.05',1,'Traditional Theories of the Term Structure'),
  ('FI.LM1.06',1,'Yield Curve Factor Models'),
  ('FI.LM2.01',2,'The Binomial Interest Rate Tree'),
  ('FI.LM2.02',2,'Calibrating the Tree to the Term Structure'),
  ('FI.LM2.02',2,'Backward Induction'),
  ('FI.LM2.03',2,'Term Structure Models'),
  ('FI.LM2.04',2,'Pathwise Valuation'),
  ('FI.LM2.04',2,'Monte Carlo Simulation'),
  ('FI.LM3.01',3,'The Decomposition Principle'),
  ('FI.LM3.02',3,'Effective Duration'),
  ('FI.LM3.03',3,'How Interest Rate Volatility Affects Value'),
  ('FI.LM3.03',3,'How the Yield Curve Affects Value'),
  ('FI.LM3.04',3,'Option-Adjusted Spread'),
  ('FI.LM3.05',3,'One-Sided and Key Rate Durations'),
  ('FI.LM4.01',4,'The Three Inputs to Credit Risk'),
  ('FI.LM4.01',4,'The Credit Valuation Adjustment'),
  ('FI.LM4.02',4,'Structural and Reduced-Form Models'),
  ('FI.LM4.03',4,'The Term Structure of Credit Spreads'),
  ('FI.LM5.01',5,'Definitions and Contract Parameters'),
  ('FI.LM5.02',5,'Standard Coupons and the Upfront Premium'),
  ('FI.LM5.02',5,'Valuation Changes During the Contract''s Life'),
  ('FI.LM5.03',5,'Applications')
),
target as (
  select p.fig_id, u.id as unit_id,
         -- a unit taking two figures needs two distinct ords, in fig_id order
         row_number() over (partition by u.id order by p.fig_id) as seq,
         count(*)      over (partition by u.id)                  as per_unit
  from placement p
  join codex_documents d on d.topic_id = 'fi' and d.lm = p.lm
  join codex_units     u on u.reading_id = d.id and u.title = p.unit_title
  -- only where the figure exists and the unit does not already reference it
  where exists (select 1 from codex_figures f
                where f.fig_id = p.fig_id and f.origin = 'generated')
    and not exists (select 1 from codex_blocks b
                    where b.unit_id = u.id
                      and b.block_type = 'figure'
                      and b.payload->>'fig_id' = p.fig_id)
)
insert into codex_blocks (unit_id, ord, block_type, payload)
select
  t.unit_id,
  -- "At the head of the unit it serves", without renumbering anything that is
  -- already there. codex_blocks has UNIQUE (unit_id, ord) and no lower bound on
  -- ord, so counting down from the unit's current first block is the
  -- non-destructive way in: nothing existing is touched, and undoing this is a
  -- delete rather than a re-sort. The reader orders by ord ascending, so the
  -- figure lands before the prose that explains it.
  coalesce((select min(b.ord) from codex_blocks b where b.unit_id = t.unit_id), 0)
    - t.per_unit + t.seq - 1,
  'figure',
  jsonb_build_object('fig_id', t.fig_id)
from target t;

commit;

-- verify: expect 26 blocks, 21 distinct figures, 0 unresolved
select
  (select count(*) from codex_blocks b
     join codex_units u on u.id = b.unit_id
     join codex_documents d on d.id = u.reading_id
   where d.topic_id = 'fi' and b.block_type = 'figure')            as fi_figure_blocks,
  (select count(distinct b.payload->>'fig_id') from codex_blocks b
     join codex_units u on u.id = b.unit_id
     join codex_documents d on d.id = u.reading_id
   where d.topic_id = 'fi' and b.block_type = 'figure')            as distinct_figures,
  (select count(*) from codex_blocks b
     join codex_units u on u.id = b.unit_id
     join codex_documents d on d.id = u.reading_id
     left join codex_figures f on f.fig_id = b.payload->>'fig_id'
   where d.topic_id = 'fi' and b.block_type = 'figure'
     and f.fig_id is null)                                          as unresolved;
