#!/usr/bin/env python3
"""
ingest/codex_docx.py — ATLAS Codex .docx ingest.

Structured Word notes carry the pedagogy the PDFs lost: real headings, real
tables, and explicit callout markers. Extracting from .docx therefore preserves
structure directly rather than trying to infer it from flattened text.

Expected document shape (see CODEX_SPEC.md):

    CFA LEVEL II | <Topic>            <- title block
    LM<n>: <Reading title>
    H1  LEARNING OUTCOMES            <- 2-col table: LOS n | Outcome
    H1  SECTION 1: <TITLE> (LOS 1)   <- one concept unit per H1 section
    H2  <sub-topic>                  <- becomes a sub-heading in prose
        <paragraphs>
        <multi-col table>            -> markdown pipe table
        <1x2 table, marker "!">      -> EXAM TRAP callout
        <1x2 table, titled>          -> formula / definition box
        <1-col table, titled>        -> titled card (worked example, steps)
    H1  SECTION n: EXAM TRAPS — LMx

Emitted markdown uses only constructs the reading pane already renders:
pipe tables, `#`/`##` headings, `-` lists and `EXAM TRAP:` / `KEY:` callouts.

Usage:
    python ingest/codex_docx.py notes/*.docx --dry-run
    python ingest/codex_docx.py notes/*.docx --emit-sql out.sql
    python ingest/codex_docx.py notes/*.docx          # direct Supabase write
"""

import argparse
import glob as globmod
import hashlib
import json
import os
import re
import sys

try:
    import docx
    from docx.table import Table
    from docx.text.paragraph import Paragraph
except ImportError:
    sys.exit("python-docx not installed — run: pip install python-docx")

TENANT = "00000000-0000-0000-0000-000000000000"

# filename/topic-line token -> codex_topics.id
TOPIC_MAP = {
    "QM": "quant", "QUANT": "quant", "QUANTITATIVE": "quant",
    "ETHICS": "eth", "ETH": "eth",
    "FI": "fi", "FIXED": "fi",
    "EQ": "eq", "EQUITY": "eq",
    "DER": "der", "DERIVATIVES": "der",
    "ALT": "alt", "ALTERNATIVE": "alt",
    "CORP": "corp", "CORPORATE": "corp",
    "FSA": "fsa",
    "ECO": "eco", "ECONOMICS": "eco",
    "PM": "pm", "PORTFOLIO": "pm",
}

# The notes were generated programmatically and carry meaning in cell SHADING,
# not in the marker glyph — the glyph is only a secondary cue and varies by
# document (! in QM, ✗/✓/⚠ in Ethics). Classifying on fill recovers box kinds
# that would otherwise flatten into anonymous tables: in Ethics LM2 alone, 155
# of 224 tables are compliance / violation / trap boxes.
FILL_SEMANTICS = {
    "C0392B": "trap",        # red — exam trap
    "8B3A00": "trap",        # dark orange — exam trap (Ethics)
    "8B0000": "violation",   # dark red — breach example
    "1A5C2A": "compliance",  # green — correct-conduct example
    "C5A028": "key",         # gold — key box
    "B8860B": "key",         # dark gold — key box
    "4A235A": "formula",     # purple — formula / procedures
    "1F3864": "section",     # navy — section header / verbatim standard
    "1E6B7A": "teal",        # teal — comparison table or worked example
}

GLYPH_SEMANTICS = {"!": "trap", "⚠": "trap", "⚠️": "trap",
                   "✗": "violation", "✘": "violation", "×": "violation",
                   "✓": "compliance", "✔": "compliance"}

CALLOUT_LABEL = {"trap": "EXAM TRAP", "violation": "VIOLATION",
                 "compliance": "COMPLIANCE", "key": "KEY"}


def cell_fill(cell):
    """Shading fill of a table cell, upper-cased, or None."""
    from docx.oxml.ns import qn
    tcPr = cell._tc.tcPr
    if tcPr is None:
        return None
    shd = tcPr.find(qn("w:shd"))
    if shd is None:
        return None
    fill = shd.get(qn("w:fill"))
    return fill.upper() if fill and fill not in ("auto",) else None


def table_semantics(tbl):
    """Semantic role of a table from its first cell's fill, then its glyph."""
    try:
        fill = cell_fill(tbl.rows[0].cells[0])
    except Exception:
        fill = None
    if fill and fill in FILL_SEMANTICS:
        return FILL_SEMANTICS[fill]
    marker = cell_text(tbl.rows[0].cells[0])
    return GLYPH_SEMANTICS.get(marker)


