#!/usr/bin/env python3
"""
ingest/codex_fallback.py — Claude fallback for LOS extraction.

Finds documents in codex_documents where los_count = 0 (recognizers returned
< 2 LOS), sends the first ~2 pages of PDF text to Claude, parses the JSON
response, and upserts the resulting rows into codex_los.

Also runs a second pass to backfill is_formula / is_example flags on chunks
that were left as False/False when the recognizer had no colour-data signal.

Usage:
  export SUPABASE_URL=https://<ref>.supabase.co
  export SUPABASE_SERVICE_ROLE_KEY=<key>
  export ANTHROPIC_API_KEY=<key>

  # Process all NO-LOS docs:
  python ingest/codex_fallback.py

  # Process a specific document by id:
  python ingest/codex_fallback.py --doc-id f74779747e1f9673

  # Process a specific topic:
  python ingest/codex_fallback.py --topic eq

  # Dry-run (call Claude but don't write to Supabase):
  python ingest/codex_fallback.py --dry-run

Notes:
  - PDF text is pulled from Supabase Storage (codex-notes bucket).
    If storage_path is NULL the doc is skipped with a warning.
  - Idempotent: rows are upserted on id; re-running adds nothing if already done.
  - source = 'claude_fallback' on every row written here.
"""

import argparse
import hashlib
import json
import os
import sys
import time
from io import BytesIO

try:
    import pdfplumber
except ImportError:
    sys.exit("pdfplumber not installed — run: pip install pdfplumber")

try:
    import anthropic
except ImportError:
    sys.exit("anthropic not installed — run: pip install anthropic")

try:
    from supabase import create_client, Client
except ImportError:
    sys.exit("supabase-py not installed — run: pip install supabase")

# ── constants ──────────────────────────────────────────────────────────────────

MODEL = "claude-sonnet-4-6"
MAX_CHARS = 6000        # ~2 pages of dense text is enough for LOS
RETRY_DELAY = 2         # seconds between Claude retries

LOS_PROMPT = """\
You are a CFA curriculum parser. Extract all Learning Outcome Statements (LOS) \
from the text below. Return ONLY a JSON array, no prose, no markdown fences.

Each element must have exactly these keys:
  "los_num"      : integer (the LOS number)
  "outcome"      : string  (the full outcome text, starting with the command verb)
  "command_verb" : string  (lowercase first word: "calculate", "explain", etc.) or null

If no LOS are present return an empty array: []

TEXT:
{text}"""

CHUNK_CLASSIFY_PROMPT = """\
You are classifying a study note chunk for a CFA Level II revision terminal.
Return ONLY a JSON object with two boolean keys, no prose.

  "is_formula"  : true if the chunk contains a formula, equation, or \
mathematical expression that a student would need to memorise
  "is_example"  : true if the chunk contains a worked example, numerical \
illustration, or case study

HEADING: {heading}

BODY (first 500 chars):
{body}"""

# ── helpers ────────────────────────────────────────────────────────────────────

def _pdf_text(raw: bytes, max_chars: int = MAX_CHARS) -> str:
    """Extract text from the first pages of a PDF up to max_chars."""
    text = ""
    with pdfplumber.open(BytesIO(raw)) as pdf:
        for page in pdf.pages:
            t = page.extract_text(x_tolerance=2, y_tolerance=2) or ""
            text += t + "\n"
            if len(text) >= max_chars:
                break
    return text[:max_chars]


def _call_claude(client: anthropic.Anthropic, prompt: str, retries: int = 3) -> str:
    for attempt in range(retries):
        try:
            msg = client.messages.create(
                model=MODEL,
                max_tokens=1024,
                messages=[{"role": "user", "content": prompt}],
            )
            return msg.content[0].text.strip()
        except anthropic.RateLimitError:
            if attempt < retries - 1:
                time.sleep(RETRY_DELAY * (attempt + 1))
            else:
                raise


def _parse_los_json(raw: str) -> list[dict]:
    """Parse Claude's JSON response into a list of LOS dicts."""
    # Strip accidental markdown fences
    raw = raw.strip()
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return []
    if not isinstance(data, list):
        return []
    out = []
    for item in data:
        if not isinstance(item, dict):
            continue
        num = item.get("los_num")
        outcome = item.get("outcome", "").strip()
        if not isinstance(num, int) or not outcome:
            continue
        out.append({
            "los_num":      num,
            "outcome":      outcome,
            "command_verb": item.get("command_verb") or None,
            "source":       "claude_fallback",
        })
    return out


def _parse_classify_json(raw: str) -> tuple[bool, bool]:
    raw = raw.strip()
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
    try:
        data = json.loads(raw)
        return bool(data.get("is_formula")), bool(data.get("is_example"))
    except Exception:
        return False, False


def _los_row_id(doc_id: str, los_num: int) -> str:
    return hashlib.sha1(f"{doc_id}:{los_num}".encode()).hexdigest()[:16]


# ── core logic ─────────────────────────────────────────────────────────────────

