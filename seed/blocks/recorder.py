"""
Shadows the builder API used by pdf_lm*.py, but records structured blocks
instead of emitting HTML. Same content source, different target.

Run:  python3 emit_blocks.py
"""
import json, re
from pathlib import Path

_units = []      # [{ordinal, title, blocks:[...]}]
_meta  = {}

def reset():
    _units.clear(); _meta.clear()

# ---------- leaf constructors: every one returns a tagged dict ----------
def p(text):            return {"_t": "prose", "text": text}
def para(text):         return p(text)
def lead(text):         return {"_t": "lead", "text": text}
def ul(items):          return {"_t": "list_bullet", "items": list(items)}
def ol(items):          return {"_t": "list_ordered", "items": list(items)}
def step(text):         return {"_t": "step", "text": text}
def ans(text):          return {"_t": "ans", "text": text}
def srcnote(text):      return {"_t": "srcnote", "text": text}
def endcap(text):       return {"_t": "endcap", "text": text}

def formula(expr, label=None):
    d = {"_t": "formula", "expr": expr}
    if label: d["label"] = label
    return d

def _callout(kind, paras):
    return {"_t": kind, "paras": [x for x in paras]}

def key(*paras):  return _callout("key", paras)
def trap(*paras): return _callout("trap", paras)
def exam(*paras): return _callout("exam", paras)

def table(headers, rows, cls="", aligns=None):
    """builder.table accepts rows where an entry may be (row_list, 'tot')."""
    clean, totals = [], []
    for i, r in enumerate(rows):
        if isinstance(r, tuple) and len(r) == 2 and r[1] == 'tot':
            clean.append(list(r[0])); totals.append(i)
        else:
            clean.append(list(r))
    d = {"_t": "table", "headers": list(headers), "rows": clean}
    if aligns: d["aligns"] = list(aligns)
    if totals: d["total_rows"] = totals
    if cls:    d["variant"] = cls
    return d

def worked(title, *blocks):
    inner, answer = [], None
    for b in blocks:
        if not isinstance(b, dict):
            continue
        if b["_t"] == "ans":
            answer = b["text"]; continue
        kind = {"prose": "prose", "list_bullet": "list", "list_ordered": "list",
                "table": "table", "step": "step", "formula": "formula"}.get(b["_t"])
        if kind is None:
            continue
        c = {k: v for k, v in b.items() if k != "_t"}
        c["kind"] = kind
        inner.append(c)
    d = {"_t": "worked", "title": title, "blocks": inner}
    if answer: d["answer"] = answer
    return d

# ---------- headings: h1 opens a new unit ----------
def h1(num, text, first=False):
    _units.append({"ordinal": num, "title": text, "blocks": []})
    return {"_t": "_h1", "idx": len(_units) - 1}

def h2(text): return {"_t": "heading_2", "text": text}
def h3(text): return {"_t": "heading_3", "text": text}

# ---------- assembly ----------
_TOP = {
    "lead": "lead", "prose": "prose",
    "heading_2": "heading_2", "heading_3": "heading_3",
    "list_bullet": "list_bullet", "list_ordered": "list_ordered",
    "formula": "formula", "key": "key", "trap": "trap", "exam": "exam",
    "worked": "worked", "srcnote": "prose",
}

def _to_block(d, ordinal):
    t = d["_t"]
    if t == "table":
        bt = {"cmp": "table_compare", "sig": "table_signal"}.get(d.get("variant"), "table_data")
        payload = {k: v for k, v in d.items() if k not in ("_t", "variant")}
    else:
        bt = _TOP[t]
        payload = {k: v for k, v in d.items() if k != "_t"}
    return {"ord": ordinal, "block_type": bt, "payload": payload}

def render(outpath, modnum, topic, title, subtitle, footer, body_blocks, running_title):
    """Signature matches builder.render; writes block JSON instead of a PDF."""
    cur = None
    for item in body_blocks:
        if not isinstance(item, dict):
            continue
        if item["_t"] == "_h1":
            cur = _units[item["idx"]]
            continue
        if item["_t"] == "endcap":
            continue
        if cur is None:
            continue
        cur["blocks"].append(item)

    out = {
        "topic_id": "alt",
        "module": f"LM{modnum}",
        "module_title": title.replace("\n", " "),
        "source_ref": f"CFA 2026 L2 V8/LM{modnum}",
        "units": []
    }
    for u in _units:
        blocks = [_to_block(d, i + 1) for i, d in enumerate(u["blocks"])]
        out["units"].append({"ordinal": u["ordinal"], "title": u["title"], "blocks": blocks})

    # write next to this script, so regeneration updates the committed
    # artifacts instead of an absolute path that only exists on one machine
    stem = Path(outpath).name
    stem = stem[:-4] if stem.endswith(".pdf") else stem
    dest = str(Path(__file__).resolve().with_name(f"blocks_{stem}.json"))
    with open(dest, "w", encoding="utf8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)

    nb = sum(len(u["blocks"]) for u in out["units"])
    print(f"LM{modnum}: {len(out['units'])} units, {nb} blocks -> {dest.split('/')[-1]}")
    return dest
