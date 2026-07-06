#!/usr/bin/env python3
"""
ingest/codex_units_gen.py — ATLAS Codex unit generator.

Reads codex_chunks + codex_los for a reading (or all readings) and emits
typed pedagogical units into codex_units:

  LOS opener  → concept(s)  → example(s)  → practice gate  → recap

Each unit has a `kind` and a typed `payload` (see CODEX_SPEC.md §3).
Idempotent: re-running on the same reading replaces its units.

Usage:
  export SUPABASE_URL=https://<ref>.supabase.co
  export SUPABASE_SERVICE_ROLE_KEY=<key>

  # Generate units for a specific reading:
  python ingest/codex_units_gen.py --doc-id <id>

  # Generate for all readings in a topic:
  python ingest/codex_units_gen.py --topic fi

  # Generate for all readings that have no units yet:
  python ingest/codex_units_gen.py --missing

  # Dry-run (print what would be written, no Supabase writes):
  python ingest/codex_units_gen.py --topic fi --dry-run

  # Use Claude to generate practice questions (requires ANTHROPIC_API_KEY):
  python ingest/codex_units_gen.py --doc-id <id> --generate-practice
"""

import argparse
import hashlib
import json
import os
import re
import sys
from typing import Optional

try:
    from supabase import create_client, Client
except ImportError:
    sys.exit("supabase-py not installed — run: pip install supabase")

TENANT = "00000000-0000-0000-0000-000000000000"

# ── ID helpers ────────────────────────────────────────────────────────────────

def unit_id(reading_id: str, ord: int) -> str:
    return hashlib.sha1(f"unit:{reading_id}:{ord}".encode()).hexdigest()[:16]


# ── Chunk → unit classification ───────────────────────────────────────────────

def _classify_chunk(chunk: dict) -> str:
    """Map a raw chunk to the closest unit kind."""
    if chunk.get("is_example"):
        return "example"
    if chunk.get("is_formula"):
        return "concept"
    return "concept"


def _concept_payload(chunks: list[dict]) -> dict:
    """Build a concept unit payload from one or more chunks."""
    prose_parts = []
    formulas = []

    for c in chunks:
        body = c.get("body") or ""
        heading = c.get("heading") or ""

        if c.get("is_formula"):
            formulas.append({
                "label": heading or "Formula",
                "expr": body,
                "where": "",
            })
        else:
            if heading:
                prose_parts.append(f"**{heading}**\n\n{body}")
            else:
                prose_parts.append(body)

    return {
        "prose_md": "\n\n".join(prose_parts),
        "formulas": formulas,
        "illustration": None,
        "key_terms": [],
    }


def _example_payload(chunk: dict) -> dict:
    """Build an example unit payload from a single example chunk."""
    body = chunk.get("body") or ""
    heading = chunk.get("heading") or ""

    # Try to split into steps: lines starting with numbers or "Step"
    step_lines = re.split(r"\n(?=(?:Step\s+\d|[0-9]+[.)]\s))", body, flags=re.IGNORECASE)

    if len(step_lines) > 1:
        steps = [{"text": s.strip(), "calc": ""} for s in step_lines if s.strip()]
        answer = steps[-1]["text"] if steps else ""
        prompt = heading or step_lines[0][:200]
    else:
        # No step structure — treat whole body as prompt + answer combined
        lines = [l.strip() for l in body.split("\n") if l.strip()]
        prompt = heading or (lines[0] if lines else "")
        steps = [{"text": l, "calc": ""} for l in lines[1:] if l]
        answer = lines[-1] if len(lines) > 1 else body[:200]

    return {
        "prompt": prompt,
        "steps": steps[:10],  # cap steps for readability
        "answer": answer,
    }


def _stub_practice_payload(los: dict) -> dict:
    """
    Generate a stub practice unit from a LOS.
    Placeholder vignette — replace with Claude-generated items via --generate-practice.
    """
    outcome = los.get("outcome", "")
    verb = los.get("command_verb") or "explain"
    los_num = los.get("los_num", 1)

    return {
        "vignette": f"Consider the following scenario related to LOS {los_num}.",
        "question": f"Which of the following best {verb}s: {outcome[:120]}{'...' if len(outcome)>120 else ''}",
        "choices": [
            {"key": "A", "text": "Placeholder answer A — replace with generated item"},
            {"key": "B", "text": "Placeholder answer B"},
            {"key": "C", "text": "Placeholder answer C"},
        ],
        "answer": "A",
        "solution_md": f"**LOS {los_num}**: {outcome}\n\nThis is a placeholder practice item. Run `--generate-practice` to populate with Claude-generated CFA-style questions.",
        "difficulty": "medium",
        "_stub": True,
    }


