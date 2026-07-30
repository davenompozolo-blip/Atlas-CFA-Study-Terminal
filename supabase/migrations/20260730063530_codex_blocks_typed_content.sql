-- ATLAS Codex — typed content blocks
--
-- Blocks hang off codex_units(id) [text]. They replace the prose_md blob for
-- 'concept' units while leaving the existing unit-level typing
-- (concept/example/practice/recap/los) intact. prose_md is retained as a
-- fallback until blocks are verified, so units can migrate one at a time
-- without breaking the reader.
--
-- ALREADY APPLIED to the remote. Committed so local and remote histories agree.

do $$ begin
  create type codex_block_type as enum (
    'lead','prose','heading_2','heading_3',
    'list_bullet','list_ordered',
    'formula','key','trap','exam',
    'worked',
    'table_compare','table_signal','table_data'
  );
exception when duplicate_object then null; end $$;

create table if not exists codex_blocks (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null default '00000000-0000-0000-0000-000000000000'::uuid,
  unit_id     text not null references codex_units(id) on delete cascade,
  ord         int  not null,
  block_type  codex_block_type not null,
  payload     jsonb not null,

  source_ref  text,
  confidence  numeric(3,2),
  reviewed_at timestamptz,
  reviewed_by text,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint codex_blocks_ord_unique unique (unit_id, ord),
  constraint codex_blocks_confidence_range
    check (confidence is null or (confidence >= 0 and confidence <= 1))
);

create index if not exists codex_blocks_unit_ord_idx on codex_blocks (unit_id, ord);
create index if not exists codex_blocks_review_idx on codex_blocks (block_type, confidence)
  where reviewed_at is null;

alter table codex_blocks drop constraint if exists codex_blocks_payload_shape;
alter table codex_blocks add constraint codex_blocks_payload_shape check (
  case block_type
    when 'lead'         then payload ? 'text'
    when 'prose'        then payload ? 'text'
    when 'heading_2'    then payload ? 'text'
    when 'heading_3'    then payload ? 'text'
    when 'list_bullet'  then jsonb_typeof(payload->'items') = 'array'
    when 'list_ordered' then jsonb_typeof(payload->'items') = 'array'
    when 'formula'      then payload ? 'expr'
    when 'key'          then jsonb_typeof(payload->'paras') = 'array'
    when 'trap'         then jsonb_typeof(payload->'paras') = 'array'
    when 'exam'         then jsonb_typeof(payload->'paras') = 'array'
    when 'worked'       then payload ? 'title' and jsonb_typeof(payload->'blocks') = 'array'
    else jsonb_typeof(payload->'rows') = 'array'
  end
);

create or replace function codex_blocks_touch() returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

drop trigger if exists codex_blocks_touch_trg on codex_blocks;
create trigger codex_blocks_touch_trg
  before update on codex_blocks
  for each row execute function codex_blocks_touch();

-- Drives the in-unit rail. Built from content so navigation cannot drift.
create or replace view codex_unit_outline as
select b.unit_id, b.ord, b.block_type, b.payload->>'text' as heading
from codex_blocks b
where b.block_type in ('heading_2','heading_3');

create or replace view codex_review_queue as
select b.id, b.unit_id, b.ord, b.block_type, b.confidence,
       left(coalesce(b.payload->>'text', b.payload->>'title', b.payload->>'expr',''),120) as preview
from codex_blocks b
where b.reviewed_at is null
  and (b.confidence < 0.75 or b.block_type in ('key','trap','exam'))
order by
  case b.block_type when 'trap' then 0 when 'key' then 1 when 'exam' then 2 else 3 end,
  b.confidence nulls last;
