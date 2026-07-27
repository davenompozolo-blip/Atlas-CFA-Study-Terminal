-- codex_gen_units.sql — SQL port of ingest/codex_units_gen.py build_units().
--
-- Why this exists: the Python generator is the primary tool, but it needs
-- direct HTTPS access to the Supabase project. In environments where only a
-- SQL channel is available, these functions produce byte-compatible output.
--
-- Compatibility with the Python generator is deliberate:
--   * unit ids use the same scheme  -> substr(sha1('unit:<reading_id>:<ord>'), 1, 16)
--   * unit ordering, est_minutes and payload shapes match build_units()
--   * practice items are emitted as stubs with "_stub": true
-- So a later `codex_units_gen.py --generate-practice` upserts over these rows
-- in place (it keys on id, and --replace deletes by reading_id).
--
-- Usage:
--   select codex_gen_units('<doc_id>');            -- one reading
--   select sum(codex_gen_units(id)) from codex_documents;  -- all readings
--
-- Requires the pgcrypto extension (present in Supabase as extensions.digest).

-- ── concept flush helper (mirrors flush_concept + _concept_payload) ──────────
create or replace function codex__flush_concept(
  p_doc_id text, p_topic text, p_ord int, p_ids text[]
) returns void
language plpgsql as $$
declare
  v_title text; v_n int; v_prose text; v_formulas jsonb;
begin
  v_n := array_length(p_ids, 1);
  if v_n is null or v_n = 0 then return; end if;

  select coalesce(nullif(ch.section_title,''), nullif(ch.heading,''), 'Concept')
    into v_title
    from codex_chunks ch where ch.id = p_ids[1];

  select string_agg(
           case when coalesce(ch.heading,'') <> ''
                then '**'||ch.heading||E'\n\n'||coalesce(ch.body,'')
                else coalesce(ch.body,'') end,
           E'\n\n' order by array_position(p_ids, ch.id))
    into v_prose
    from codex_chunks ch
   where ch.id = any(p_ids) and not ch.is_formula;

  select coalesce(jsonb_agg(
           jsonb_build_object('label', coalesce(nullif(ch.heading,''),'Formula'),
                              'expr', coalesce(ch.body,''), 'where','')
           order by array_position(p_ids, ch.id)), '[]'::jsonb)
    into v_formulas
    from codex_chunks ch
   where ch.id = any(p_ids) and ch.is_formula;

  insert into codex_units(id, tenant_id, reading_id, topic_id, ord, kind, title,
                          est_minutes, los_num, payload, source_chunk_ids)
  values (substr(encode(extensions.digest('unit:'||p_doc_id||':'||p_ord,'sha1'),'hex'),1,16),
          '00000000-0000-0000-0000-000000000000', p_doc_id, p_topic, p_ord, 'concept',
          left(v_title,120), greatest(4, least(12, v_n * 3)), null,
          jsonb_build_object('prose_md', coalesce(v_prose,''),
                             'formulas', v_formulas,
                             'illustration', null,
                             'key_terms', '[]'::jsonb),
          p_ids);
end $$;

-- ── main generator ───────────────────────────────────────────────────────────
create or replace function codex_gen_units(p_doc_id text) returns int
language plpgsql as $$
declare
  v_topic text; v_ord int := 0; v_next_doc text; v_los_n int; v_made int := 0;
  c record; l record;
  buf_ids text[] := '{}'; buf_prev_sec text;
  v_verb text; v_body text; v_heading text; v_marked text;
  v_parts text[]; v_lines text[]; v_steps jsonb;
  v_prompt text; v_answer text;
