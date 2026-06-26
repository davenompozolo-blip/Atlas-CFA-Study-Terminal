-- =====================================================================
-- ATLAS CODEX // Supabase schema
-- The study layer of ATLAS. Mirrors the portfolio-aware pattern used by
-- Nexus: a priority view computes where to spend effort, here weighted by
-- exam-weight x mastery gap rather than conviction.
--
-- Apply via the Supabase MCP migration flow or `supabase db push`.
-- tenant_id is carried from the start so this ports cleanly into the
-- multi-tenant skeleton without a backfill later. Defaulted for single-user.
-- =====================================================================

-- Optional: semantic search over chunks. Comment out if not using pgvector yet.
create extension if not exists vector;

-- ---------------------------------------------------------------------
-- Reference: the ten L2 topics, carrying the May diagnostic band + weights
-- ---------------------------------------------------------------------
create table if not exists codex_topics (
  id              text primary key,                 -- 'alt','fi','der',...
  name            text not null,
  weight_low      numeric not null,                 -- exam weight band, %
  weight_high     numeric not null,
  band            text not null check (band in ('crit','focus','hold')),
  target_mastery  int  not null default 72,         -- the "clear 70%" line
  sort            int  not null default 0
);

insert into codex_topics (id,name,weight_low,weight_high,band,sort) values
  ('alt','Alternative Investments',5,10,'crit',1),
  ('fi','Fixed Income',10,15,'focus',2),
  ('der','Derivatives',5,10,'focus',3),
  ('corp','Corporate Issuers',5,10,'focus',4),
  ('fsa','Financial Statement Analysis',10,15,'focus',5),
  ('quant','Quantitative Methods',5,10,'focus',6),
  ('eco','Economics',5,10,'hold',7),
  ('eq','Equity Investments',10,15,'hold',8),
  ('pm','Portfolio Management',10,15,'hold',9),
  ('eth','Ethical & Professional Stds',10,15,'hold',10)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- Documents: one row per ingested note PDF
-- ---------------------------------------------------------------------
create table if not exists codex_documents (
  id              text primary key,                 -- sha1(topic||filename)[:16]
  tenant_id       uuid not null default '00000000-0000-0000-0000-000000000000',
  topic_id        text not null references codex_topics(id),
  reading         text not null,                    -- 'Hedge Fund Strategies'
  lm              int,                              -- learning module number
  source_file     text not null,                    -- 'Alternatives/CFA_L2_...pdf'
  storage_path    text,                             -- Supabase Storage object path
  pages           int,
  los_count       int default 0,
  section_count   int default 0,
  chunk_count     int default 0,
  content_hash    text not null,                    -- sha256 of raw bytes; idempotency key
  ingest_method   text default 'recognizer',        -- 'recognizer' | 'claude_fallback'
  ingested_at     timestamptz not null default now(),
  unique (tenant_id, content_hash)
);
create index if not exists idx_codex_docs_topic on codex_documents(tenant_id, topic_id);

-- ---------------------------------------------------------------------
-- Learning outcomes: the curriculum spine. One row per LOS per reading.
-- ---------------------------------------------------------------------
create table if not exists codex_los (
  id              text primary key,
  tenant_id       uuid not null default '00000000-0000-0000-0000-000000000000',
  doc_id          text not null references codex_documents(id) on delete cascade,
  topic_id        text not null references codex_topics(id),
  los_num         int not null,
  outcome         text not null,
  command_verb    text,                             -- 'calculate','explain',... (drives difficulty)
  source          text default 'recognizer'         -- 'recognizer' | 'claude_fallback'
);
create index if not exists idx_codex_los_doc on codex_los(doc_id);

-- ---------------------------------------------------------------------
-- Chunks: the study units. Subsection-level, with example/formula flags.
-- ---------------------------------------------------------------------
create table if not exists codex_chunks (
  id              text primary key,
  tenant_id       uuid not null default '00000000-0000-0000-0000-000000000000',
  doc_id          text not null references codex_documents(id) on delete cascade,
  topic_id        text not null references codex_topics(id),
  lm              int,
  ord             int not null,                     -- order within the document
  section_no      int,
  section_title   text,
  section_los     text,                             -- raw 'LOS 1 & 2' annotation if present
  sub_no          text,                             -- '3.1'
  heading         text,
  body            text not null,
  char_len        int,
  is_example      boolean default false,            -- worked example -> drill cards
  is_formula      boolean default false,            -- EXACT/navy box  -> formula sheet
  los_num         int,                              -- nullable link to codex_los.los_num
  embedding       vector(1536)                      -- optional; for Ask Codex
);
create index if not exists idx_codex_chunks_doc on codex_chunks(doc_id, ord);
create index if not exists idx_codex_chunks_topic on codex_chunks(tenant_id, topic_id);
create index if not exists idx_codex_chunks_formula on codex_chunks(tenant_id, topic_id) where is_formula;
create index if not exists idx_codex_chunks_example on codex_chunks(tenant_id, topic_id) where is_example;
-- create index on codex_chunks using ivfflat (embedding vector_cosine_ops) with (lists=100);

-- ---------------------------------------------------------------------
-- Progress + spaced repetition (single user now, tenant-ready)
-- ---------------------------------------------------------------------
create table if not exists codex_progress (
  id              bigserial primary key,
  tenant_id       uuid not null default '00000000-0000-0000-0000-000000000000',
  los_id          text not null references codex_los(id) on delete cascade,
  mastery         int  default 0 check (mastery between 0 and 100),
  status          text default 'untouched' check (status in ('untouched','learning','review','solid')),
  ease            numeric default 2.5,              -- SM-2 ease factor
  interval_days   int default 0,
  reps            int default 0,
  last_reviewed   timestamptz,
  next_due        date,
  unique (tenant_id, los_id)
);
create index if not exists idx_codex_progress_due on codex_progress(tenant_id, next_due);

create table if not exists codex_reviews (
  id              bigserial primary key,
  tenant_id       uuid not null default '00000000-0000-0000-0000-000000000000',
  los_id          text references codex_los(id) on delete cascade,
  chunk_id        text references codex_chunks(id) on delete set null,
  rating          int check (rating between 0 and 5),   -- recall quality
  reviewed_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- PRIORITY VIEW: the academic analogue of vw_nexus_holdings.
-- Focus index = weight_mid x gap-to-target. Drives the Codex home board.
-- ---------------------------------------------------------------------
create or replace view vw_codex_priority as
with topic_mastery as (
  select t.id as topic_id, t.name, t.band, t.weight_low, t.weight_high, t.target_mastery,
         (t.weight_low + t.weight_high) / 2.0 as weight_mid,
         coalesce(avg(p.mastery), 0)::numeric as avg_mastery,
         count(l.id) as los_total,
         count(*) filter (where p.status = 'solid') as los_solid
  from codex_topics t
  left join codex_los l on l.topic_id = t.id
  left join codex_progress p on p.los_id = l.id
  group by t.id
)
select topic_id, name, band, weight_low, weight_high, target_mastery,
       weight_mid, round(avg_mastery,1) as avg_mastery, los_total, los_solid,
       greatest(target_mastery - avg_mastery, 0) as gap,
       round(weight_mid * greatest(target_mastery - avg_mastery, 0), 1) as focus_index
from topic_mastery
order by focus_index desc, weight_mid desc;
