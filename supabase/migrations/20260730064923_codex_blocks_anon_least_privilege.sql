-- codex_blocks was created without RLS and inherited default public schema
-- grants, leaving anon with INSERT/UPDATE/DELETE/TRUNCATE on it while every
-- other codex_* table is RLS-on with SELECT only. This brings it into line.
--
-- codex_review_queue deliberately gets no anon grant — it is an internal QA
-- view, not reader-facing.
--
-- ALREADY APPLIED to the remote. Committed so local and remote histories agree.

revoke all on table codex_blocks from anon, authenticated;

alter table codex_blocks enable row level security;

drop policy if exists "anon read blocks" on codex_blocks;
create policy "anon read blocks"
  on codex_blocks for select
  to anon
  using (true);

grant select on table codex_blocks to anon;
grant select on table codex_blocks to authenticated;

revoke all on table codex_unit_outline from anon, authenticated;
revoke all on table codex_review_queue from anon, authenticated;
grant select on table codex_unit_outline to anon, authenticated;
