-- codex_rls_grants.sql — least-privilege access for the browser `anon` role.
--
-- Context: the anon key is public (served to every visitor by /api/config).
-- Supabase's default grants gave anon INSERT/UPDATE/DELETE/TRUNCATE on every
-- table in `public`, and RLS was disabled on the codex reference tables — so
-- any visitor could have wiped the study corpus.
--
-- This restricts anon to:
--   * read-only on reference content (topics, documents, LOS, chunks, units)
--   * read + append/update on progress tables (never delete, never truncate)
--
-- Deliberately NOT applied to the trading/portfolio tables that share this
-- database (portfolios, positions, transactions, account_snapshots,
-- price_history, organizations, org_members, vol_dispersion_daily): other
-- applications may depend on those grants, and silently revoking them could
-- break a service outside this repo. Tighten those separately, with the
-- owning app in hand.
--
-- Ingest scripts authenticate with SUPABASE_SERVICE_ROLE_KEY, which bypasses
-- RLS entirely, so none of this affects codex_ingest.py / codex_units_gen.py.
--
-- Apply via Supabase dashboard or MCP apply_migration.

-- ── 1. Strip the blanket grants ──────────────────────────────────────────────
revoke all on codex_topics, codex_documents, codex_los, codex_chunks, codex_units,
               codex_progress, codex_reviews, codex_drill_progress, codex_unit_progress,
               vw_codex_priority, vw_codex_reading_progress
  from anon;

-- ── 2. Reference content: read-only ──────────────────────────────────────────
grant select on codex_topics, codex_documents, codex_los, codex_chunks, codex_units,
                vw_codex_priority, vw_codex_reading_progress
  to anon;

-- ── 3. Progress tables: read + append/update only ────────────────────────────
grant select, insert, update on codex_progress, codex_reviews,
                                codex_drill_progress, codex_unit_progress
  to anon;

-- codex_reviews / codex_unit_progress use bigserial pks; inserts need the sequence
grant usage, select on all sequences in schema public to anon;

-- ── 4. Enable RLS where it was still off ─────────────────────────────────────
alter table codex_topics    enable row level security;
alter table codex_documents enable row level security;
alter table codex_los       enable row level security;
alter table codex_chunks    enable row level security;
alter table codex_progress  enable row level security;
alter table codex_reviews   enable row level security;

-- ── 5. Read-only policies for reference content ──────────────────────────────
drop policy if exists "anon read topics"    on codex_topics;
drop policy if exists "anon read documents" on codex_documents;
drop policy if exists "anon read los"       on codex_los;
drop policy if exists "anon read chunks"    on codex_chunks;

create policy "anon read topics"    on codex_topics    for select to anon using (true);
create policy "anon read documents" on codex_documents for select to anon using (true);
create policy "anon read los"       on codex_los       for select to anon using (true);
create policy "anon read chunks"    on codex_chunks    for select to anon using (true);

-- ── 6. Read + write policies for progress tracking ───────────────────────────
drop policy if exists "anon read progress"   on codex_progress;
drop policy if exists "anon insert progress" on codex_progress;
drop policy if exists "anon update progress" on codex_progress;
drop policy if exists "anon read reviews"    on codex_reviews;
drop policy if exists "anon insert reviews"  on codex_reviews;

create policy "anon read progress"   on codex_progress for select to anon using (true);
create policy "anon insert progress" on codex_progress for insert to anon with check (true);
create policy "anon update progress" on codex_progress for update to anon using (true) with check (true);

create policy "anon read reviews"    on codex_reviews  for select to anon using (true);
create policy "anon insert reviews"  on codex_reviews  for insert to anon with check (true);
