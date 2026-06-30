#!/usr/bin/env python3
"""
ingest/codex_ingest.py — ATLAS Codex PDF ingest pipeline.

Parses CFA L2 note PDFs, upserts structured records to Supabase, and
uploads the raw PDF to the codex-notes storage bucket.

Usage:
  export SUPABASE_URL=https://<ref>.supabase.co
  export SUPABASE_SERVICE_ROLE_KEY=<key>

  # Ingest a single PDF (topic inferred from path):
  python ingest/codex_ingest.py notes/Derivatives/CFA_L2_Forwards.pdf

  # Ingest an entire topic directory:
  python ingest/codex_ingest.py notes/Derivatives/

  # Ingest all notes:
  python ingest/codex_ingest.py notes/

  # Specify topic explicitly:
  python ingest/codex_ingest.py my_notes.pdf --topic der

  # Dry-run (parse only, no Supabase writes):
  python ingest/codex_ingest.py notes/ --dry-run

Idempotency: documents are keyed on sha256(file_bytes). Re-running on an
unchanged PDF is a no-op. A changed PDF (re-edited notes) re-parses and
upserts the updated rows.
"""

import argparse
import hashlib
import os
import re
import sys
from pathlib import Path
from typing import Optional

# ── dependency guards ──────────────────────────────────────────────────────────

try:
    import pdfplumber
except ImportError:
    sys.exit("pdfplumber not installed — run: pip install pdfplumber")

try:
    from supabase import create_client, Client
except ImportError:
    sys.exit("supabase-py not installed — run: pip install supabase")

# ── topic inference ────────────────────────────────────────────────────────────

TOPIC_KEYWORDS: dict[str, list[str]] = {
    "alt":  ["alternative", "alternatives", "hedge_fund", "hedgefund", "reit",
             "real_estate", "realestate", "commodity", "commodit", "private_eq",
             "privateequity", "infrastructure"],
    "fi":   ["fixed_income", "fixedincome", "fixed.income", "bond", "credit",
             "securit", "mortgage"],
    "der":  ["derivative", "derivatives", "forward", "futures", "option",
             "swap", "swaption"],
    "corp": ["corporate", "corp_", "_corp", "governance", "dividend",
             "capital_structure", "capitalstructure", "wacc"],
    "fsa":  ["financial_statement", "financialstatement", "fsa_", "intercorporate",
             "multinational", "pension", "intangible", "quality_of"],
    "quant": ["quantitative", "quant_", "regression", "time_series", "machine_learning"],
    "eco":  ["economic", "economics", "eco_", "currency", "forex", "fx_"],
    "eq":   ["equity", "equit", "valuation", "dcf", "residual_income",
             "market_based", "private_company"],
    "pm":   ["portfolio", "pm_", "risk_management", "factor", "liability_driven"],
    "eth":  ["ethics", "ethical", "professional_standard", "standard_i",
             "standard_ii", "standard_iii"],
}


def infer_topic(path: Path) -> Optional[str]:
    """Guess topic_id from directory name and filename, lowercased."""
    text = (str(path.parent.name) + " " + path.stem).lower().replace("-", "_").replace(" ", "_")
    for topic_id, keywords in TOPIC_KEYWORDS.items():
        if any(kw in text for kw in keywords):
            return topic_id
    return None


# ── PDF parsing ────────────────────────────────────────────────────────────────

# ── LOS recognizers (three templates observed in the corpus) ──────────────────

# Template A: LOS CHECKLIST table  — "  1  Discuss how hedge funds…"
_RE_LOS_A = re.compile(
    r"^\s*(\d{1,3})\s{2,}"          # leading number
    r"([A-Z][a-z]+\b.*?)$",          # verb + outcome (title-case start)
    re.MULTILINE,
)

# Template B: LEARNING OUTCOME STATEMENTS bullets — "• 1. Explain …"
_RE_LOS_B = re.compile(
    r"[•◆▪◉●]\s*(\d{1,3})[.)]\s+"   # bullet + number
    r"([A-Z][a-z]+\b.*?)(?=\n|$)",
    re.MULTILINE,
)

# Template C: plain numbered list — "1. Calculate the value of…"
_RE_LOS_C = re.compile(
    r"^(\d{1,3})\.\s+"
    r"([A-Z][a-z]+\b.+?)(?=\n\d{1,3}\.\s|\Z)",
    re.MULTILINE | re.DOTALL,
)

COMMAND_VERBS = {
    "calculate", "compute", "derive", "demonstrate", "estimate",
    "explain", "describe", "discuss", "define", "identify", "list",
    "compare", "contrast", "evaluate", "interpret", "analyze", "analyse",
    "classify", "distinguish", "recommend", "justify", "critique",
    "construct", "formulate",
}