# ── docx traversal ────────────────────────────────────────────────────────────

def iter_blocks(doc):
    """Yield Paragraph and Table objects in document order."""
    for child in doc.element.body.iterchildren():
        if child.tag.endswith("}p"):
            yield Paragraph(child, doc)
        elif child.tag.endswith("}tbl"):
            yield Table(child, doc)


def style_name(p):
    try:
        return p.style.name or "Body"
    except Exception:
        return "Body"


def cell_text(c):
    return " ".join(c.text.split()).strip()


# ── markdown emitters ─────────────────────────────────────────────────────────

def md_escape_cell(s):
    return s.replace("|", "\\|")


def table_to_md(tbl):
    """Multi-column table -> GitHub pipe table."""
    rows = [[md_escape_cell(cell_text(c)) for c in r.cells] for r in tbl.rows]
    rows = [r for r in rows if any(r)]
    if len(rows) < 2:
        return ""
    width = max(len(r) for r in rows)
    rows = [r + [""] * (width - len(r)) for r in rows]
    head, body = rows[0], rows[1:]
    out = ["| " + " | ".join(head) + " |",
           "|" + "|".join(["---"] * width) + "|"]
    out += ["| " + " | ".join(r) + " |" for r in body]
    return "\n".join(out)


def card_to_md(tbl):
    """Single-column table -> titled card rendered as heading + list."""
    rows = [cell_text(r.cells[0]) for r in tbl.rows]
    rows = [r for r in rows if r]
    if not rows:
        return ""
    title, items = rows[0], rows[1:]
    if not items:
        return f"**{title}**"
    numbered = all(re.match(r"^step\s*\d+\b", it, re.I) for it in items)
    lines = [f"### {title}", ""]
    for it in items:
        if numbered:
            it = re.sub(r"^step\s*\d+\s*[:.\-–]\s*", "", it, flags=re.I)
        lines.append(f"- {it}")
    return "\n".join(lines)


def classify_2col(tbl):
    """
    A 1-row 2-column table is a callout (trap / violation / compliance / key)
    or a formula box. Fill decides; the marker glyph is the fallback.
    Returns (kind, label, body).
    """
    marker = cell_text(tbl.rows[0].cells[0])
    body = cell_text(tbl.rows[0].cells[1])
    sem = table_semantics(tbl)

    if sem in CALLOUT_LABEL:
        # a titled gold/purple box keeps its title; a bare glyph has none
        if sem == "key" and marker and marker not in GLYPH_SEMANTICS:
            return "callout", "KEY", f"**{marker}** — {body}"
        return "callout", CALLOUT_LABEL[sem], body

    if sem == "formula":
        label = marker if marker and marker not in GLYPH_SEMANTICS else "Formula"
        return "formula", label, body

    if marker in GLYPH_SEMANTICS:
        return "callout", CALLOUT_LABEL[GLYPH_SEMANTICS[marker]], body
    return "formula", marker or "Formula", body


# ── document -> units ─────────────────────────────────────────────────────────

LOS_IN_HEADING = re.compile(r"\(LOS\s*([0-9]+)", re.I)
LOS_ROW = re.compile(r"^LOS\s*([0-9]+)", re.I)
VERB = re.compile(
    r"^(describe|formulate|explain|calculate|interpret|evaluate|contrast|compare|"
    r"identify|determine|analyze|analyse|demonstrate|justify|recommend|estimate|"
    r"distinguish|discuss|define|apply)\b", re.I)


def unit_id(reading_id, ord_):
    return hashlib.sha1(f"unit:{reading_id}:{ord_}".encode()).hexdigest()[:16]


ROMAN = re.compile(r"^(?:M{0,3})(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})$")
MINOR = {"of", "the", "and", "in", "for", "to", "a", "an", "on", "or", "vs", "with"}


def smart_title(s):
    """
    Title-case an ALL-CAPS heading without destroying roman numerals or
    acronyms — plain .title() turns "STANDARD II" into "Standard Ii".
    """
    words = s.split()
    out = []
    for i, w in enumerate(words):
        core = w.strip("():,.—-")
        pad_l = w[:len(w) - len(w.lstrip("("))]
        pad_r = w[len(core) + len(pad_l):]
        if core and ROMAN.match(core):
            out.append(pad_l + core + pad_r)
        elif core.lower() in MINOR and i not in (0, len(words) - 1):
            out.append(pad_l + core.lower() + pad_r)
        else:
            out.append(pad_l + core.capitalize() + pad_r)
    return " ".join(out)