begin
  select topic_id into v_topic from codex_documents where id = p_doc_id;
  if v_topic is null then return 0; end if;

  select count(*) into v_los_n from codex_los where doc_id = p_doc_id;

  -- mirrors get_next_reading_id (any other doc in same topic); ordered for determinism
  select id into v_next_doc from codex_documents
   where topic_id = v_topic and id <> p_doc_id order by id limit 1;

  delete from codex_units where reading_id = p_doc_id;

  -- 1. LOS opener
  if v_los_n > 0 then
    insert into codex_units(id, tenant_id, reading_id, topic_id, ord, kind, title,
                            est_minutes, los_num, payload, source_chunk_ids)
    select substr(encode(extensions.digest('unit:'||p_doc_id||':'||v_ord, 'sha1'),'hex'),1,16),
           '00000000-0000-0000-0000-000000000000', p_doc_id, v_topic, v_ord, 'los',
           'Learning Outcomes', 2, null,
           jsonb_build_object('outcomes', coalesce(jsonb_agg(
             jsonb_build_object('num', x.los_num, 'text', x.outcome, 'verb', x.command_verb)
             order by x.los_num), '[]'::jsonb)),
           '{}'::text[]
      from (select los_num, outcome, command_verb from codex_los where doc_id = p_doc_id) x;
    v_ord := v_ord + 1; v_made := v_made + 1;
  end if;

  -- 2. Concept / example units
  for c in select * from codex_chunks where doc_id = p_doc_id order by ord loop
    if c.is_example then
      if array_length(buf_ids,1) >= 1 then
        perform codex__flush_concept(p_doc_id, v_topic, v_ord, buf_ids);
        v_ord := v_ord + 1; v_made := v_made + 1;
        buf_ids := '{}'; buf_prev_sec := null;
      end if;

      v_body := coalesce(c.body,''); v_heading := coalesce(c.heading,'');
      -- equivalent to Python re.split(r"\n(?=(?:Step\s+\d|[0-9]+[.)]\s))", ...):
      -- mark the boundary with \x01, then split on it
      v_marked := regexp_replace(v_body, '(\n)(Step\s+\d|[0-9]+[.)]\s)', E'\\1\x01\\2', 'gi');
      v_parts  := string_to_array(v_marked, E'\x01');

      if array_length(v_parts,1) > 1 then
        select coalesce(jsonb_agg(jsonb_build_object('text', t, 'calc','') order by i), '[]'::jsonb)
          into v_steps
          from (select btrim(p) t, i from unnest(v_parts) with ordinality u(p,i)
                 where btrim(p) <> '' order by i limit 10) s;
        v_prompt := nullif(v_heading,'');
        if v_prompt is null then v_prompt := left(v_parts[1], 200); end if;
        v_answer := coalesce(v_steps -> (jsonb_array_length(v_steps)-1) ->> 'text', '');
      else
        select array_agg(btrim(ln) order by i) into v_lines
          from unnest(string_to_array(v_body, E'\n')) with ordinality u(ln,i)
         where btrim(ln) <> '';
        v_lines := coalesce(v_lines,'{}');
        v_prompt := nullif(v_heading,'');
        if v_prompt is null then v_prompt := coalesce(v_lines[1],''); end if;
        select coalesce(jsonb_agg(jsonb_build_object('text', ln,'calc','') order by i),'[]'::jsonb)
          into v_steps
          from (select ln, i from unnest(v_lines) with ordinality u(ln,i) where i > 1 order by i limit 10) s;
        if array_length(v_lines,1) > 1 then v_answer := v_lines[array_length(v_lines,1)];
        else v_answer := left(v_body,200); end if;
      end if;

      insert into codex_units(id, tenant_id, reading_id, topic_id, ord, kind, title,
                              est_minutes, los_num, payload, source_chunk_ids)
      values (substr(encode(extensions.digest('unit:'||p_doc_id||':'||v_ord,'sha1'),'hex'),1,16),
              '00000000-0000-0000-0000-000000000000', p_doc_id, v_topic, v_ord, 'example',
              left(coalesce(nullif(v_heading,''),'Worked Example'),120), 5, c.los_num,
              jsonb_build_object('prompt', v_prompt, 'steps', v_steps, 'answer', v_answer),
              array[c.id]);
      v_ord := v_ord + 1; v_made := v_made + 1;

    else
      if array_length(buf_ids,1) >= 2
         and c.section_title is not null
         and c.section_title is distinct from buf_prev_sec then
        perform codex__flush_concept(p_doc_id, v_topic, v_ord, buf_ids);
        v_ord := v_ord + 1; v_made := v_made + 1;
        buf_ids := '{}';
      end if;
      buf_ids := buf_ids || c.id;
      buf_prev_sec := c.section_title;
    end if;
  end loop;

  if array_length(buf_ids,1) >= 1 then
    perform codex__flush_concept(p_doc_id, v_topic, v_ord, buf_ids);
    v_ord := v_ord + 1; v_made := v_made + 1;
  end if;

  -- 3. Practice gates (max 5 per reading)
  for l in
    select los_num, outcome, command_verb from codex_los
     where doc_id = p_doc_id order by los_num limit 5
  loop
    v_verb := coalesce(nullif(l.command_verb,''),'explain');
    insert into codex_units(id, tenant_id, reading_id, topic_id, ord, kind, title,
                            est_minutes, los_num, payload, source_chunk_ids)
    values (substr(encode(extensions.digest('unit:'||p_doc_id||':'||v_ord,'sha1'),'hex'),1,16),
            '00000000-0000-0000-0000-000000000000', p_doc_id, v_topic, v_ord, 'practice',
            'Practice — LOS '||l.los_num, 4, l.los_num,
            jsonb_build_object(
              'vignette', 'Consider the following scenario related to LOS '||l.los_num||'.',
              'question', 'Which of the following best '||v_verb||'s: '||left(l.outcome,120)||
                          case when length(l.outcome) > 120 then '...' else '' end,
              'choices', jsonb_build_array(
                 jsonb_build_object('key','A','text','Placeholder answer A — replace with generated item'),
                 jsonb_build_object('key','B','text','Placeholder answer B'),
                 jsonb_build_object('key','C','text','Placeholder answer C')),
              'answer','A',
              'solution_md','**LOS '||l.los_num||'**: '||l.outcome||
                 E'\n\nThis is a placeholder practice item. Run `--generate-practice` to populate with Claude-generated CFA-style questions.',
              'difficulty','medium', '_stub', true),
            '{}'::text[]);
    v_ord := v_ord + 1; v_made := v_made + 1;
  end loop;

  -- readings with no LOS still get one practice gate
  if v_los_n = 0 then
    insert into codex_units(id, tenant_id, reading_id, topic_id, ord, kind, title,
                            est_minutes, los_num, payload, source_chunk_ids)
    values (substr(encode(extensions.digest('unit:'||p_doc_id||':'||v_ord,'sha1'),'hex'),1,16),
            '00000000-0000-0000-0000-000000000000', p_doc_id, v_topic, v_ord, 'practice',
            'Practice — LOS 1', 4, 1,
            jsonb_build_object(
              'vignette','Consider the following scenario related to LOS 1.',
              'question','Which of the following best reviews: Review the key concepts from this reading.',
              'choices', jsonb_build_array(
                 jsonb_build_object('key','A','text','Placeholder answer A — replace with generated item'),
                 jsonb_build_object('key','B','text','Placeholder answer B'),
                 jsonb_build_object('key','C','text','Placeholder answer C')),
              'answer','A',
              'solution_md','**LOS 1**: Review the key concepts from this reading.',
              'difficulty','medium','_stub', true),
            '{}'::text[]);
    v_ord := v_ord + 1; v_made := v_made + 1;
  end if;

  -- 4. Recap
  insert into codex_units(id, tenant_id, reading_id, topic_id, ord, kind, title,
                          est_minutes, los_num, payload, source_chunk_ids)
  select substr(encode(extensions.digest('unit:'||p_doc_id||':'||v_ord,'sha1'),'hex'),1,16),
         '00000000-0000-0000-0000-000000000000', p_doc_id, v_topic, v_ord, 'recap',
         'Recap', 3, null,
         jsonb_build_object(
           'formulas', coalesce((
              select jsonb_agg(jsonb_build_object(
                       'label', coalesce(nullif(f.heading,''),'Formula'),
                       'expr', left(coalesce(f.body,''),300), 'where','') order by f.ord)
                from (select heading, body, ord from codex_chunks
                       where doc_id = p_doc_id and is_formula order by ord limit 8) f), '[]'::jsonb),
           'los_revisited', coalesce((
              select jsonb_agg(los_num order by los_num) from codex_los where doc_id = p_doc_id), '[]'::jsonb),
           'next_reading_id', to_jsonb(v_next_doc)),
         coalesce((select array_agg(id order by ord) from codex_chunks
                    where doc_id = p_doc_id and is_formula), '{}'::text[]);
  v_made := v_made + 1;

  return v_made;
end $$;