_RE_VERB = re.compile(
    r"^(" + "|".join(sorted(COMMAND_VERBS, key=len, reverse=True)) + r")\b",
    re.IGNORECASE,
)


def _command_verb(outcome: str) -> Optional[str]:
    m = _RE_VERB.match(outcome.strip())
    return m.group(1).lower() if m else None


def _parse_los(full_text: str) -> list[dict]:
    """
    Extract LOS from the full PDF text. Tries templates A, B, C in order;
    returns whichever yields the most results. Returns empty list if < 2 found
    (signals Claude fallback territory, handled in PR3).
    """
    candidates: list[list[dict]] = []

    def _collect(pattern, text) -> list[dict]:
        out = []
        for m in pattern.finditer(text):
            num_str = m.group(1)
            outcome = m.group(2).strip()
            if len(outcome) < 8:        # too short, skip noise
                continue
            out.append({
                "los_num":      int(num_str),
                "outcome":      outcome,
                "command_verb": _command_verb(outcome),
                "source":       "recognizer",
            })
        return out

    # Isolate the LOS section (first ~4 pages worth of text is usually enough)
    header_text = full_text[:8000]
    for pat in (_RE_LOS_A, _RE_LOS_B, _RE_LOS_C):
        hits = _collect(pat, header_text)
        candidates.append(hits)

    best = max(candidates, key=len)
    return best if len(best) >= 2 else []


# ── Section / chunk recognizers ────────────────────────────────────────────────

# "SECTION 3: EQUITY VALUATION APPROACHES" or "SECTION 3 — EQUITY…"
_RE_SECTION = re.compile(
    r"^SECTION\s+(\d+)\s*[:\-—]\s*(.+?)$",
    re.IGNORECASE | re.MULTILINE,
)

# "PART I: INTRODUCTION" (April Quant template)
_RE_PART = re.compile(
    r"^PART\s+(I{1,4}|V?I{0,3}|[A-Z])\s*[:\-—]\s*(.+?)$",
    re.IGNORECASE | re.MULTILINE,
)

# Roman → integer for PART recognizer
_ROMAN = {"I": 1, "II": 2, "III": 3, "IV": 4, "V": 5,
          "VI": 6, "VII": 7, "VIII": 8, "IX": 9, "X": 10}

# "3.1  Heading text" or "3.1 — Heading text"
_RE_SUBSEC = re.compile(
    r"^(\d+\.\d+(?:\.\d+)?)\s*[—\-]?\s+(.+?)$",
    re.MULTILINE,
)

# Formula/example detection
_RE_FORMULA_SIGNAL = re.compile(
    r"(?:"
    r"\bF_?0\s*="           # forward price notation
    r"|=\s*\$?\s*[\d.]+\s*[×\*/]"  # = $amount × ...
    r"|\bEAR\b|\bEPS\b|\bWACC\b|\bCAPM\b|\bNOI\b|\bFFO\b"
    r"|\bNPV\b|\bIRR\b|\bDuration\b|\bConvexity\b"
    r"|𝐅|𝐕|𝐒|𝛑|𝛔|𝐩=|𝐜="   # unicode math bold chars used in these notes
    r"|\bPV\s*\(|\bFV\s*\("
    r"|\bln\s*\(|\be\^"
    r")",
    re.IGNORECASE,
)

_RE_EXAMPLE_SIGNAL = re.compile(
    r"(?:"
    r"^e\.g\.[/.]"
    r"|^Example\s*\d"
    r"|^Case\s+Study"
    r"|^Worked\s+Example"
    r"|^EXAMPLE\s*\d"
    r")",
    re.IGNORECASE | re.MULTILINE,
)


def _is_formula_chunk(heading: str, body: str) -> bool:
    text = (heading or "") + "\n" + (body or "")
    return bool(_RE_FORMULA_SIGNAL.search(text))


def _is_example_chunk(heading: str, body: str) -> bool:
    text = (heading or "") + "\n" + (body[:200] if body else "")
    return bool(_RE_EXAMPLE_SIGNAL.search(text))


