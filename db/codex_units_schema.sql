-- codex_units: typed pedagogical units (los / concept / example / practice / recap)
-- codex_unit_progress: per-candidate unit completion state
-- vw_codex_reading_progress: rollup view for orientation chips and scheduler
-- Apply via Supabase dashboard or MCP apply_migration.

create table if not exists codex_units (
  id             text primary key,
  tenant_id      uuid not null default '00000000-0000-0000-0000-000000000000',
  reading_id     text not null references codex_documents(id) on delete cascade,
  topic_id       text not null references codex_topics(id),
  ord            int  not null,
  kind           text not null check (kind in ('los','concept','example','practice','recap')),
  title          text,
  est_minutes    int  default 6,
  los_num        int,
  payload        jsonb not null,
  source_chunk_ids text[],
  created_at     timestamptz not null default now(),
  unique (reading_id, ord)
);
create index if not exists idx_codex_units_reading on codex_units(reading_id, ord);

create table if not exists codex_unit_progress (
  id             bigserial primary key,
  tenant_id      uuid not null default '00000000-0000-0000-0000-000000000000',
  unit_id        text not null references codex_units(id) on delete cascade,
  status         text default 'untouched' check (status in ('untouched','viewed','done')),
  confidence     text check (confidence in ('got','shaky','review')),
  practice_result text check (practice_result in ('correct','wrong')),
  time_spent_s   int default 0,
  last_viewed    timestamptz,
  unique (tenant_id, unit_id)
);

create or replace view vw_codex_reading_progress as
select u.reading_id, u.topic_id,
       count(*) as units_total,
       count(*) filter (where p.status = 'done') as units_done,
       round(100.0 * count(*) filter (where p.status='done') / nullif(count(*),0), 0) as pct,
       coalesce(sum(u.est_minutes),0) as est_minutes_total,
       coalesce(sum(u.est_minutes) filter (where p.status <> 'done'),0) as est_minutes_left
from codex_units u
left join codex_unit_progress p on p.unit_id = u.id
group by u.reading_id, u.topic_id;

alter table codex_units enable row level security;
create policy "anon read units"  on codex_units for select using (true);

alter table codex_unit_progress enable row level security;
create policy "anon read unit progress"   on codex_unit_progress for select using (true);
create policy "anon insert unit progress" on codex_unit_progress for insert with check (true);
create policy "anon update unit progress" on codex_unit_progress for update using (true);
