#!/usr/bin/env python3
"""
ingest/codex_restructure.py — bulk restructure of PDF-flattened concept units.

PDF extraction flattened tables to one cell per line and lost heading levels.
Heuristics in the reading pane recover the cases with a detectable grid, but
they cannot recover cells that wrapped onto two lines with a capitalised
continuation ("Collateral" / "Return"), because no rule based on casing or
punctuation can tell that those are one cell. Restoring that needs a reader
that understands the material.

This sends each flattened unit to Claude with a strict restructure-only brief
and writes the result back to payload.prose_md, preserving the original in
payload.prose_md_raw so every change is reversible.

The model is asked to reformat, never to author. Output is rejected — and the
original kept — if any number in the source goes missing or any new number
appears, which is the failure mode that matters for exam material.

Usage:
    export SUPABASE_URL=https://<ref>.supabase.co
    export SUPABASE_SERVICE_ROLE_KEY=<key>
    export ANTHROPIC_API_KEY=<key>

    python ingest/codex_restructure.py --dry-run --limit 3   # inspect first
    python ingest/codex_restructure.py --limit 10            # a topic's worth
    python ingest/codex_restructure.py                       # whole corpus
    python ingest/codex_restructure.py --restore             # undo everything
"""

import argparse
import concurrent.futures as futures
import os
import re
import sys

try:
    from supabase import create_client
except ImportError:
    sys.exit("supabase-py not installed — run: pip install supabase")

DEFAULT_MODEL = "claude-sonnet-5"

PROMPT = """\
The text below is one section of CFA Level II study notes. It was extracted \
from a PDF, which destroyed the formatting: tables were flattened to one cell \
per line, heading levels were lost, and some cells wrapped onto two lines.

Restore the structure as markdown.

RULES — follow exactly:
1. Reformat only. Never add, remove, summarise or reword content.
2. Every number, percentage and term must appear in your output exactly as in \
the input. Do not round, correct or reorder values.
3. Where the text was a table, emit a GitHub pipe table. Work out the column \
count from the header cells, and remember a header or cell may have wrapped \
onto two lines ("Collateral" + "Return" is one cell, "Collateral Return").
4. Sub-headings become `##`. Bulleted points become `-` lists.
5. A point that is an exam warning becomes `EXAM TRAP: ...`; a point that is a \
key takeaway becomes `KEY: ...`. Only where the source clearly signals it.
6. If you cannot determine the structure with confidence, return the input \
UNCHANGED rather than guessing. A flat list is acceptable; a wrong table is not.
7. Output only the markdown. No preamble, no code fences, no commentary.

INPUT:
---
{body}
---"""

MINUS = "-−–—‐"
NUM = re.compile(r"([-+−–—‐]?)(\d[\d,]*(?:\.\d+)?)(%?)")


def numbers(text):
    """
    Multiset of signed numeric tokens, for verifying nothing was lost, invented
    or altered.

    The sign has to be part of the key. This corpus contains 274 numbers written
    with a Unicode minus and 138 with an explicit plus — including correlations
    like −0.11, where the sign carries the whole meaning. Matching only ASCII
    "-" would score −1.3% and 1.3% as identical and let a flipped sign through,
    which is precisely the corruption this guard exists to catch.

    A dash sitting directly after a digit is a range separator ("6.8–7.2"), not
    a sign, so it is not counted as one.
    """
    t = text or ""
    out = {}
    for m in NUM.finditer(t):
        sign, val, pct = m.group(1), m.group(2), m.group(3)
        if sign and m.start() > 0 and t[m.start() - 1].isdigit():
            sign = ""                      # range separator, not a sign
        if sign and sign in MINUS:
            sign = "-"                     # normalise the minus glyphs
        key = f"{sign}{val.replace(',', '')}{pct}"
        out[key] = out.get(key, 0) + 1
    return out


def looks_flattened(md):
    """Heuristic: mostly short lines, no existing table markup."""
    if not md or "|---" in md:
        return False
    lines = [l.strip() for l in md.split("\n") if l.strip()]
    if len(lines) < 8:
        return False
    short = sum(1 for l in lines if len(l) < 40 and not l.endswith((".", "!", "?")))
    return short / len(lines) >= 0.35