def _extract_chunks(full_text: str) -> list[dict]:
    """
    Split the PDF text into subsection-level chunks using section/subsection
    headers. Returns list of dicts matching codex_chunks columns (minus id,
    doc_id, topic_id which are filled in later).
    """
    # Build a flat list of (position, type, number, title)
    markers: list[tuple[int, str, int, str]] = []

    for m in _RE_SECTION.finditer(full_text):
        markers.append((m.start(), "section", int(m.group(1)), m.group(2).strip()))

    for m in _RE_PART.finditer(full_text):
        roman = m.group(1).upper()
        num = _ROMAN.get(roman, ord(roman[0]) - ord("A") + 1)
        markers.append((m.start(), "section", num, m.group(2).strip()))

    for m in _RE_SUBSEC.finditer(full_text):
        sub = m.group(1)
        parts = sub.split(".")
        sec_num = int(parts[0])
        markers.append((m.start(), "sub", sec_num, sub, m.group(2).strip()))

    # Sort by position
    markers.sort(key=lambda x: x[0])

    if not markers:
        # No structure found — treat whole doc as one chunk
        return [{
            "ord": 0, "section_no": None, "section_title": None,
            "section_los": None, "sub_no": None,
            "heading": "Overview",
            "body": full_text[:4000].strip(),
            "char_len": min(len(full_text), 4000),
            "is_example": _is_example_chunk("Overview", full_text[:4000]),
            "is_formula": _is_formula_chunk("Overview", full_text[:4000]),
        }]

    # Walk markers, collect body text between them
    chunks: list[dict] = []
    current_section_no: Optional[int] = None
    current_section_title: Optional[str] = None
    ord_counter = 0

    for idx, item in enumerate(markers):
        pos = item[0]
        kind = item[1]

        if kind == "section":
            current_section_no = item[2]
            current_section_title = item[3]
            continue  # section headers themselves aren't chunks

        # kind == "sub"
        sub_no = item[3]
        heading = item[4]

        # Body = text until next marker
        body_start = full_text.index(heading, pos) + len(heading)
        next_pos = markers[idx + 1][0] if idx + 1 < len(markers) else len(full_text)
        body = full_text[body_start:next_pos].strip()

        if not body and not heading:
            continue

        chunks.append({
            "ord":           ord_counter,
            "section_no":    current_section_no,
            "section_title": current_section_title,
            "section_los":   None,
            "sub_no":        sub_no,
            "heading":       heading,
            "body":          body,
            "char_len":      len(body),
            "is_example":    _is_example_chunk(heading, body),
            "is_formula":    _is_formula_chunk(heading, body),
        })
        ord_counter += 1

    return chunks


# ── main parse function ────────────────────────────────────────────────────────

def parse_pdf(path: Path, topic_id: str) -> dict:
    """
    Parse a PDF into the document / los / chunks structure.
    Returns dict with keys: doc_meta, los_rows, chunk_rows.
    """
    raw = path.read_bytes()
    content_hash = hashlib.sha256(raw).hexdigest()
    doc_id = hashlib.sha1(
        (topic_id + path.name).encode()
    ).hexdigest()[:16]

    full_text = ""
    pages = 0
    with pdfplumber.open(path) as pdf:
        pages = len(pdf.pages)
        for page in pdf.pages:
            t = page.extract_text(x_tolerance=2, y_tolerance=2)
            if t:
                full_text += t + "\n"

    los_rows = _parse_los(full_text)
    chunk_rows = _extract_chunks(full_text)

    # Derive reading name from filename (strip prefix/suffix)
    reading = re.sub(r"^CFA_L2_", "", path.stem, flags=re.IGNORECASE)
    reading = re.sub(r"[_\-]+", " ", reading).strip()

    doc_meta = {
        "id":            doc_id,
        "topic_id":      topic_id,
        "reading":       reading,
        "lm":            None,          # set manually via --lm flag if needed
        "source_file":   f"{path.parent.name}/{path.name}",
        "pages":         pages,
        "los_count":     len(los_rows),
        "section_count": len({c["section_no"] for c in chunk_rows if c["section_no"]}),
        "chunk_count":   len(chunk_rows),
        "content_hash":  content_hash,
        "ingest_method": "recognizer",
    }

    # Stamp doc_id and topic_id onto los / chunk rows; generate stable IDs
    for i, row in enumerate(los_rows):
        row["id"] = hashlib.sha1(
            f"{doc_id}:{row['los_num']}".encode()
        ).hexdigest()[:16]
        row["doc_id"] = doc_id
        row["topic_id"] = topic_id

    for i, row in enumerate(chunk_rows):
        row["id"] = hashlib.sha1(
            f"{doc_id}:{row['ord']}:{row.get('sub_no','')}".encode()
        ).hexdigest()[:16]
        row["doc_id"] = doc_id
        row["topic_id"] = topic_id

    return {"doc_meta": doc_meta, "los_rows": los_rows, "chunk_rows": chunk_rows}


# ── Supabase upsert + storage upload ──────────────────────────────────────────