def _recap_payload(los_rows: list[dict], formula_chunks: list[dict], next_reading_id: Optional[str]) -> dict:
    formulas = []
    for c in formula_chunks:
        formulas.append({
            "label": c.get("heading") or "Formula",
            "expr": (c.get("body") or "")[:300],
            "where": "",
        })
    return {
        "formulas": formulas[:8],  # cap to keep recap concise
        "los_revisited": [l["los_num"] for l in los_rows],
        "next_reading_id": next_reading_id,
    }


# ── Claude practice generator (optional) ─────────────────────────────────────

PRACTICE_PROMPT = """\
You are a CFA Level II exam item writer. Given the following Learning Outcome Statement and concept content, write ONE CFA-style practice item.

LOS {los_num}: {outcome}

Concept context:
{context}

Return ONLY valid JSON with this exact shape:
{{
  "vignette": "2-4 sentence scenario relevant to the LOS",
  "question": "Which of the following is MOST accurate?",
  "choices": [
    {{"key": "A", "text": "..."}},
    {{"key": "B", "text": "..."}},
    {{"key": "C", "text": "..."}}
  ],
  "answer": "A"|"B"|"C",
  "solution_md": "Explanation of correct answer and why distractors are wrong.",
  "difficulty": "easy"|"medium"|"hard"
}}
No markdown fences, no prose outside the JSON."""


def _generate_practice_claude(los: dict, context: str) -> Optional[dict]:
    try:
        import anthropic
    except ImportError:
        print("  WARN  anthropic not installed — skipping practice generation")
        return None

    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        print("  WARN  ANTHROPIC_API_KEY not set — skipping practice generation")
        return None

    client = anthropic.Anthropic(api_key=api_key)
    prompt = PRACTICE_PROMPT.format(
        los_num=los.get("los_num", "?"),
        outcome=los.get("outcome", ""),
        context=context[:2000],
    )

    try:
        msg = client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=1024,
            messages=[{"role": "user", "content": prompt}],
        )
        raw = msg.content[0].text.strip()
        return json.loads(raw)
    except Exception as e:
        print(f"  WARN  Claude practice generation failed: {e}")
        return None


# ── Core unit assembly ─────────────────────────────────────────────────────────