def parse_docx(path):
    """Returns dict with title, topic_token, los_rows, sections."""
    d = docx.Document(path)
    blocks = list(iter_blocks(d))

    title_lines, sections = [], []
    current = None
    seen_h1 = False

    for b in blocks:
        if isinstance(b, Paragraph):
            text = " ".join(b.text.split()).strip()
            if not text:
                continue
            s = style_name(b)
            if s == "Heading 1":
                seen_h1 = True
                current = {"title": text, "blocks": []}
                sections.append(current)
                continue
            if not seen_h1:
                title_lines.append(text)
                continue
            if current is not None:
                current["blocks"].append(("h2" if s == "Heading 2" else
                                          "h3" if s == "Heading 3" else "p", text))
        else:
            if current is not None:
                current["blocks"].append(("tbl", b))

    return {"title_lines": title_lines, "sections": sections}


def extract_los(sections):
    """Pull LOS rows from the LEARNING OUTCOMES section's table."""
    los = []
    for sec in sections:
        t = sec["title"].upper()
        if "LEARNING OUTCOME" not in t and "LOS CHECKLIST" not in t:
            continue
        for kind, b in sec["blocks"]:
            if kind != "tbl":
                continue
            for r in b.rows:
                cells = [cell_text(c) for c in r.cells]
                if len(cells) < 2:
                    continue
                m = LOS_ROW.match(cells[0])
                if not m:
                    continue
                text = cells[1]
                vm = VERB.match(text)
                los.append({
                    "los_num": int(m.group(1)),
                    "outcome": text,
                    "command_verb": vm.group(1).lower() if vm else None,
                })
    return los


def section_to_markdown(sec):
    """Render one H1 section's blocks to markdown + collected formula boxes."""
    parts, formulas = [], []
    for kind, b in sec["blocks"]:
        if kind == "h2":
            parts.append(f"\n## {b}")
        elif kind == "h3":
            parts.append(f"\n### {b}")
        elif kind == "p":
            # Inline ALL-CAPS lead-ins read as emphasis, not shouting
            parts.append(b)
        else:
            ncols, nrows = len(b.columns), len(b.rows)
            sem = table_semantics(b)
            if ncols == 2 and nrows == 1:
                sort, label, body = classify_2col(b)
                if sort == "callout":
                    parts.append(f"\n{label}: {body}")
                else:
                    formulas.append({"label": label, "expr": body, "where": ""})
            elif ncols == 1:
                rows = [cell_text(r.cells[0]) for r in b.rows]
                rows = [r for r in rows if r]
                if sem == "section" and len(rows) > 1:
                    # navy single-column blocks carry verbatim wording (the text
                    # of a Standard); a blockquote marks it as quoted, not gloss
                    parts.append("\n### " + rows[0])
                    parts.extend("> " + r for r in rows[1:])
                elif sem == "key" and len(rows) > 1:
                    parts.append(f"\nKEY: {rows[0]}")
                    parts.extend(f"- {r}" for r in rows[1:])
                else:
                    md = card_to_md(b)
                    if md:
                        parts.append("\n" + md)
            else:
                md = table_to_md(b)
                if md:
                    parts.append("\n" + md)
    return "\n\n".join(p for p in parts if p and p.strip()), formulas