def process_document(
    sb: "Client",
    claude: anthropic.Anthropic,
    doc: dict,
    dry_run: bool,
) -> int:
    """
    Run Claude LOS extraction for one document.
    Returns number of LOS rows upserted.
    """
    doc_id = doc["id"]
    storage_path = doc.get("storage_path")

    if not storage_path:
        print(f"  SKIP  {doc_id}  ({doc.get('reading','?')}) — no storage_path, run ingest first")
        return 0

    # Fetch PDF bytes from Supabase Storage
    try:
        resp = sb.storage.from_("codex-notes").download(storage_path)
        raw = resp
    except Exception as e:
        print(f"  SKIP  {doc_id}  ({doc.get('reading','?')}) — storage download failed: {e}")
        return 0

    text = _pdf_text(raw)
    if not text.strip():
        print(f"  SKIP  {doc_id}  ({doc.get('reading','?')}) — could not extract text")
        return 0

    prompt = LOS_PROMPT.format(text=text)
    raw_response = _call_claude(claude, prompt)
    los_rows = _parse_los_json(raw_response)

    if not los_rows:
        print(f"  NONE  {doc_id}  ({doc.get('reading','?')}) — Claude found no LOS")
        return 0

    # Stamp ids and foreign keys
    rows_to_upsert = []
    for row in los_rows:
        rows_to_upsert.append({
            "id":           _los_row_id(doc_id, row["los_num"]),
            "doc_id":       doc_id,
            "topic_id":     doc["topic_id"],
            "los_num":      row["los_num"],
            "outcome":      row["outcome"],
            "command_verb": row["command_verb"],
            "source":       "claude_fallback",
        })

    if not dry_run:
        sb.table("codex_los").upsert(rows_to_upsert, on_conflict="id").execute()
        sb.table("codex_documents").update({
            "los_count":     len(rows_to_upsert),
            "ingest_method": "claude_fallback",
        }).eq("id", doc_id).execute()

    print(
        f"  {'DRY' if dry_run else 'OK '}  {doc_id}  "
        f"({doc.get('reading','?')})  los={len(rows_to_upsert)}"
    )
    return len(rows_to_upsert)


def backfill_chunk_flags(
    sb: "Client",
    claude: anthropic.Anthropic,
    topic_id: str | None,
    dry_run: bool,
) -> int:
    """
    For chunks where both is_formula and is_example are False and the body
    is non-trivial, ask Claude to classify them. Updates rows in place.

    This is a best-effort pass; call it after LOS extraction if desired.
    """
    query = (
        sb.table("codex_chunks")
        .select("id, heading, body, topic_id")
        .eq("is_formula", False)
        .eq("is_example", False)
        .gt("char_len", 200)
    )
    if topic_id:
        query = query.eq("topic_id", topic_id)

    result = query.execute()
    candidates = result.data or []

    updated = 0
    for chunk in candidates:
        prompt = CHUNK_CLASSIFY_PROMPT.format(
            heading=chunk.get("heading") or "",
            body=(chunk.get("body") or "")[:500],
        )
        raw = _call_claude(claude, prompt)
        is_formula, is_example = _parse_classify_json(raw)
        if not is_formula and not is_example:
            continue

        if not dry_run:
            sb.table("codex_chunks").update({
                "is_formula": is_formula,
                "is_example": is_example,
            }).eq("id", chunk["id"]).execute()
        updated += 1

    return updated


# ── CLI ────────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="ATLAS Codex — Claude LOS fallback")
    parser.add_argument("--doc-id", help="Process a specific document id only")
    parser.add_argument("--topic",  help="Limit to a specific topic_id")
    parser.add_argument("--backfill-chunks", action="store_true",
                        help="Also run chunk flag backfill (is_formula / is_example)")
    parser.add_argument("--dry-run", action="store_true",
                        help="Call Claude but do not write to Supabase")
    args = parser.parse_args()

    supabase_url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    supabase_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    anthropic_key = os.environ.get("ANTHROPIC_API_KEY", "")

    if not supabase_url or not supabase_key:
        sys.exit("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.")
    if not anthropic_key:
        sys.exit("Set ANTHROPIC_API_KEY.")

    sb = create_client(supabase_url, supabase_key)
    claude = anthropic.Anthropic(api_key=anthropic_key)

    # ── fetch target documents ─────────────────────────────────────────────────
    if args.doc_id:
        result = sb.table("codex_documents").select("*").eq("id", args.doc_id).execute()
    else:
        query = sb.table("codex_documents").select("*").eq("los_count", 0)
        if args.topic:
            query = query.eq("topic_id", args.topic)
        result = query.execute()

    docs = result.data or []
    if not docs:
        print("No documents to process.")
        return

    print(f"Processing {len(docs)} document(s) with Claude ({MODEL})…\n")

    total_los = 0
    for doc in docs:
        total_los += process_document(sb, claude, doc, args.dry_run)

    print(f"\nLOS extraction complete. Total rows: {total_los}")

    if args.backfill_chunks:
        print("\nRunning chunk flag backfill…")
        n = backfill_chunk_flags(sb, claude, args.topic, args.dry_run)
        print(f"Chunk flags updated: {n}")


if __name__ == "__main__":
    main()
