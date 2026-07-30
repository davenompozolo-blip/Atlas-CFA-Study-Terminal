# Alternatives typed blocks

Authored content for Alternative Investments LM1–LM4 — 33 concept units,
393 blocks — stored as typed `codex_blocks` rather than a flattened
`prose_md` blob.

| File | What it is |
|---|---|
| `seed_alternatives.sql` | **Apply this.** Generated output of `seed_blocks.py`. One transaction. |
| `blocks_CFA_L2_Alts_LM*.json` | The source content. |
| `seed_blocks.py` | Regenerates the SQL from the JSON. Never writes to a database. |
| `recorder.py` | Emits block JSON from the notes source, for further readings. |

## Applying

Paste `seed_alternatives.sql` into the Supabase SQL editor and run it. It is
wrapped in a single transaction, so it either all lands or none does.

Verify afterwards — expect 33 rows with block counts between 5 and 21:

```sql
select u.reading_id, u.ord, u.title, count(b.id) as blocks
from codex_units u left join codex_blocks b on b.unit_id = u.id
where u.topic_id = 'alt' and u.kind = 'concept'
group by u.id, u.reading_id, u.ord, u.title
order by u.reading_id, u.ord;
```

Before running it, take a Supabase point-in-time-recovery checkpoint, or snapshot
the two tables it touches:

```sql
create table codex_units_backup as select * from codex_units;
create table codex_unit_progress_backup as select * from codex_unit_progress;
```

The transaction rolls itself back on failure, so this is not about the run going
wrong — it is about the run succeeding and verification afterwards turning up
something unexpected.

## What it replaces, and what it costs

Per reading it runs two destructive statements before inserting:

```sql
delete from codex_units where reading_id = '...' and kind = 'concept';
update codex_units set ord = ord + N where reading_id = '...' and kind <> 'los' and ord > 0;
```

That is deliberate. The existing Alternatives `concept` units are the
PDF-flattened blobs being replaced — one of them is 10,335 characters titled
"Overview". Everything else in those readings (`los`, `example`, `practice`,
`recap`) survives and shifts to sit after the new units; `los` stays at ord 0.

Deleting units cascades `codex_unit_progress`. At time of writing that cost 14
`viewed` markers, ten of them on those "Overview" blobs.

Unit ids are a deterministic hash of `(topic, module, ordinal)`, so re-running
is idempotent.

## Regenerating

```bash
python3 seed_blocks.py blocks_CFA_L2_Alts_LM*.json --emit-sql > seed_alternatives.sql
```

The script refuses to run without `--emit-sql` and holds no credentials — it
only prints SQL. The committed output is byte-identical to a fresh run.
