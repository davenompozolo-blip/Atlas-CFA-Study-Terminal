#!/usr/bin/env python3
"""
seed/load_seed.py  —  load codex_seed JSONL files into Supabase.

Usage:
  export SUPABASE_URL=https://<ref>.supabase.co
  export SUPABASE_SERVICE_ROLE_KEY=<key>
  python seed/load_seed.py

Idempotent: documents keyed on content_hash, los and chunks keyed on id.
Re-running is safe and will not duplicate rows.

content_hash for seed rows is derived deterministically from the doc id
(sha256 of id bytes). When load.py (PR2) pushes real PDFs it will replace
these with sha256 of the actual PDF bytes via an upsert on the same key.
"""

import hashlib
import json
import os
import sys
from pathlib import Path

try:
    from supabase import create_client
except ImportError:
    sys.exit("supabase-py not installed — run: pip install supabase")

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

if not SUPABASE_URL or not SUPABASE_KEY:
    sys.exit("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables.")

SEED_DIR = Path(__file__).parent
BATCH = 200  # rows per upsert call


def load_jsonl(path: Path) -> list[dict]:
    rows = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def batched(lst, n):
    for i in range(0, len(lst), n):
        yield lst[i : i + n]


def seed_hash(doc_id: str) -> str:
    """Deterministic placeholder content_hash for seed rows."""
    return hashlib.sha256(doc_id.encode()).hexdigest()


def main():
    sb = create_client(SUPABASE_URL, SUPABASE_KEY)

    # ── documents ──────────────────────────────────────────────────────
    docs = load_jsonl(SEED_DIR / "documents.jsonl")
    doc_rows = []
    for d in docs:
        doc_rows.append({
            "id":            d["id"],
            "topic_id":      d["topic_id"],
            "reading":       d["reading"],
            "lm":            d.get("lm"),
            "source_file":   d["source_file"],
            "pages":         d.get("pages"),
            "los_count":     d.get("los_count", 0),
            "section_count": d.get("section_count", 0),
            "chunk_count":   d.get("chunk_count", 0),
            "content_hash":  seed_hash(d["id"]),
            "ingest_method": "recognizer",
        })

    inserted = 0
    for batch in batched(doc_rows, BATCH):
        sb.table("codex_documents").upsert(batch, on_conflict="id").execute()
        inserted += len(batch)
    print(f"documents: {inserted} upserted")

    # ── LOS ────────────────────────────────────────────────────────────
    los_rows = load_jsonl(SEED_DIR / "los.jsonl")
    los_out = []
    for l in los_rows:
        los_out.append({
            "id":           l["id"],
            "doc_id":       l["doc_id"],
            "topic_id":     l["topic_id"],
            "los_num":      l["los_num"],
            "outcome":      l["outcome"],
            "command_verb": l.get("command_verb"),
            "source":       l.get("source", "recognizer"),
        })

    inserted = 0
    for batch in batched(los_out, BATCH):
        sb.table("codex_los").upsert(batch, on_conflict="id").execute()
        inserted += len(batch)
    print(f"los: {inserted} upserted")

    # ── chunks ─────────────────────────────────────────────────────────
    chunks = load_jsonl(SEED_DIR / "chunks.jsonl")
    chunk_out = []
    for c in chunks:
        chunk_out.append({
            "id":            c["id"],
            "doc_id":        c["doc_id"],
            "topic_id":      c["topic_id"],
            "lm":            c.get("lm"),
            "ord":           c["ord"],
            "section_no":    c.get("section_no"),
            "section_title": c.get("section_title"),
            "section_los":   c.get("section_los"),
            "sub_no":        c.get("sub_no"),
            "heading":       c.get("heading"),
            "body":          c["body"],
            "char_len":      c.get("char_len"),
            "is_example":    c.get("is_example", False),
            "is_formula":    c.get("is_formula", False),
            "los_num":       c.get("los_num"),
        })

    inserted = 0
    for batch in batched(chunk_out, BATCH):
        sb.table("codex_chunks").upsert(batch, on_conflict="id").execute()
        inserted += len(batch)
    print(f"chunks: {inserted} upserted")

    print("Seed complete.")


if __name__ == "__main__":
    main()