def restructure(client, model, unit):
    body = unit["payload"].get("prose_md") or ""
    try:
        msg = client.messages.create(
            model=model, max_tokens=8000,
            messages=[{"role": "user", "content": PROMPT.format(body=body)}],
        )
        out = "".join(b.text for b in msg.content if getattr(b, "type", "") == "text").strip()
    except Exception as e:
        return unit["id"], None, f"api error: {e}"

    out = re.sub(r"^```[a-z]*\n|\n```$", "", out).strip()
    if not out:
        return unit["id"], None, "empty response"

    before, after = numbers(body), numbers(out)
    missing = {k: v for k, v in before.items() if after.get(k, 0) < v}
    invented = {k: v for k, v in after.items() if before.get(k, 0) < v}
    if missing or invented:
        return unit["id"], None, f"number mismatch (missing {len(missing)}, new {len(invented)})"
    if len(out) < len(body) * 0.55:
        return unit["id"], None, "output too short — content likely dropped"

    return unit["id"], out, None


def main():
    ap = argparse.ArgumentParser(description="Bulk restructure flattened concept units")
    ap.add_argument("--topic", help="Limit to one topic_id")
    ap.add_argument("--limit", type=int, help="Process at most N units")
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--all", action="store_true",
                    help="Process every concept unit, not just flattened-looking ones")
    ap.add_argument("--dry-run", action="store_true", help="Print, do not write")
    ap.add_argument("--restore", action="store_true",
                    help="Revert every unit to its saved prose_md_raw")
    args = ap.parse_args()

    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not url or not key:
        sys.exit("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.")
    sb = create_client(url, key)

    q = sb.table("codex_units").select("id, topic_id, title, payload").eq("kind", "concept")
    if args.topic:
        q = q.eq("topic_id", args.topic)
    units = q.execute().data or []

    if args.restore:
        n = 0
        for u in units:
            raw = u["payload"].get("prose_md_raw")
            if not raw:
                continue
            p = dict(u["payload"])
            p["prose_md"] = raw
            p.pop("prose_md_raw", None)
            sb.table("codex_units").update({"payload": p}).eq("id", u["id"]).execute()
            n += 1
        print(f"Restored {n} unit(s) to their original text.")
        return

    # already-restructured units carry prose_md_raw; skip them so re-runs are safe
    todo = [u for u in units
            if not u["payload"].get("prose_md_raw")
            and (args.all or looks_flattened(u["payload"].get("prose_md")))]
    if args.limit:
        todo = todo[: args.limit]

    print(f"{len(units)} concept units, {len(todo)} to restructure "
          f"(model {args.model}, {args.workers} workers)\n")
    if not todo:
        return

    try:
        import anthropic
    except ImportError:
        sys.exit("anthropic not installed — run: pip install anthropic")
    client = anthropic.Anthropic()

    ok = skipped = 0
    with futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        jobs = {pool.submit(restructure, client, args.model, u): u for u in todo}
        for fut in futures.as_completed(jobs):
            u = jobs[fut]
            uid, out, err = fut.result()
            label = (u.get("title") or uid)[:44]
            if err:
                skipped += 1
                print(f"  skip  {label:46s} {err}")
                continue
            ok += 1
            tables = out.count("|---")
            print(f"  ok    {label:46s} {tables} table(s)")
            if args.dry_run:
                # the point of a dry run is to read the markdown before it is
                # written, so print it rather than only counting tables
                print("  " + "─" * 72)
                for line in out.split("\n"):
                    print("  │ " + line)
                print("  " + "─" * 72 + "\n")
                continue
            p = dict(u["payload"])
            p["prose_md_raw"] = p.get("prose_md", "")
            p["prose_md"] = out
            sb.table("codex_units").update({"payload": p}).eq("id", uid).execute()

    print(f"\n{ok} restructured, {skipped} left unchanged."
          + ("  (dry run — nothing written)" if args.dry_run else
             "\nRevert at any time with: python ingest/codex_restructure.py --restore"))


if __name__ == "__main__":
    main()