def build_units(path, doc_id, topic_id, next_reading_id=None):
    parsed = parse_docx(path)
    sections = parsed["sections"]
    los_rows = extract_los(sections)

    units = []
    ordn = 0

    if los_rows:
        units.append({
            "id": unit_id(doc_id, ordn), "tenant_id": TENANT,
            "reading_id": doc_id, "topic_id": topic_id, "ord": ordn,
            "kind": "los", "title": "Learning Outcomes", "est_minutes": 2,
            "los_num": None,
            "payload": {"outcomes": [
                {"num": l["los_num"], "text": l["outcome"], "verb": l["command_verb"]}
                for l in sorted(los_rows, key=lambda x: x["los_num"])]},
            "source_chunk_ids": [],
        })
        ordn += 1

    all_formulas = []
    for sec in sections:
        st = sec["title"].upper()
        if "LEARNING OUTCOME" in st or "LOS CHECKLIST" in st:
            continue   # already emitted as the los unit
        prose, formulas = section_to_markdown(sec)
        all_formulas.extend(formulas)
        if not prose.strip() and not formulas:
            continue
        m = LOS_IN_HEADING.search(sec["title"])
        title = re.sub(r"^SECTION\s*\d+\s*[:.\-–]\s*", "", sec["title"], flags=re.I)
        title = re.sub(r"\s*\(LOS[^)]*\)\s*$", "", title).strip() or sec["title"]
        # source headings are upper-case for emphasis; title-case reads better
        if title.isupper():
            title = smart_title(title)
        units.append({
            "id": unit_id(doc_id, ordn), "tenant_id": TENANT,
            "reading_id": doc_id, "topic_id": topic_id, "ord": ordn,
            "kind": "concept", "title": title[:120],
            "est_minutes": max(4, min(14, len(prose) // 420 or 4)),
            "los_num": int(m.group(1)) if m else None,
            "payload": {"prose_md": prose, "formulas": formulas,
                        "illustration": None, "key_terms": []},
            "source_chunk_ids": [],
        })
        ordn += 1

    units.append({
        "id": unit_id(doc_id, ordn), "tenant_id": TENANT,
        "reading_id": doc_id, "topic_id": topic_id, "ord": ordn,
        "kind": "recap", "title": "Recap", "est_minutes": 3, "los_num": None,
        "payload": {
            "formulas": all_formulas[:8],
            "los_revisited": [l["los_num"] for l in sorted(los_rows, key=lambda x: x["los_num"])],
            "next_reading_id": next_reading_id,
        },
        "source_chunk_ids": [],
    })

    return parsed, los_rows, units


# ── identity ──────────────────────────────────────────────────────────────────

# Full curriculum topic names, as they appear in the "CFA LEVEL II | <Topic>"
# title line. This is the authoritative source — it is stated by the document
# rather than guessed from a filename.
TOPIC_NAMES = [
    ("QUANTITATIVE", "quant"), ("ECONOMIC", "eco"),
    ("FINANCIAL STATEMENT", "fsa"), ("CORPORATE ISSUER", "corp"),
    ("EQUITY", "eq"), ("FIXED INCOME", "fi"), ("DERIVATIVE", "der"),
    ("ALTERNATIVE", "alt"), ("PORTFOLIO MANAGEMENT", "pm"),
    ("ETHIC", "eth"),
]

# Subject keywords for filenames that name the reading rather than the topic.
# Ordered most specific first; matched against the whole filename.
FILENAME_SUBJECTS = [
    ("HEDGEFUND", "alt"), ("HEDGE_FUND", "alt"), ("REALESTATE", "alt"),
    ("REAL_ESTATE", "alt"), ("COMMODIT", "alt"), ("PRIVATE_CAPITAL", "alt"),
    ("INTERCORPORATE", "fsa"), ("FINANCIAL_INSTITUTION", "fsa"),
    ("QUALITY_FINANCIAL", "fsa"), ("EMPLOYEE_COMPENSATION", "fsa"),
    ("MULTINATIONAL", "fsa"),
    ("CONTINGENT_CLAIM", "der"), ("FORWARD_COMMITMENT", "der"),
    ("COSTOFCAPITAL", "corp"), ("COST_OF_CAPITAL", "corp"),
    ("CORPORATERESTRUCTURING", "corp"), ("RESTRUCTURING", "corp"),
    ("DIVIDENDS", "corp"), ("SHAREREPURCHASE", "corp"), ("ESG", "corp"),
    ("GOVERNANCE", "corp"),
    ("CURRENCY", "eco"), ("EXCHANGERATE", "eco"), ("ECONOMICGROWTH", "eco"),
    ("DISCOUNTED_DIVIDEND", "eq"), ("FREE_CASH_FLOW", "eq"),
    ("MARKET_BASED", "eq"), ("RESIDUAL_INCOME", "eq"),
    ("PRIVATE_COMPANY", "eq"), ("EQUITY", "eq"),
    ("YIELD_CURVE", "fi"), ("TERM_STRUCTURE", "fi"), ("CREDIT", "fi"),
]


def infer_topic(path, title_lines):
    """
    Topic from, in order: the document's own title line, an explicit token in
    the filename, then a subject keyword.

    Substring matching over the whole title was the original approach and was
    badly wrong — "EQ" matches inside "frEQuency", "FI" inside "FInancial" and
    "ETH" inside "mETHod", which filed Economics under Equity and Intercorporate
    Investments under Ethics.
    """
    # 1. "CFA LEVEL II | Quantitative Methods" — stated, not inferred
    for line in title_lines:
        if "|" in line:
            tail = line.split("|")[-1].strip().upper()
            for name, tid in TOPIC_NAMES:
                if name in tail:
                    return tid

    # 2. explicit token delimited in the filename (CFA_L2_QM_LM1_...)
    stem = os.path.splitext(os.path.basename(path))[0].upper()
    parts = set(re.split(r"[_\-\s]+", stem))
    for tok, tid in TOPIC_MAP.items():
        if tok in parts:
            return tid

    # 3. subject keyword anywhere in the filename
    for kw, tid in FILENAME_SUBJECTS:
        if kw in stem:
            return tid
    return None


def infer_reading(title_lines, path):
    for line in title_lines:
        if re.match(r"^(LM|READING)\s*\d+\s*[:.\-–]", line, re.I):
            return line
    stem = os.path.splitext(os.path.basename(path))[0]
    stem = re.sub(r"^[0-9a-f]{6,}-", "", stem)
    return re.sub(r"[_\-]+", " ", re.sub(r"^CFA_L2_", "", stem, flags=re.I)).strip()


def infer_lm(reading):
    m = re.search(r"\bLM\s*(\d+)", reading, re.I)
    return int(m.group(1)) if m else None


# ── SQL emission ──────────────────────────────────────────────────────────────

def q(s):
    if s is None:
        return "null"
    return "'" + str(s).replace("'", "''") + "'"


def write_supabase(sb, doc_meta, los_rows, units):
    """
    Write via PostgREST table operations rather than raw SQL — Supabase exposes
    no generic SQL endpoint, and service_role bypasses RLS for these tables.
    """
    d = doc_meta
    sb.table("codex_documents").upsert({
        "id": d["id"], "tenant_id": TENANT, "topic_id": d["topic_id"],
        "reading": d["reading"], "lm": d["lm"], "source_file": d["source_file"],
        "pages": 0, "los_count": len(los_rows),
        "section_count": d["section_count"], "chunk_count": 0,
        "content_hash": d["content_hash"], "ingest_method": "docx",
    }, on_conflict="id").execute()

    sb.table("codex_los").delete().eq("doc_id", d["id"]).execute()
    if los_rows:
        sb.table("codex_los").insert([{
            "id": hashlib.sha1(f"los:{d['id']}:{l['los_num']}".encode()).hexdigest()[:16],
            "tenant_id": TENANT, "doc_id": d["id"], "topic_id": d["topic_id"],
            "los_num": l["los_num"], "outcome": l["outcome"],
            "command_verb": l["command_verb"], "source": "docx",
        } for l in los_rows]).execute()

    # replaces the reading's units; cascades to codex_unit_progress for this
    # reading only, which is why re-running is safest before study begins
    sb.table("codex_units").delete().eq("reading_id", d["id"]).execute()
    for i in range(0, len(units), 25):
        sb.table("codex_units").insert(units[i:i + 25]).execute()


def emit_sql(doc_meta, los_rows, units):
    out = []
    d = doc_meta
    out.append(
        "insert into codex_documents (id, tenant_id, topic_id, reading, lm, source_file, "
        "pages, los_count, section_count, chunk_count, content_hash, ingest_method) values ("
        f"{q(d['id'])}, {q(TENANT)}, {q(d['topic_id'])}, {q(d['reading'])}, "
        f"{d['lm'] if d['lm'] is not None else 'null'}, {q(d['source_file'])}, 0, "
        f"{len(los_rows)}, {d['section_count']}, 0, {q(d['content_hash'])}, 'docx') "
        "on conflict (id) do update set reading=excluded.reading, lm=excluded.lm, "
        "los_count=excluded.los_count, section_count=excluded.section_count, "
        "ingest_method=excluded.ingest_method;")

    out.append(f"delete from codex_los where doc_id = {q(d['id'])};")
    for l in los_rows:
        lid = hashlib.sha1(f"los:{d['id']}:{l['los_num']}".encode()).hexdigest()[:16]
        out.append(
            "insert into codex_los (id, tenant_id, doc_id, topic_id, los_num, outcome, "
            f"command_verb, source) values ({q(lid)}, {q(TENANT)}, {q(d['id'])}, "
            f"{q(d['topic_id'])}, {l['los_num']}, {q(l['outcome'])}, "
            f"{q(l['command_verb'])}, 'docx') on conflict (id) do nothing;")

    out.append(f"delete from codex_units where reading_id = {q(d['id'])};")
    for u in units:
        out.append(
            "insert into codex_units (id, tenant_id, reading_id, topic_id, ord, kind, "
            "title, est_minutes, los_num, payload, source_chunk_ids) values ("
            f"{q(u['id'])}, {q(TENANT)}, {q(u['reading_id'])}, {q(u['topic_id'])}, "
            f"{u['ord']}, {q(u['kind'])}, {q(u['title'])}, {u['est_minutes']}, "
            f"{u['los_num'] if u['los_num'] is not None else 'null'}, "
            f"{q(json.dumps(u['payload'], ensure_ascii=False))}::jsonb, '{{}}');")
    return "\n".join(out)


# ── CLI ───────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description="ATLAS Codex .docx ingest")
    ap.add_argument("targets", nargs="+", help=".docx files, folders, or globs")
    ap.add_argument("--topic", help="Override topic_id")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--emit-sql", metavar="PATH", help="Write SQL instead of calling Supabase")
    args = ap.parse_args()

    # Accept a folder, a glob, or explicit files. A bare folder is searched
    # recursively, which is the friendliest form on Windows, where PowerShell
    # passes "*.docx" through literally rather than expanding it.
    paths, doc_only = [], []
    for t in args.targets:
        t = t.strip('"').strip("'")
        if os.path.isdir(t):
            for root, _dirs, files in os.walk(t):
                for f in files:
                    (paths if f.lower().endswith(".docx")
                     else doc_only if f.lower().endswith(".doc") else []
                     ).append(os.path.join(root, f))
        elif any(c in t for c in "*?["):
            paths.extend(globmod.glob(t, recursive=True))
        else:
            paths.append(t)

    paths = sorted({p for p in paths if p.lower().endswith(".docx")
                    and not os.path.basename(p).startswith("~$")})

    if not paths:
        print("No .docx files matched.\n")
        print("Pass the folder itself and it will be searched recursively, e.g.")
        print(r'    python ingest/codex_docx.py "C:\Users\you\Documents\CFA notes"')
        if doc_only:
            print(f"\nFound {len(doc_only)} legacy .doc file(s), which cannot be read.")
            print("Open each in Word and Save As .docx, then re-run.")
        sys.exit(1)

    sql_chunks, pending = [], []
    for path in paths:
        parsed = parse_docx(path)
        topic_id = args.topic or infer_topic(path, parsed["title_lines"])
        if not topic_id:
            print(f"!! {os.path.basename(path)}: could not infer topic — use --topic")
            continue
        reading = infer_reading(parsed["title_lines"], path)
        doc_id = hashlib.sha1((topic_id + os.path.basename(path)).encode()).hexdigest()[:16]

        _, los_rows, units = build_units(path, doc_id, topic_id)
        with open(path, "rb") as fh:
            content_hash = hashlib.sha256(fh.read()).hexdigest()

        doc_meta = {
            "id": doc_id, "topic_id": topic_id, "reading": reading,
            "lm": infer_lm(reading),
            "source_file": os.path.basename(path),
            "section_count": len(parsed["sections"]),
            "content_hash": content_hash,
        }

        kinds = {}
        for u in units:
            kinds[u["kind"]] = kinds.get(u["kind"], 0) + 1
        print(f"{os.path.basename(path)[:56]:58s} topic={topic_id:5s} "
              f"LOS={len(los_rows):2d} units={len(units):2d} {kinds}")

        if args.dry_run:
            for u in units[:3]:
                head = (u["payload"].get("prose_md") or "")[:180].replace("\n", " ⏎ ")
                print(f"    [{u['ord']}] {u['kind']:8s} {str(u['title'])[:44]:46s} {head}")
            continue

        if args.emit_sql:
            sql_chunks.append(emit_sql(doc_meta, los_rows, units))
        else:
            pending.append((doc_meta, los_rows, units))

    if args.emit_sql and sql_chunks:
        with open(args.emit_sql, "w") as fh:
            fh.write("\n".join(sql_chunks) + "\n")
        print(f"\nSQL written to {args.emit_sql}")
    elif pending:
        url = os.environ.get("SUPABASE_URL", "").rstrip("/")
        key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
        if not url or not key:
            sys.exit("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, or use --emit-sql.")
        from supabase import create_client
        sb = create_client(url, key)
        for doc_meta, los_rows, units in pending:
            write_supabase(sb, doc_meta, los_rows, units)
            print(f"  wrote {doc_meta['reading'][:50]} ({len(units)} units)")
        print(f"\nDone — {len(pending)} reading(s) written to Supabase.")


if __name__ == "__main__":
    main()