def build_units(
    reading_id: str,
    topic_id: str,
    los_rows: list[dict],
    chunks: list[dict],
    next_reading_id: Optional[str] = None,
    generate_practice: bool = False,
) -> list[dict]:
    """
    Assemble ordered unit list for a reading.

    Order: [los_opener] [concept/example groups] [practice per LOS] [recap]
    """
    units = []
    ord_counter = 0

    # ── 1. LOS opener ─────────────────────────────────────────────────────────
    if los_rows:
        uid = unit_id(reading_id, ord_counter)
        units.append({
            "id":               uid,
            "tenant_id":        TENANT,
            "reading_id":       reading_id,
            "topic_id":         topic_id,
            "ord":              ord_counter,
            "kind":             "los",
            "title":            "Learning Outcomes",
            "est_minutes":      2,
            "los_num":          None,
            "payload":          {"outcomes": [{"num": l["los_num"], "text": l["outcome"], "verb": l.get("command_verb")} for l in los_rows]},
            "source_chunk_ids": [],
        })
        ord_counter += 1

    # ── 2. Group chunks into concept/example units ────────────────────────────
    # Walk chunks in order; group consecutive non-example chunks into one
    # concept unit; each example chunk becomes its own example unit.
    concept_buffer: list[dict] = []

    def flush_concept(buffer, los_num=None):
        nonlocal ord_counter
        if not buffer:
            return
        section = buffer[0].get("section_title") or ""
        heading = buffer[0].get("heading") or ""
        title = section or heading or "Concept"
        uid = unit_id(reading_id, ord_counter)
        units.append({
            "id":               uid,
            "tenant_id":        TENANT,
            "reading_id":       reading_id,
            "topic_id":         topic_id,
            "ord":              ord_counter,
            "kind":             "concept",
            "title":            title[:120],
            "est_minutes":      max(4, min(12, len(buffer) * 3)),
            "los_num":          los_num,
            "payload":          _concept_payload(buffer),
            "source_chunk_ids": [c["id"] for c in buffer],
        })
        ord_counter += 1

    for chunk in chunks:
        if chunk.get("is_example"):
            flush_concept(concept_buffer)
            concept_buffer = []

            uid = unit_id(reading_id, ord_counter)
            units.append({
                "id":               uid,
                "tenant_id":        TENANT,
                "reading_id":       reading_id,
                "topic_id":         topic_id,
                "ord":              ord_counter,
                "kind":             "example",
                "title":            (chunk.get("heading") or "Worked Example")[:120],
                "est_minutes":      5,
                "los_num":          chunk.get("los_num"),
                "payload":          _example_payload(chunk),
                "source_chunk_ids": [chunk["id"]],
            })
            ord_counter += 1
        else:
            # Start a new concept buffer when section changes
            if concept_buffer:
                prev_sec = concept_buffer[-1].get("section_title")
                curr_sec = chunk.get("section_title")
                # Flush if section title changed and buffer is non-trivial
                if curr_sec and curr_sec != prev_sec and len(concept_buffer) >= 2:
                    flush_concept(concept_buffer)
                    concept_buffer = []
            concept_buffer.append(chunk)

    flush_concept(concept_buffer)
    concept_buffer = []

    # ── 3. Practice gates — one per LOS (or one overall if no LOS) ────────────
    practice_los_list = los_rows if los_rows else [{"los_num": 1, "outcome": "Review the key concepts from this reading.", "command_verb": "review"}]

    # Gather concept text for context
    all_concept_text = " ".join(
        (c.get("body") or "")
        for c in chunks if not c.get("is_example")
    )

    for los in practice_los_list[:5]:  # cap at 5 practice items per reading
        if generate_practice:
            payload = _generate_practice_claude(los, all_concept_text) or _stub_practice_payload(los)
        else:
            payload = _stub_practice_payload(los)

        uid = unit_id(reading_id, ord_counter)
        units.append({
            "id":               uid,
            "tenant_id":        TENANT,
            "reading_id":       reading_id,
            "topic_id":         topic_id,
            "ord":              ord_counter,
            "kind":             "practice",
            "title":            f"Practice — LOS {los['los_num']}",
            "est_minutes":      4,
            "los_num":          los["los_num"],
            "payload":          payload,
            "source_chunk_ids": [],
        })
        ord_counter += 1

    # ── 4. Recap ───────────────────────────────────────────────────────────────
    formula_chunks = [c for c in chunks if c.get("is_formula")]
    uid = unit_id(reading_id, ord_counter)
    units.append({
        "id":               uid,
        "tenant_id":        TENANT,
        "reading_id":       reading_id,
        "topic_id":         topic_id,
        "ord":              ord_counter,
        "kind":             "recap",
        "title":            "Recap",
        "est_minutes":      3,
        "los_num":          None,
        "payload":          _recap_payload(los_rows, formula_chunks, next_reading_id),
        "source_chunk_ids": [c["id"] for c in formula_chunks],
    })

    return units


# ── Supabase helpers ──────────────────────────────────────────────────────────

BATCH = 50


def _batched(lst, n):
    for i in range(0, len(lst), n):
        yield lst[i: i + n]


def fetch_reading_data(sb: "Client", doc_id: str) -> tuple[dict, list[dict], list[dict]]:
    """Returns (doc_row, los_rows, chunk_rows) for a reading."""
    doc_res = sb.table("codex_documents").select("*").eq("id", doc_id).single().execute()
    doc = doc_res.data

    los_res = (
        sb.table("codex_los")
        .select("id, los_num, outcome, command_verb")
        .eq("doc_id", doc_id)
        .order("los_num")
        .execute()
    )
    los_rows = los_res.data or []

    chunk_res = (
        sb.table("codex_chunks")
        .select("id, ord, section_no, section_title, section_los, sub_no, heading, body, is_example, is_formula, los_num")
        .eq("doc_id", doc_id)
        .order("ord")
        .execute()
    )
    chunk_rows = chunk_res.data or []

    return doc, los_rows, chunk_rows