BATCH = 100


def _batched(lst, n):
    for i in range(0, len(lst), n):
        yield lst[i: i + n]


def upsert_document(sb: "Client", doc: dict) -> bool:
    """Returns True if newly inserted, False if unchanged (same hash)."""
    existing = (
        sb.table("codex_documents")
        .select("id, content_hash")
        .eq("id", doc["id"])
        .maybe_single()
        .execute()
    )
    if existing.data and existing.data["content_hash"] == doc["content_hash"]:
        return False    # identical, skip
    sb.table("codex_documents").upsert(doc, on_conflict="id").execute()
    return True


def upsert_los(sb: "Client", rows: list[dict]) -> int:
    if not rows:
        return 0
    for batch in _batched(rows, BATCH):
        sb.table("codex_los").upsert(batch, on_conflict="id").execute()
    return len(rows)


def upsert_chunks(sb: "Client", rows: list[dict]) -> int:
    if not rows:
        return 0
    for batch in _batched(rows, BATCH):
        sb.table("codex_chunks").upsert(batch, on_conflict="id").execute()
    return len(rows)


def upload_pdf(sb: "Client", path: Path, storage_path: str) -> str:
    """Upload PDF to codex-notes bucket. Returns the storage path."""
    raw = path.read_bytes()
    sb.storage.from_("codex-notes").upload(
        storage_path,
        raw,
        {"content-type": "application/pdf", "upsert": "true"},
    )
    return storage_path


# ── CLI ────────────────────────────────────────────────────────────────────────

def collect_pdfs(target: Path) -> list[Path]:
    if target.is_file():
        return [target] if target.suffix.lower() == ".pdf" else []
    return sorted(target.rglob("*.pdf"))


def main():
    parser = argparse.ArgumentParser(description="ATLAS Codex PDF ingest pipeline")
    parser.add_argument("target", help="PDF file or directory to ingest")
    parser.add_argument("--topic", help="Override topic_id (alt|fi|der|corp|fsa|quant|eco|eq|pm|eth)")
    parser.add_argument("--lm", type=int, help="Learning module number override")
    parser.add_argument("--dry-run", action="store_true", help="Parse only, no Supabase writes")
    args = parser.parse_args()

    target = Path(args.target)
    if not target.exists():
        sys.exit(f"Not found: {target}")

    pdfs = collect_pdfs(target)
    if not pdfs:
        sys.exit("No PDF files found.")

    sb = None
    if not args.dry_run:
        url = os.environ.get("SUPABASE_URL", "").rstrip("/")
        key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
        if not url or not key:
            sys.exit("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or use --dry-run).")
        sb = create_client(url, key)

    total_new = total_skip = total_los = total_chunks = 0

    for pdf in pdfs:
        topic_id = args.topic or infer_topic(pdf)
        if not topic_id:
            print(f"  SKIP  {pdf.name}  (cannot infer topic — use --topic)")
            continue

        parsed = parse_pdf(pdf, topic_id)
        doc = parsed["doc_meta"]
        if args.lm:
            doc["lm"] = args.lm

        status = "DRY" if args.dry_run else ""

        if not args.dry_run:
            is_new = upsert_document(sb, doc)
            if not is_new:
                print(f"  SKIP  {pdf.name}  (unchanged content_hash)")
                total_skip += 1
                continue

            # Upload PDF to storage
            storage_path = f"{topic_id}/{pdf.name}"
            try:
                upload_pdf(sb, pdf, storage_path)
                sb.table("codex_documents").update(
                    {"storage_path": storage_path}
                ).eq("id", doc["id"]).execute()
            except Exception as e:
                print(f"  WARN  storage upload failed for {pdf.name}: {e}")

            n_los = upsert_los(sb, parsed["los_rows"])
            n_chunks = upsert_chunks(sb, parsed["chunk_rows"])
            total_new += 1
            total_los += n_los
            total_chunks += n_chunks
            status = "NEW"
        else:
            n_los = len(parsed["los_rows"])
            n_chunks = len(parsed["chunk_rows"])
            status = "DRY"

        print(
            f"  {status:<4}  {pdf.name:<50}  "
            f"topic={topic_id}  pages={doc['pages']}  "
            f"los={n_los}  chunks={n_chunks}"
        )

    print()
    if args.dry_run:
        print(f"Dry run complete. {len(pdfs)} PDF(s) parsed, no writes made.")
    else:
        print(
            f"Ingest complete. "
            f"new={total_new}  skipped={total_skip}  "
            f"los={total_los}  chunks={total_chunks}"
        )


if __name__ == "__main__":
    main()