def upsert_units(sb: "Client", units: list[dict]) -> int:
    if not units:
        return 0
    for batch in _batched(units, BATCH):
        sb.table("codex_units").upsert(batch, on_conflict="id").execute()
    return len(units)


def delete_reading_units(sb: "Client", reading_id: str):
    sb.table("codex_units").delete().eq("reading_id", reading_id).execute()


def fetch_readings(sb: "Client", topic: Optional[str] = None, missing_only: bool = False) -> list[dict]:
    query = sb.table("codex_documents").select("id, topic_id, reading, chunk_count")
    if topic:
        query = query.eq("topic_id", topic)
    res = query.order("topic_id").execute()
    docs = res.data or []

    if missing_only:
        unit_res = sb.table("codex_units").select("reading_id").execute()
        has_units = {r["reading_id"] for r in (unit_res.data or [])}
        docs = [d for d in docs if d["id"] not in has_units]

    return docs


def get_next_reading_id(sb: "Client", doc: dict) -> Optional[str]:
    """Returns next reading in deficit-priority order within the same topic."""
    res = (
        sb.table("codex_documents")
        .select("id")
        .eq("topic_id", doc["topic_id"])
        .neq("id", doc["id"])
        .limit(1)
        .execute()
    )
    rows = res.data or []
    return rows[0]["id"] if rows else None


# ── CLI ────────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="ATLAS Codex unit generator")
    parser.add_argument("--doc-id", help="Generate units for a specific reading")
    parser.add_argument("--topic", help="Generate for all readings in a topic")
    parser.add_argument("--missing", action="store_true", help="Only readings with no units yet")
    parser.add_argument("--generate-practice", action="store_true",
                        help="Use Claude to generate CFA-style practice items (requires ANTHROPIC_API_KEY)")
    parser.add_argument("--dry-run", action="store_true", help="Print summary, no DB writes")
    parser.add_argument("--replace", action="store_true",
                        help="Delete existing units before generating (default: upsert)")
    args = parser.parse_args()

    if not args.doc_id and not args.topic and not args.missing:
        parser.error("Specify --doc-id, --topic, or --missing")

    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not url or not key:
        sys.exit("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.")

    sb = create_client(url, key)

    # Collect target readings
    if args.doc_id:
        doc_res = sb.table("codex_documents").select("id, topic_id, reading, chunk_count").eq("id", args.doc_id).maybe_single().execute()
        if not doc_res.data:
            sys.exit(f"Reading not found: {args.doc_id}")
        readings = [doc_res.data]
    else:
        readings = fetch_readings(sb, topic=args.topic, missing_only=args.missing)

    if not readings:
        print("No readings to process.")
        return

    total_units = 0

    for doc in readings:
        doc_full, los_rows, chunk_rows = fetch_reading_data(sb, doc["id"])
        next_id = get_next_reading_id(sb, doc)

        units = build_units(
            reading_id=doc["id"],
            topic_id=doc["topic_id"],
            los_rows=los_rows,
            chunks=chunk_rows,
            next_reading_id=next_id,
            generate_practice=args.generate_practice,
        )

        n = len(units)
        kinds = {}
        for u in units:
            kinds[u["kind"]] = kinds.get(u["kind"], 0) + 1
        kind_str = " ".join(f"{k}={v}" for k, v in sorted(kinds.items()))

        if args.dry_run:
            print(f"  DRY  {doc['reading']:<50}  {n} units  [{kind_str}]")
        else:
            if args.replace:
                delete_reading_units(sb, doc["id"])
            upsert_units(sb, units)
            print(f"  OK   {doc['reading']:<50}  {n} units  [{kind_str}]")

        total_units += n

    print()
    if args.dry_run:
        print(f"Dry run: {len(readings)} reading(s), {total_units} units would be written.")
    else:
        print(f"Done: {len(readings)} reading(s), {total_units} units written.")


if __name__ == "__main__":
    main()
