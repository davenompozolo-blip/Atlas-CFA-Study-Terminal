import { h, render, Fragment } from "preact";
import { useState, useEffect, useCallback, useRef } from "preact/hooks";
import { createClient } from "@supabase/supabase-js";

// ── Supabase client ────────────────────────────────────────────────────────────

let _sb = null;
async function getClient() {
  if (_sb) return _sb;
  const res = await fetch("/api/config");
  if (!res.ok) throw new Error("Could not load Supabase config");
  const { url, key } = await res.json();
  if (!url || !key) throw new Error("Supabase config empty — check Vercel env vars");
  _sb = createClient(url, key);
  return _sb;
}

// ── Theme ──────────────────────────────────────────────────────────────────────

const THEME_KEY = "codex-theme";

function getStoredTheme() {
  try { return localStorage.getItem(THEME_KEY) || "dark"; } catch { return "dark"; }
}
function setStoredTheme(t) {
  try { localStorage.setItem(THEME_KEY, t); } catch {}
  document.documentElement.setAttribute("data-theme", t);
}

function applyTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
}

// ── Hash router ────────────────────────────────────────────────────────────────

function useRoute() {
  const [hash, setHash] = useState(window.location.hash || "#/");
  useEffect(() => {
    const onHash = () => setHash(window.location.hash || "#/");
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return hash;
}
function navigate(hash) { window.location.hash = hash; }

// ── Resume ─────────────────────────────────────────────────────────────────────

function getResume(docId) {
  try { return parseInt(localStorage.getItem(`codex-resume-${docId}`) || "0", 10); } catch { return 0; }
}
function setResume(docId, ord) {
  try { localStorage.setItem(`codex-resume-${docId}`, String(ord)); } catch {}
}

// ── Shared helpers ─────────────────────────────────────────────────────────────

function Loader() {
  return h("div", { class: "loader" },
    h("div", { class: "loader-dot" }),
    h("div", { class: "loader-dot" }),
    h("div", { class: "loader-dot" }),
  );
}
function ErrorBox({ msg }) {
  return h("div", { class: "error-box" }, `Error: ${msg}`);
}
function Chip({ band }) {
  return h("span", { class: `chip chip-${band}` }, band.toUpperCase());
}
function MasteryBar({ value }) {
  const pct = Math.min(100, Math.max(0, value || 0));
  const cls = pct < 40 ? "low" : pct < 65 ? "mid" : "";
  return h("div", { class: "mastery-bar-wrap" },
    h("div", { class: "mastery-bar" },
      h("div", { class: `mastery-fill ${cls}`, style: { width: `${pct}%` } })
    ),
    h("span", { class: "mastery-val" }, `${Math.round(pct)}%`),
  );
}

const KIND_ICON = { los: "📋", concept: "💡", example: "🔍", practice: "✏️", recap: "🎯" };
const KIND_LABEL = { los: "Outcomes", concept: "Concept", example: "Example", practice: "Practice", recap: "Recap" };

// ── SM-2 ───────────────────────────────────────────────────────────────────────

function sm2Next(quality, prevEF, prevInterval) {
  const ef = Math.max(1.3, prevEF + 0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
  let interval = prevInterval <= 1 ? (quality < 3 ? 1 : 1)
    : prevInterval === 1 ? (quality < 3 ? 1 : 6)
    : Math.round(prevInterval * ef);
  if (quality < 3) interval = 1;
  return { ef, interval, nextDue: new Date(Date.now() + interval * 86400000).toISOString() };
}

// ── Home / Deficit Board ───────────────────────────────────────────────────────

function Home() {
  const [topics, setTopics] = useState(null);
  const [docs, setDocs] = useState({});
  const [open, setOpen] = useState({});
  const [err, setErr] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const sb = await getClient();
        const { data, error } = await sb.from("vw_codex_priority").select("*");
        if (error) throw error;
        setTopics(data);
      } catch (e) { setErr(e.message); }
    })();
  }, []);

  const loadDocs = useCallback(async (topicId) => {
    if (docs[topicId]) return;
    const sb = await getClient();
    const { data } = await sb.from("codex_documents")
      .select("id, reading, lm, chunk_count, los_count")
      .eq("topic_id", topicId)
      .order("lm", { ascending: true, nullsFirst: false });
    setDocs(prev => ({ ...prev, [topicId]: data || [] }));
  }, [docs]);

  const toggle = useCallback((topicId) => {
    const nowOpen = !open[topicId];
    setOpen(prev => ({ ...prev, [topicId]: nowOpen }));
    if (nowOpen) loadDocs(topicId);
  }, [open, loadDocs]);

  if (err) return h(ErrorBox, { msg: err });
  if (!topics) return h(Loader);

  const crit = topics.filter(t => t.band === "crit");
  const totalFocus = topics.reduce((s, t) => s + Number(t.focus_index || 0), 0);
  const avgMastery = topics.length
    ? Math.round(topics.reduce((s, t) => s + Number(t.avg_mastery || 0), 0) / topics.length)
    : 0;

  return h(Fragment, null,
    h("div", { class: "page-title" }, "Deficit Board"),
    h("div", { class: "page-sub" }, "Focus where it hurts most. Ordered by exam-weight × mastery gap."),
    h("div", { class: "stat-row" },
      h("div", { class: "stat-card" },
        h("div", { class: "stat-label" }, "Avg Mastery"),
        h("div", { class: `stat-value ${avgMastery < 50 ? "red" : avgMastery < 68 ? "amber" : ""}` }, `${avgMastery}%`),
      ),
      h("div", { class: "stat-card" },
        h("div", { class: "stat-label" }, "Crit Topics"),
        h("div", { class: "stat-value red" }, crit.length),
      ),
      h("div", { class: "stat-card" },
        h("div", { class: "stat-label" }, "Total Focus Index"),
        h("div", { class: "stat-value amber" }, Math.round(totalFocus)),
      ),
      h("div", { class: "stat-card" },
        h("div", { class: "stat-label" }, "Target Date"),
        h("div", { class: "stat-value" }, "19 Nov"),
      ),
    ),
    h("div", { class: "topic-grid" },
      topics.map(t =>
        h(TopicRow, {
          key: t.topic_id, topic: t,
          isOpen: !!open[t.topic_id],
          onToggle: () => toggle(t.topic_id),
          docs: docs[t.topic_id] || null,
        })
      )
    ),
  );
}

function TopicRow({ topic, isOpen, onToggle, docs }) {
  const focusHigh = Number(topic.focus_index) > 200;
  return h("div", { class: `topic-row ${topic.band} ${isOpen ? "open" : ""}` },
    h("div", { class: "topic-header", onClick: onToggle },
      h("div", { class: "topic-name" }, topic.name, h(Chip, { band: topic.band })),
      h(MasteryBar, { value: topic.avg_mastery }),
      h("span", { class: `focus-score ${focusHigh ? "high" : ""}` }, `${Number(topic.focus_index).toFixed(0)} fi`),
      h("span", { class: "expand-icon" }, "▼"),
    ),
    h("div", { class: "readings-panel" },
      docs === null ? h(Loader)
        : docs.length === 0
          ? h("div", { style: { color: "var(--text-3)", fontSize: 13 } }, "No documents loaded.")
          : h("div", { class: "readings-grid" },
              docs.map(doc =>
                h("div", {
                  key: doc.id, class: "reading-card",
                  onClick: () => navigate(`#/read/${doc.id}`),
                },
                  h("div", { class: "reading-title" }, readingTitle(doc)),
                  h("div", { class: "reading-meta" },
                    readingMeta(doc).map((m, k) =>
                      h("span", { key: k, class: "reading-meta-item" }, m)),
                  ),
                )
              )
            )
    ),
  );
}

// ── Reading pane shell ─────────────────────────────────────────────────────────

function ReadingPane({ docId, theme, onToggleTheme }) {
  const [doc, setDoc] = useState(null);
  const [units, setUnits] = useState(null);
  const [blocks, setBlocks] = useState({});
  const [progress, setProgress] = useState({});  // unit_id → progress row
  const [unitIdx, setUnitIdx] = useState(() => getResume(docId));
  const [err, setErr] = useState(null);
  const TENANT = "00000000-0000-0000-0000-000000000000";

  useEffect(() => {
    setUnitIdx(getResume(docId));
    setUnits(null);
    setErr(null);
    (async () => {
      try {
        const sb = await getClient();
        const [docRes, unitsRes, progRes, blockRes] = await Promise.all([
          sb.from("codex_documents").select("*, codex_topics(name,band)").eq("id", docId).single(),
          sb.from("codex_units").select("*").eq("reading_id", docId).order("ord"),
          sb.from("codex_unit_progress").select("*").eq("tenant_id", TENANT),
          sb.from("codex_blocks").select("unit_id, ord, block_type, payload").order("ord"),
        ]);
        if (docRes.error) throw docRes.error;
        setDoc(docRes.data);

        const byUnit = {};
        for (const b of (blockRes.data || [])) (byUnit[b.unit_id] ||= []).push(b);
        setBlocks(byUnit);

        // A third of the corpus is scaffolding rather than study material —
        // ungenerated practice items, the PDF's own table of contents, empty
        // example prompts. Walking into one mid-reading breaks the thread and
        // makes the whole thing feel unfinished, so they are kept out of the
        // sequence. Nothing is deleted: the rows stay, and a unit starts
        // appearing the moment it has content.
        const all = unitsRes.data || [];
        const live = all.filter(u => isStudyable(u, byUnit[u.id]));
        // never strand a reading — if the filter would empty it, show it whole
        setUnits(live.length ? live : all);

        const prog = {};
        for (const p of (progRes.data || [])) prog[p.unit_id] = p;
        setProgress(prog);
      } catch (e) { setErr(e.message); }
    })();
  }, [docId]);

  const markViewed = useCallback(async (unit) => {
    if (!unit || progress[unit.id]?.status === "done") return;
    try {
      const sb = await getClient();
      await sb.from("codex_unit_progress").upsert({
        tenant_id: TENANT,
        unit_id: unit.id,
        status: "viewed",
        last_viewed: new Date().toISOString(),
      }, { onConflict: "tenant_id,unit_id" });
      setProgress(p => ({ ...p, [unit.id]: { ...p[unit.id], status: "viewed", last_viewed: new Date().toISOString() } }));
    } catch {}
  }, [progress]);

  const goTo = useCallback((idx) => {
    const clamped = Math.max(0, Math.min((units?.length || 1) - 1, idx));
    setUnitIdx(clamped);
    setResume(docId, clamped);
    window.scrollTo({ top: 0, behavior: "smooth" });
    if (units?.[clamped]) markViewed(units[clamped]);
  }, [units, docId, markViewed]);

  // Mark current unit viewed on load
  useEffect(() => {
    if (units && units[unitIdx]) markViewed(units[unitIdx]);
  }, [units, unitIdx]);

  if (err) return h(ErrorBox, { msg: err });
  if (!doc || !units) return h("div", { class: "read-loading" }, h(Loader));

  const topicName = doc.codex_topics?.name || "";
  const topicBand = doc.codex_topics?.band || "hold";
  const unit = units[unitIdx] ?? null;
  const totalUnits = units.length;
  const doneCount = units.filter(u => progress[u.id]?.status === "done").length;
  const estLeft = units
    .filter((u, i) => i >= unitIdx)
    .reduce((s, u) => s + (u.est_minutes || 0), 0);

  const prevUnit = unitIdx > 0 ? units[unitIdx - 1] : null;
  const nextUnit = unitIdx < totalUnits - 1 ? units[unitIdx + 1] : null;

  return h("div", { class: "reading-shell" },
    // ── Reading header ──────────────────────────────────────────────────────
    h("div", { class: "read-header" },
      h("button", { class: "read-back-btn", onClick: () => navigate("#/") }, "← Back"),
      h("div", { class: "read-header-meta" },
        h(Chip, { band: topicBand }),
        h("span", null, topicName),
        doc.lm && h("span", null, `Module ${doc.lm}`),
      ),
      h("button", {
        class: "theme-toggle",
        onClick: onToggleTheme,
        title: theme === "dark" ? "Switch to light mode" : "Switch to dark mode",
      }, theme === "dark" ? "☀" : "🌙"),
    ),

    h("div", { class: "read-title" }, readingTitle(doc)),

    // ── Progress rail ───────────────────────────────────────────────────────
    h("div", { class: "read-rail" },
      h("div", { class: "read-rail-bar" },
        units.map((u, i) =>
          h("div", {
            key: u.id,
            class: `read-rail-seg ${progress[u.id]?.status || "untouched"} ${i === unitIdx ? "current" : ""}`,
            title: `${KIND_LABEL[u.kind]}: ${u.title || ""}`,
            onClick: () => goTo(i),
          })
        )
      ),
      h("div", { class: "read-rail-info" },
        h("span", null, `${unitIdx + 1} of ${totalUnits}`),
        h("span", null, `~${estLeft} min left`),
        doneCount > 0 && h("span", { class: "read-rail-done" }, `${doneCount} done`),
      ),
    ),

    // ── Unit content ────────────────────────────────────────────────────────
    totalUnits === 0
      ? h("div", { class: "read-no-units" },
          h("div", { class: "read-no-units-title" }, "Units not generated yet"),
          h("p", null, "Run the unit generator to create lesson units for this reading:"),
          h("pre", { class: "read-cmd" },
            `python ingest/codex_units_gen.py --doc-id ${docId}`
          ),
        )
      : unit
        ? h(UnitShell, { unit, progress: progress[unit.id], docId, blocks: blocks[unit.id],
            onMarkDone: async (unitId, conf) => {
              try {
                const sb = await getClient();
                await sb.from("codex_unit_progress").upsert({
                  tenant_id: TENANT,
                  unit_id: unitId,
                  status: "done",
                  confidence: conf || null,
                  last_viewed: new Date().toISOString(),
                }, { onConflict: "tenant_id,unit_id" });
                setProgress(p => ({ ...p, [unitId]: { ...p[unitId], status: "done", confidence: conf } }));
              } catch {}
            },
          })
        : null,

    // ── Prev / Next navigation ──────────────────────────────────────────────
    totalUnits > 0 && h("div", { class: "read-nav" },
      h("button", {
        class: "read-nav-btn prev",
        disabled: !prevUnit,
        onClick: () => goTo(unitIdx - 1),
      },
        "←",
        prevUnit && h("span", { class: "read-nav-label" },
          h("span", { class: "read-nav-kind" }, KIND_ICON[prevUnit.kind]),
          prevUnit.title || KIND_LABEL[prevUnit.kind],
        ),
      ),
      h("button", {
        class: "read-nav-btn next",
        disabled: !nextUnit,
        onClick: () => goTo(unitIdx + 1),
      },
        nextUnit && h("span", { class: "read-nav-label" },
          h("span", { class: "read-nav-kind" }, KIND_ICON[nextUnit.kind]),
          nextUnit.title || KIND_LABEL[nextUnit.kind],
        ),
        "→",
      ),
    ),
  );
}

// ── Unit shell (stub renderer — full renderers in PR9) ────────────────────────

function UnitShell({ unit, progress, docId, onMarkDone, blocks }) {
  const [conf, setConf] = useState(progress?.confidence || null);
  const isDone = progress?.status === "done";

  const handleConfidence = async (c) => {
    setConf(c);
    await onMarkDone(unit.id, c);
  };

  return h("div", { class: `unit-shell unit-${unit.kind}` },
    h("div", { class: "unit-kind-badge" },
      h("span", { class: "unit-kind-icon" }, KIND_ICON[unit.kind]),
      h("span", { class: "unit-kind-label" }, KIND_LABEL[unit.kind]),
      unit.est_minutes && h("span", { class: "unit-est" }, `~${unit.est_minutes} min`),
    ),
    unit.title && h("h2", { class: "unit-title" }, unit.title),

    h(UnitRenderer, { unit, blocks }),

    // Confidence control (not on practice/recap — those have their own gates)
    unit.kind !== "practice" && unit.kind !== "recap" && unit.kind !== "los" &&
      h("div", { class: "unit-confidence" },
        h("div", { class: "unit-confidence-label" }, "How well do you know this?"),
        h("div", { class: "unit-confidence-btns" },
          [
            { key: "got",    label: "Got it",  cls: "green" },
            { key: "shaky",  label: "Shaky",   cls: "amber" },
            { key: "review", label: "Review",  cls: "red"   },
          ].map(({ key, label, cls }) =>
            h("button", {
              key,
              class: `conf-btn ${cls} ${conf === key ? "active" : ""}`,
              onClick: () => handleConfidence(key),
            }, label)
          )
        ),
        isDone && h("span", { class: "unit-done-badge" }, "✓ Done"),
      ),
  );
}

// ── Unit renderer (basic — full polish in PR9) ────────────────────────────────

// ── typed content blocks ─────────────────────────────────────────────────────
// codex_blocks replaces the prose_md blob for concept units. Rendering switches
// on block_type so each kind can be styled differently — the whole point of the
// typing.
//
// SECURITY: payload text carries authored inline markup (<strong>, <em>), so it
// cannot simply be escaped or the tags would show literally. The upstream
// renderer passes it through raw, which is safe only while the corpus is
// hand-authored. Rather than inherit that, this escapes everything and then
// restores a fixed allowlist of inline tags. Attributes cannot survive the
// round trip, so <img src=x onerror=...> and friends stay inert even if
// user-generated content ever reaches this path.
const INLINE_ALLOWED = "strong|em|b|i|code|sub|sup|br|u";

function safeInline(html) {
  const escaped = String(html ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return escaped.replace(
    new RegExp(`&lt;(/?)(${INLINE_ALLOWED})\\s*/?&gt;`, "gi"),
    (_m, slash, tag) => `<${slash}${tag.toLowerCase()}>`);
}

// ── dead-unit suppression ────────────────────────────────────────────────────
// A table-of-contents entry is unmistakable: a dot leader running to a page
// number. The PDF extractor pulled whole contents pages in as body text, so
// these lines are stripped before anything is measured or rendered.
const TOC_LINE = /\.{4,}\s*\d*\s*$/;

function stripToc(md) {
  return String(md || "")
    .split("\n")
    .filter(l => !TOC_LINE.test(l.trim()) && !/^[.\s]+$/.test(l))
    .join("\n");
}

const PLACEHOLDER = /^placeholder\b/i;

// Whether a unit is worth stepping through. Deliberately conservative: it must
// be positively empty or positively scaffolding to be dropped, so a terse but
// real unit still shows.
function isStudyable(unit, blocks) {
  const p = unit.payload || {};
  switch (unit.kind) {
    case "practice":
      return Boolean(p.question) && (p.choices || []).length > 0
             && !(p.choices || []).some(c => PLACEHOLDER.test(c.text || ""));
    case "example":
      return (p.prompt || "").trim().length >= 12;
    case "concept":
      if (blocks && blocks.length) return true;
      return stripToc(p.prose_md).replace(/\s+/g, " ").trim().length >= 120;
    case "los":
      return (p.outcomes || []).length > 0;
    default:
      return true;   // recap and anything new: never hidden by this rule
  }
}

// ── heading labels and lead-ins ──────────────────────────────────────────────
// The notes lean on short label phrases — "Tax treatment", "Asset focus",
// "Key characteristic driving return:" — to open a section, a definition or an
// example. PDF extraction stripped the styling that set them apart, so they
// arrive as ordinary sentences and the page reads as one undifferentiated
// block. These two shapes are recoverable without guessing at meaning:
//
//   a "Term: definition" opener, where the punctuation survived; and
//   a short, unterminated line standing on its own, where it did not.
//
// Both are marked, never reworded. Nothing is inserted that was not already in
// the text — only the emphasis the source lost.
const LEADIN_RE = /^([^:<>]{2,60}):[ \t]+(?=\S)/;
const LABEL_RE = /^[A-Z][A-Za-z0-9()&/'’,.\- ]{1,46}$/;

function isLabelText(s) {
  const t = String(s || "").trim();
  // a trailing full stop means it is a sentence, however short
  if (!LABEL_RE.test(t) || /[.,;:!?&/-]$/.test(t)) return false;
  return t.split(/\s+/).length <= 6 && /[a-z]/.test(t);
}

// Operates on already-sanitised HTML, and only ever inserts our own markup —
// the matched label is a run of plain text, so no tag can be split.
function markLeadIn(html) {
  const m = String(html || "").match(LEADIN_RE);
  if (!m || m[1].split(/\s+/).length > 8 || /[.!?]/.test(m[1])) return html;
  return `<span class="lead-in">${m[1]}</span> ${html.slice(m[0].length)}`;
}

function rawHtml(cls, html, leadIn) {
  const safe = safeInline(html);
  return h("div", {
    class: cls,
    dangerouslySetInnerHTML: { __html: leadIn ? markLeadIn(safe) : safe },
  });
}

// Every authored string carries inline markup — subscripts and superscripts
// especially, since a formula is unreadable without them. Passing one as a
// child hands it to Preact, which escapes it, and "DF<sub>B</sub>" reaches the
// page as visible tag text. Authored text goes through safeInline instead, in
// any element.
function inlineText(tag, cls, text) {
  return h(tag, { class: cls, dangerouslySetInnerHTML: { __html: safeInline(text) } });
}

function BlockTable({ payload, cls }) {
  const headers = payload.headers || [];
  const aligns = payload.aligns || [];
  const rows = payload.rows || [];
  return h("div", { class: "md-table-wrap" },
    h("table", { class: `md-table ${cls || ""}` },
      headers.length > 0 && h("thead", null,
        h("tr", null, headers.map((c, i) =>
          // headers are plain text, passed as a child so Preact escapes them;
          // safeInline is for the cells, which do carry authored markup
          h("th", { key: i, class: aligns[i] === "num" ? "num" : "" }, c)))),
      h("tbody", null,
        rows.map((r, ri) =>
          h("tr", { key: ri, class: payload.total_rows?.includes(ri) ? "total-row" : "" },
            (r || []).map((c, ci) =>
              h("td", {
                key: ci,
                class: aligns[ci] === "num" ? "num" : "",
                dangerouslySetInnerHTML: { __html: safeInline(c) },
              }))))),
    ));
}

function WorkedBlock({ payload }) {
  return h("div", { class: "blk-worked" },
    payload.title && inlineText("div", "blk-worked-title", payload.title),
    // The excerpt is the vignette as it appears in the reading. It is quoted,
    // not paraphrased, so it is set apart from the intro and from the working.
    payload.excerpt && h("blockquote", { class: "blk-excerpt" },
      rawHtml("", payload.excerpt),
      payload.source_ref && h("cite", { class: "blk-excerpt-src" }, payload.source_ref)),
    payload.intro && rawHtml("blk-worked-intro", payload.intro, true),
    (payload.blocks || []).map((b, i) => {
      if (b.kind === "table")   return h(BlockTable, { key: i, payload: b, cls: b.variant || "" });
      if (b.kind === "step")    return rawHtml("blk-step", b.text, true);
      // a nested list carries `items`, not `text` — falling through to the
      // prose branch would render it as an empty box
      if (b.kind === "list" || b.kind === "list_ordered")
        return h(b.kind === "list_ordered" ? "ol" : "ul",
          { key: i, class: "md-list blk-list" },
          (b.items || []).map((it, j) =>
            h("li", { key: j, dangerouslySetInnerHTML: { __html: markLeadIn(safeInline(it)) } })));
      if (b.kind === "formula") return h("div", { key: i, class: "blk-formula" },
                                        inlineText("div", "blk-formula-expr", b.expr));
      return rawHtml("blk-prose", b.text, true);
    }),
    payload.answer && h("div", { class: "blk-answer" },
      h("span", { class: "blk-answer-label" }, "Answer "),
      inlineText("span", "", payload.answer)),
  );
}

const CALLOUT_BLOCK = { key: ["blk-key", "KEY"], trap: ["blk-trap", "EXAM TRAP"], exam: ["blk-exam", "EXAM"] };

function ContentBlock({ block }) {
  const p = block.payload || {};
  switch (block.block_type) {
    case "lead":         return rawHtml("blk-lead", p.text, true);
    case "prose":        return rawHtml("blk-prose", p.text, true);
    case "heading_2":    return h("h3", { class: "blk-h2" }, p.text);
    case "heading_3":    return h("h4", { class: "blk-h3" }, p.text);
    case "list_bullet":  return h("ul", { class: "md-list blk-list" },
                            (p.items || []).map((it, i) =>
                              h("li", { key: i, dangerouslySetInnerHTML: { __html: markLeadIn(safeInline(it)) } })));
    case "list_ordered": return h("ol", { class: "md-list blk-list" },
                            (p.items || []).map((it, i) =>
                              h("li", { key: i, dangerouslySetInnerHTML: { __html: markLeadIn(safeInline(it)) } })));
    case "formula":      return h("div", { class: "blk-formula" },
                            p.label && inlineText("div", "blk-formula-label", p.label),
                            inlineText("div", "blk-formula-expr", p.expr));
    case "worked":       return h(WorkedBlock, { payload: p });
    case "key": case "trap": case "exam": {
      const [cls, label] = CALLOUT_BLOCK[block.block_type];
      return h("div", { class: `blk-callout ${cls}` },
        h("span", { class: "blk-callout-tag" }, label),
        h("div", { class: "blk-callout-body" },
          (p.paras || []).map((t, i) => rawHtml("", t, true))));
    }
    default:             return h(BlockTable, { payload: p, cls: block.block_type.replace("table_", "tbl-") });
  }
}

function BlockList({ blocks }) {
  return h("div", { class: "unit-blocks" },
    blocks.map((b, i) => h(ContentBlock, { key: b.ord ?? i, block: b })));
}

function UnitRenderer({ unit, blocks }) {
  const p = unit.payload || {};

  if (unit.kind === "los") {
    const outcomes = p.outcomes || [];
    return h("div", { class: "unit-los" },
      h("p", { class: "unit-los-intro" }, "By the end of this reading you will be able to:"),
      h("ul", { class: "unit-los-list" },
        outcomes.map((o, i) =>
          h("li", { key: i, class: "unit-los-item" },
            o.verb && h("span", { class: "los-verb" }, o.verb),
            h("span", null, ` ${o.text}`),
          )
        )
      )
    );
  }

  if (unit.kind === "concept") {
    // typed blocks when the unit has been migrated; prose_md otherwise, so
    // units can move across one at a time without breaking the reader
    if (blocks && blocks.length) return h(BlockList, { blocks });
    return h("div", { class: "unit-concept" },
      p.prose_md && h("div", { class: "unit-prose", dangerouslySetInnerHTML: { __html: mdToHtml(p.prose_md) } }),
      p.formulas?.length > 0 && h("div", { class: "unit-formulas" },
        p.formulas.map((f, i) =>
          h("div", { key: i, class: "formula-card" },
            f.label && h("div", { class: "formula-card-heading" }, f.label),
            h("div", { class: "formula-card-body" }, f.expr),
            f.where && h("div", { class: "formula-card-where" }, f.where),
          )
        )
      ),
      p.key_terms?.length > 0 && h("div", { class: "unit-key-terms" },
        p.key_terms.map((kt, i) =>
          h("div", { key: i, class: "key-term" },
            h("span", { class: "key-term-word" }, kt.term),
            h("span", { class: "key-term-def" }, kt.def),
          )
        )
      ),
    );
  }

  if (unit.kind === "example") {
    return h(ExampleUnit, { payload: p, title: unit.title });
  }

  if (unit.kind === "practice") {
    return h(PracticeUnit, { unit, payload: p });
  }

  if (unit.kind === "recap") {
    return h("div", { class: "unit-recap" },
      p.formulas?.length > 0 && h(Fragment, null,
        h("h3", { class: "unit-recap-heading" }, "Key Formulas"),
        h("div", { class: "unit-formulas" },
          p.formulas.map((f, i) =>
            h("div", { key: i, class: "formula-card" },
              f.label && h("div", { class: "formula-card-heading" }, f.label),
              h("div", { class: "formula-card-body" }, f.expr),
            )
          )
        )
      ),
      p.los_revisited?.length > 0 && h(Fragment, null,
        h("h3", { class: "unit-recap-heading" }, "Learning Outcomes Covered"),
        h("div", { class: "unit-recap-los" },
          p.los_revisited.map(n => h("span", { key: n, class: "recap-los-num" }, `LOS ${n}`))
        )
      ),
      p.next_reading_id && h("div", { class: "unit-recap-next" },
        h("span", null, "Next reading →"),
        h("button", {
          class: "recap-next-btn",
          onClick: () => navigate(`#/read/${p.next_reading_id}`),
        }, "Continue"),
      ),
    );
  }

  return h("div", { class: "unit-body-fallback" }, JSON.stringify(p, null, 2));
}

// ── Example unit ───────────────────────────────────────────────────────────────

function ExampleUnit({ payload: p, title }) {
  const [revealed, setRevealed] = useState(false);
  const allSteps = p.steps || [];

  // The generator sets `prompt` to the chunk heading, which is also the unit
  // title — rendering both leaves the card looking empty before you expand it.
  // When they duplicate, promote the first step to be the visible setup and
  // reveal the remainder as the worked solution.
  const norm = s => String(s || "").trim().toLowerCase();
  const duplicated = title && p.prompt && norm(p.prompt) === norm(title);
  const intro = duplicated ? (allSteps[0]?.text || "") : p.prompt;
  const steps = duplicated ? allSteps.slice(1) : allSteps;
  const hasSolution = steps.length > 0 || !!p.answer;

  return h("div", { class: "unit-example" },
    intro && h("div", { class: "example-prompt" }, intro),
    !hasSolution && !intro &&
      h("div", { class: "unit-body-fallback" }, "No worked detail captured for this example."),
    revealed
      ? h(Fragment, null,
          steps.length > 0 && h("ol", { class: "example-steps" },
            steps.map((s, i) =>
              h("li", { key: i, class: "example-step" },
                h("div", { class: "example-step-text" }, s.text),
                s.calc && h("div", { class: "example-step-calc" }, s.calc),
              )
            )
          ),
          p.answer && h("div", { class: "example-answer" },
            h("span", { class: "example-answer-label" }, "Answer: "),
            p.answer,
          ),
          h("button", { class: "example-toggle", onClick: () => setRevealed(false) }, "▲ collapse"),
        )
      : hasSolution && h("button", {
          class: "drill-reveal-btn", onClick: () => setRevealed(true),
        }, steps.length > 0
             ? `Show worked solution (${steps.length} step${steps.length === 1 ? "" : "s"})`
             : "Show answer"),
  );
}

// ── Practice unit ──────────────────────────────────────────────────────────────

function PracticeUnit({ unit, payload: p }) {
  const [selected, setSelected] = useState(null);
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const TENANT = "00000000-0000-0000-0000-000000000000";

  const isStub = !!p._stub;

  const submit = async () => {
    if (!selected || saving) return;
    setSaving(true);
    try {
      const sb = await getClient();
      const correct = selected === p.answer;
      await sb.from("codex_unit_progress").upsert({
        tenant_id: TENANT,
        unit_id: unit.id,
        status: "done",
        practice_result: correct ? "correct" : "wrong",
        last_viewed: new Date().toISOString(),
      }, { onConflict: "tenant_id,unit_id" });

      if (p.los_num) {
        const quality = correct ? 4 : 1;
        const { ef, interval, nextDue } = sm2Next(quality, 2.5, 0);
        await sb.from("codex_progress").upsert({
          tenant_id: "00000000-0000-0000-0000-000000000001",
          los_id: `${unit.reading_id || ""}:${p.los_num}`,
          mastery: correct ? 80 : 20,
          status: correct ? "strong" : "weak",
          ease: ef, interval_days: interval,
          reps: 1, last_reviewed: new Date().toISOString(),
          next_due: nextDue.split("T")[0],
        }, { onConflict: "tenant_id,los_id" });
      }
    } catch {}
    setSaving(false);
    setSubmitted(true);
  };

  if (isStub) {
    return h("div", { class: "unit-practice practice-stub" },
      h("div", { class: "practice-stub-msg" },
        "Practice item not yet generated. Run:",
        h("pre", { class: "read-cmd" }, `python ingest/codex_units_gen.py --doc-id ${unit.reading_id} --generate-practice --replace`),
      ),
    );
  }

  return h("div", { class: "unit-practice" },
    // Opening a practice item is the practice session. Priming cards are
    // fetched on that event — not on an interval, not on a due date, and not
    // when the review queue mounts. Keyed on the unit so moving between items
    // re-fetches rather than reusing what was primed for the last one.
    h(PrimingCards, { sessionKey: unit.id, compact: true }),
    p.vignette && h("div", { class: "practice-vignette" }, p.vignette),
    h("div", { class: "practice-question" }, p.question),
    h("div", { class: "practice-choices" },
      (p.choices || []).map(c =>
        h("button", {
          key: c.key,
          class: `practice-choice ${selected === c.key ? "selected" : ""} ${submitted ? (c.key === p.answer ? "correct" : selected === c.key ? "wrong" : "") : ""}`,
          disabled: submitted,
          onClick: () => !submitted && setSelected(c.key),
        },
          h("span", { class: "choice-key" }, c.key),
          h("span", null, c.text),
        )
      )
    ),
    !submitted
      ? h("button", {
          class: "practice-submit",
          disabled: !selected || saving,
          onClick: submit,
        }, "Submit")
      : h("div", { class: "practice-solution" },
          h("div", { class: `practice-result ${selected === p.answer ? "correct" : "wrong"}` },
            selected === p.answer ? "Correct ✓" : `Incorrect — answer is ${p.answer}`,
          ),
          p.solution_md && h("div", { class: "practice-solution-text",
            dangerouslySetInnerHTML: { __html: mdToHtml(p.solution_md) } }),
        ),
  );
}

// ── Minimal markdown → HTML ────────────────────────────────────────────────────
// Handles bold, italic, inline code, and newlines only — no XSS vectors.
// ── display helpers ───────────────────────────────────────────────────────────
// Internal field names and ingest artefacts should never reach the UI.

const PLACEHOLDER_TITLE = /^\s*page\s+\d+\s+of\s+\d+\s*$/i;

function readingTitle(doc) {
  if (doc?.reading && !PLACEHOLDER_TITLE.test(doc.reading)) return doc.reading;
  return doc?.lm ? `Module ${doc.lm}` : "Untitled reading";
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

// Human-readable chips only; anything zero or missing is omitted rather than
// rendered as "0 chunks".
function readingMeta(doc) {
  const out = [];
  if (doc?.lm) out.push(`Module ${doc.lm}`);
  if (doc?.los_count > 0) out.push(plural(doc.los_count, "outcome", "outcomes"));
  if (doc?.chunk_count > 0) out.push(plural(doc.chunk_count, "section", "sections"));
  return out;
}

// ── markdown rendering ────────────────────────────────────────────────────────
// Block-level parser. Escapes first, then applies inline formatting to the
// escaped text, so no untrusted markup can survive into the DOM.

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function mdInline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
}

const MD_HEAD     = /^\s*(#{1,6})\s+(.*)$/;
const MD_BOLDLINE = /^\s*\*\*(.+?)\*\*\s*:?\s*$/;
const MD_LIST     = /^\s*([-*•▪·●◦‣]|\d+[.)])\s+(.*)$/;
const MD_QUOTE    = /^\s*>\s?/;
const MD_CALLOUT  =
  /^\s*(KEY|NOTE|TIP|WARNING|CAUTION|REMEMBER|IMPORTANT|EXAM TIP|EXAM TRAP|PITFALL|EXAMPLE|COMPLIANCE|VIOLATION)\s*[:\-–—]\s*(.*)$/i;

function calloutClass(tag) {
  const t = tag.toUpperCase();
  if (/VIOLATION/.test(t)) return "bad";
  if (/COMPLIANCE/.test(t)) return "good";
  if (/WARNING|CAUTION|TRAP|PITFALL/.test(t)) return "warn";
  if (/NOTE|TIP|EXAMPLE/.test(t)) return "note";
  return "key";
}

function isTableSep(line) {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line || "");
}

function splitRow(line) {
  return line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map(c => c.trim());
}

// The PDF extractor hard-wraps prose mid-sentence, but it also flattens table
// cells onto their own lines. Blindly joining every line would run those cells
// together; keeping every line break leaves prose fragmented. So join a line
// onto the previous one only when it actually reads as a continuation — the
// previous line has no terminal punctuation and this one opens lower-case.
function wrapSegments(lines) {
  const segs = [];
  for (const raw of lines) {
    const t = raw.trim();
    if (!t) continue;
    if (!segs.length) { segs.push(t); continue; }
    const prev = segs[segs.length - 1];
    // lower-case opener is the usual continuation cue; a trailing connector
    // ("Extracting &" / "Preparing") is the other, and case cannot detect it
    // Only .!? actually end a cell. Semicolons and colons routinely fall at a
    // wrap point inside one ("…ground to powder;" / "concentrated to ~25%"),
    // and treating them as terminal splits a single cell in two — which then
    // throws off the column count inferred by inferGrid.
    const continues = (/^[a-z(→,;%$]/.test(t) || /[&/,\-–]$/.test(prev))
                      && !/[.!?]$/.test(prev);
    if (continues) segs[segs.length - 1] = `${prev} ${t}`;
    else segs.push(t);
  }
  return segs;
}

// The extractor often emits the bullet glyph on a line of its own, with the
// item text on the following lines. MD_LIST requires text on the same line, so
// those lines have to be recognised separately or they render as stray "•".
const MD_BULLET_ONLY = /^\s*[-*•▪·●◦‣]\s*$/;

function isListStart(line) {
  return MD_LIST.test(line) || MD_BULLET_ONLY.test(line);
}

// Flattened tables without row numbers still have a grid: N header cells
// followed by an exact multiple of N data cells. Recovering N by trying each
// candidate and scoring how uniform the resulting columns are is safe only if
// the winner is unambiguous — a wrong N pairs the wrong value with the wrong
// label, which for exam material is worse than leaving it as a flat list.
// Hence the guards below, and the requirement that the best N clearly beat the
// runner-up before any table is emitted.
const GRID_MIN_SCORE = 0.62;
const GRID_MIN_MARGIN = 0.05;

function columnUniformity(cells) {
  const lens = cells.map(c => c.length);
  const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
  if (!mean) return 0;
  const sd = Math.sqrt(lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length);
  return 1 / (1 + sd / mean);
}

function inferGrid(segs, start = 0) {
  segs = start ? segs.slice(start) : segs;
  if (segs.length < 6) return null;
  const scored = [];

  for (let n = 2; n <= 6; n++) {
    const data = segs.slice(n);
    if (data.length < n * 2 || data.length % n !== 0) continue;

    const header = segs.slice(0, n).map(s => s.trim());
    // headers are short labels, never sentences
    if (header.some(c => !c || c.length > 42 || /[.!?]$/.test(c))) continue;

    const rows = data.length / n;
    let score = 0;
    for (let j = 0; j < n; j++) {
      const col = [];
      for (let r = 0; r < rows; r++) col.push(data[r * n + j].trim());
      if (col.some(c => !c)) { score = 0; break; }
      score += columnUniformity(col);
    }
    if (!score) continue;
    scored.push({ n, header, rows, data, score: score / n });
  }

  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (best.score < GRID_MIN_SCORE) return null;
  if (scored[1] && best.score - scored[1].score < GRID_MIN_MARGIN) return null;

  const body = [];
  for (let r = 0; r < best.rows; r++) {
    body.push(best.data.slice(r * best.n, (r + 1) * best.n).map(s => s.trim()));
  }
  return '<div class="md-table-wrap"><table class="md-table"><thead><tr>' +
    best.header.map(c => `<th>${mdInline(c)}</th>`).join("") +
    "</tr></thead><tbody>" +
    body.map(r => "<tr>" + r.map(c => `<td>${mdInline(c)}</td>`).join("") + "</tr>").join("") +
    "</tbody></table></div>";
}

// Numeric tables survive flattening better than they look, because the values
// betray the shape: a table with k numeric columns emits runs of exactly k
// numbers separated by a label. That gives the column count directly, without
// having to guess, and it tolerates cells that wrapped onto two lines — the
// label is simply everything between two runs, however many lines that took.
// This is what recovers tables inferGrid cannot, e.g. one whose header reads
// "Collateral" / "Return" on separate lines.
const NUMERIC_CELL = /^(?:[-+−–—]?[\d][\d,]*(?:\.\d+)?%?|[—–-]|n\/?a)$/i;

function isNumericCell(s) {
  return NUMERIC_CELL.test((s || "").trim());
}

// Merge wrapped header cells until the header has exactly `target` cells.
// A lone word that is also the final word of two or more sibling headers is
// almost certainly a wrapped tail ("Return", under "Total Return" / "Spot
// Return"), so prefer that; otherwise merge the shortest adjacent pair.
function compressHeader(cells, target) {
  const out = cells.slice();
  let guard = 0;
  while (out.length > target && guard++ < 8) {
    const tails = {};
    for (const c of out) {
      const w = c.trim().split(/\s+/).pop();
      if (w) tails[w] = (tails[w] || 0) + 1;
    }
    let pick = -1;
    for (let i = 1; i < out.length; i++) {
      const c = out[i].trim();
      if (!/\s/.test(c) && (tails[c] || 0) >= 2) { pick = i - 1; break; }
    }
    if (pick < 0) {
      let best = Infinity;
      for (let i = 0; i < out.length - 1; i++) {
        const len = out[i].length + out[i + 1].length;
        if (len < best) { best = len; pick = i; }
      }
    }
    out.splice(pick, 2, `${out[pick]} ${out[pick + 1]}`.replace(/\s+/g, " ").trim());
  }
  return out;
}

function inferNumericGrid(segs) {
  if (segs.length < 8) return null;

  // maximal runs of consecutive numeric cells
  const runs = [];
  for (let i = 0; i < segs.length; i++) {
    if (!isNumericCell(segs[i])) continue;
    const start = i;
    while (i + 1 < segs.length && isNumericCell(segs[i + 1])) i++;
    // A run must contain a real number. Dashes and "n/a" are placeholders, and
    // a run made only of them is not evidence of a numeric column — in a tick
    // chart ("✓ Primary driver / — / —") two dashes otherwise imply two value
    // columns and collapse a four-column table into three.
    const hasDigit = segs.slice(start, i + 1).some(c => /\d/.test(c));
    if (i - start + 1 >= 2 && hasDigit) runs.push([start, i]);
  }
  if (runs.length < 2) return null;

  const k = runs[0][1] - runs[0][0] + 1;
  if (k < 2 || k > 8) return null;
  if (!runs.every(r => r[1] - r[0] + 1 === k)) return null;   // ragged: decline

  const n = k + 1;
  const firstRun = runs[0][0];
  if (firstRun < n) return null;                 // no room for header + label

  // Row 1's label may itself have wrapped, so the header boundary is not
  // simply firstRun-1. Walk the boundary back until the header validates —
  // a cell ending in a full stop is prose, not a header, which is what
  // excludes an over-long guess.
  let header = null, headerLen = 0;
  for (let hLen = firstRun - 1; hLen >= n; hLen--) {
    const cand = compressHeader(segs.slice(0, hLen).map(s => s.trim()), n);
    if (cand.length !== n) continue;
    if (cand.some(c => !c || c.length > 48 || /[.!?]$/.test(c))) continue;
    header = cand; headerLen = hLen; break;
  }
  if (!header) return null;

  const rows = [];
  for (let r = 0; r < runs.length; r++) {
    const [s, e] = runs[r];
    const labelFrom = r === 0 ? headerLen : runs[r - 1][1] + 1;
    const label = segs.slice(labelFrom, s).map(x => x.trim()).join(" ").trim();
    if (!label) return null;
    // A label that reads as a value (CHF 22.0B, (2,321), ~35) means a value
    // column used a format the run detector missed, so the grid is shifted.
    if (/^(?:[A-Z]{2,3}\s*)?[~(]?[\d.,]+\s*[A-Za-z%]{0,2}\)?$/.test(label)) return null;
    rows.push([label, ...segs.slice(s, e + 1).map(x => x.trim())]);
  }

  return '<div class="md-table-wrap"><table class="md-table"><thead><tr>' +
    header.map(c => `<th>${mdInline(c)}</th>`).join("") +
    "</tr></thead><tbody>" +
    rows.map(r => "<tr>" + r.map(c => `<td>${mdInline(c)}</td>`).join("") + "</tr>").join("") +
    "</tbody></table></div>";
}

// A line that ends one block and starts another
function isBlockStart(line, next) {
  return MD_HEAD.test(line) || MD_BOLDLINE.test(line) || isListStart(line) ||
         MD_CALLOUT.test(line) || MD_QUOTE.test(line) ||
         (line.includes("|") && isTableSep(next));
}

// "Term: definition" is the dominant shape in this corpus. Marking the lead-in
// gives structure inside a bullet instead of one undifferentiated sentence.
function liHtml(text) {
  const m = text.match(/^([^:]{2,60}):\s+([\s\S]+)$/);
  if (m) return `<span class="li-term">${mdInline(m[1])}</span> ${mdInline(m[2])}`;
  return mdInline(text);
}

// A flattened paragraph is a run of segments, and some of those segments are
// really the labels that opened a section, a definition or an example before
// the PDF export lost their styling. Marking them gives the block the shape it
// had on the page; a label also suppresses the <br> around it, so it reads as a
// heading rather than as one more line in the run.
function paraHtml(segs) {
  let html = "";
  let prevLabel = false;
  segs.forEach((s, i) => {
    const label = isLabelText(s);
    if (i && !label && !prevLabel) html += "<br>";
    html += label
      ? `<span class="md-label">${mdInline(s)}</span>`
      : markLeadIn(mdInline(s));
    prevLabel = label;
  });
  return `<p>${html}</p>`;
}

// The PDF extractor flattens tables to one cell per line. Where rows are
// numbered, the structure is recoverable: after wrap-joining, a bare integer
// marks the start of a row and the cells before the first "1" are the header.
// Bails out unless the shape is unambiguous, so ordinary prose is never
// mangled into a table.
function reconstructTable(segs) {
  const bare = s => /^\d{1,2}$/.test(s.trim());
  const first = segs.findIndex(s => s.trim() === "1");
  if (first < 2) return null;

  const header = segs.slice(0, first).map(s => s.trim());
  if (header.length > 6) return null;
  if (header.some(c => !c || c.length > 48 || /[.:;]$/.test(c))) return null;

  // Ascending rather than strictly consecutive: the extractor occasionally
  // drops a row number, and swallowing the rest of the table is worse than
  // tolerating a gap.
  const starts = [];
  let last = 0;
  for (let k = first; k < segs.length; k++) {
    const n = Number(segs[k]);
    if (bare(segs[k]) && n > last) { starts.push(k); last = n; }
  }
  if (starts.length < 2) return null;

  const rows = [];
  for (let r = 0; r < starts.length; r++) {
    const to = r + 1 < starts.length ? starts[r + 1] : segs.length;
    const cells = segs.slice(starts[r], to).map(s => s.trim()).filter(Boolean);
    if (cells.length < 2) return null;
    if (cells.length > header.length) {
      const tail = cells.slice(header.length - 1).join(" ");
      cells.length = header.length - 1;
      cells.push(tail);
    }
    while (cells.length < header.length) cells.push("");
    rows.push(cells);
  }

  return '<div class="md-table-wrap"><table class="md-table"><thead><tr>' +
    header.map(c => `<th>${mdInline(c)}</th>`).join("") +
    "</tr></thead><tbody>" +
    rows.map(r => "<tr>" + r.map(c => `<td>${mdInline(c)}</td>`).join("") + "</tr>").join("") +
    "</tbody></table></div>";
}

function mdToHtml(md) {
  if (!md) return "";
  const lines = stripToc(String(md).replace(/\r\n?/g, "\n")).split("\n");
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    // ── pipe table ──────────────────────────────────────────────────────────
    if (line.includes("|") && isTableSep(lines[i + 1])) {
      const head = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
        rows.push(splitRow(lines[i])); i++;
      }
      out.push(
        '<div class="md-table-wrap"><table class="md-table"><thead><tr>' +
        head.map(c => `<th>${mdInline(c)}</th>`).join("") +
        "</tr></thead><tbody>" +
        rows.map(r => "<tr>" + r.map(c => `<td>${mdInline(c)}</td>`).join("") + "</tr>").join("") +
        "</tbody></table></div>"
      );
      continue;
    }

    // ── headings ────────────────────────────────────────────────────────────
    const hm = line.match(MD_HEAD);
    if (hm) {
      const lvl = Math.min(hm[1].length + 1, 4);
      out.push(`<h${lvl} class="md-h md-h${lvl}">${mdInline(hm[2])}</h${lvl}>`);
      i++; continue;
    }

    // A line that is nothing but bold text is a section heading, not a sentence
    const bm = line.match(MD_BOLDLINE);
    if (bm) {
      out.push(`<h3 class="md-h md-h3">${mdInline(bm[1])}</h3>`);
      i++; continue;
    }

    // ── callouts (KEY: / NOTE: / WARNING: …) ────────────────────────────────
    const cm = line.match(MD_CALLOUT);
    if (cm) {
      const body = [cm[2]];
      i++;
      while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i], lines[i + 1])) {
        body.push(lines[i].trim()); i++;
      }
      out.push(
        `<div class="md-callout md-callout-${calloutClass(cm[1])}">` +
        `<span class="md-callout-tag">${esc(cm[1].toUpperCase())}</span>` +
        `<div class="md-callout-body">${mdInline(body.join(" ").trim())}</div></div>`
      );
      continue;
    }

    // ── lists (-, *, •, ▪, ·, 1., 1)) ───────────────────────────────────────
    if (isListStart(line)) {
      const ordered = /^\s*\d+[.)]/.test(line);
      const items = [];
      while (i < lines.length && isListStart(lines[i])) {
        const m = lines[i].match(MD_LIST);
        const parts = m ? [m[2]] : [];   // no capture when the glyph is alone
        i++;
        // absorb wrapped continuation lines so a bullet is not split mid-thought
        while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i], lines[i + 1])) {
          parts.push(lines[i]); i++;
        }
        const text = wrapSegments(parts).join(" ").trim();
        if (text) items.push(text);
      }
      if (items.length) {
        const tag = ordered ? "ol" : "ul";
        out.push(`<${tag} class="md-list">` +
                 items.map(t => `<li>${liHtml(t)}</li>`).join("") + `</${tag}>`);
      }
      continue;
    }

    // ── blockquote ──────────────────────────────────────────────────────────
    if (MD_QUOTE.test(line)) {
      const body = [];
      while (i < lines.length && MD_QUOTE.test(lines[i])) {
        body.push(lines[i].replace(MD_QUOTE, "")); i++;
      }
      out.push(`<blockquote class="md-quote">${mdInline(body.join(" "))}</blockquote>`);
      continue;
    }

    // ── paragraph ───────────────────────────────────────────────────────────
    const para = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i], lines[i + 1])) {
      para.push(lines[i]); i++;
    }
    if (para.length) {
      const segs = wrapSegments(para);
      // A table is often preceded by a line or two of lead-in prose, so the
      // header does not always start at the first segment. Take the EARLIEST
      // start that yields a candidate, and prefer the detector resting on the
      // strongest evidence — explicit row numbers, then numeric runs, then
      // pure column-shape inference. Ranking by row count instead would let a
      // spurious 2-column reading beat the correct 4-column one.
      let best = null;
      for (let start = 0; start <= Math.min(4, segs.length - 6) && !best; start++) {
        const rest = segs.slice(start);
        // Offsets are granted only to detectors anchored on explicit evidence
        // — row numbers, or runs of numbers. Column-shape inference is too weak
        // to also choose where the table starts: given that freedom it finds
        // grids in tables whose blank corner cell was dropped by extraction,
        // shifting every row by one and filing row labels as column headers.
        const html = reconstructTable(rest) || inferNumericGrid(rest)
                     || (start === 0 ? inferGrid(segs) : null);
        if (html) best = { start, html };
      }
      if (best) {
        // whatever preceded the table is real prose and must still be shown
        if (best.start > 0) {
          out.push(paraHtml(segs.slice(0, best.start)));
        }
        out.push(best.html);
      } else {
        out.push(paraHtml(segs));
      }
    }
  }

  return out.join("");
}

// ── Formula Sheet ──────────────────────────────────────────────────────────────

function FormulaSheet() {
  const [topics, setTopics] = useState(null);
  const [formulas, setFormulas] = useState(null);
  const [filter, setFilter] = useState("all");
  const [err, setErr] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const sb = await getClient();
        const [topicsRes, formulasRes] = await Promise.all([
          sb.from("vw_codex_priority").select("topic_id, name, band, focus_index"),
          sb.from("codex_chunks")
            .select("id, doc_id, topic_id, heading, body, lm, codex_topics(name, band)")
            .eq("is_formula", true).order("topic_id"),
        ]);
        if (topicsRes.error) throw topicsRes.error;
        setTopics(topicsRes.data || []);
        setFormulas(formulasRes.data || []);
      } catch (e) { setErr(e.message); }
    })();
  }, []);

  if (err) return h(ErrorBox, { msg: err });
  if (!formulas || !topics) return h(Loader);

  const topicOrder = [...topics].sort((a, b) => Number(b.focus_index) - Number(a.focus_index));
  const filtered = filter === "all" ? formulas : formulas.filter(f => f.topic_id === filter);

  const grouped = [];
  for (const t of topicOrder) {
    const chunks = filtered.filter(f => f.topic_id === t.topic_id);
    if (chunks.length) grouped.push({ topic: t, chunks });
  }

  return h(Fragment, null,
    h("div", { class: "page-title" }, "Formula Sheet"),
    h("div", { class: "page-sub" }, `${formulas.length} formulas · deficit topics first`),
    h("div", { class: "filter-bar" },
      h("button", { class: `filter-btn ${filter === "all" ? "active" : ""}`, onClick: () => setFilter("all") }, "All"),
      topicOrder.map(t =>
        h("button", { key: t.topic_id, class: `filter-btn ${filter === t.topic_id ? "active" : ""}`, onClick: () => setFilter(t.topic_id) }, t.name)
      ),
    ),
    grouped.length === 0 ? h("div", { class: "empty-state" }, "No formulas match.")
      : grouped.map(({ topic, chunks }) =>
          h("div", { key: topic.topic_id, class: "formula-group" },
            h("div", { class: "formula-group-header" },
              h("span", { class: "formula-group-name" }, topic.name),
              h(Chip, { band: topic.band }),
            ),
            h("div", { class: "formula-grid" },
              chunks.map(f =>
                h("div", { key: f.id, class: "formula-card" },
                  f.heading && h("div", { class: "formula-card-heading" }, f.heading),
                  h("div", { class: "formula-card-body" }, f.body),
                  f.lm && h("div", { class: "formula-card-meta" }, `Module ${f.lm}`),
                )
              )
            ),
          )
        ),
  );
}

// ── Example Drill ──────────────────────────────────────────────────────────────

function ExampleDrill() {
  const [examples, setExamples] = useState(null);
  const [idx, setIdx] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [filter, setFilter] = useState("all");
  const [topics, setTopics] = useState(null);
  const [progress, setProgress] = useState({});
  const [saving, setSaving] = useState(false);
  const [sessionStats, setSessionStats] = useState({ rated: 0, due: 0 });
  const [err, setErr] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const sb = await getClient();
        const [topicsRes, examplesRes, progressRes] = await Promise.all([
          sb.from("vw_codex_priority").select("topic_id, name, band, focus_index"),
          sb.from("codex_chunks").select("id, doc_id, topic_id, heading, body, lm, codex_topics(name, band)").eq("is_example", true).order("topic_id"),
          sb.from("codex_drill_progress").select("chunk_id, ef, interval_days, next_due").eq("item_type", "example"),
        ]);
        const prog = {};
        for (const p of (progressRes.data || [])) prog[p.chunk_id] = { ef: p.ef, interval: p.interval_days, due: p.next_due };
        const topicOrder = [...(topicsRes.data || [])].sort((a, b) => Number(b.focus_index) - Number(a.focus_index));
        setTopics(topicOrder);
        setProgress(prog);
        const now = new Date().toISOString();
        const due = [], fresh = [];
        for (const ex of (examplesRes.data || [])) {
          const p = prog[ex.id];
          if (!p || p.due <= now) due.push(ex); else fresh.push(ex);
        }
        const topicRank = Object.fromEntries(topicOrder.map((t, i) => [t.topic_id, i]));
        const byRank = (a, b) => (topicRank[a.topic_id] ?? 999) - (topicRank[b.topic_id] ?? 999);
        due.sort(byRank); fresh.sort(byRank);
        setExamples([...due, ...fresh]);
        setSessionStats({ rated: 0, due: due.length });
      } catch (e) { setErr(e.message); }
    })();
  }, []);

  const filtered = examples ? (filter === "all" ? examples : examples.filter(e => e.topic_id === filter)) : null;
  const card = filtered?.[idx] ?? null;

  const rate = useCallback(async (quality) => {
    if (!card) return;
    setSaving(true);
    try {
      const sb = await getClient();
      const prev = progress[card.id] || { ef: 2.5, interval: 0 };
      const next = sm2Next(quality, prev.ef, prev.interval);
      await sb.from("codex_reviews").insert({ chunk_id: card.id, rating: quality, reviewed_at: new Date().toISOString() });
      await sb.from("codex_drill_progress").upsert({ chunk_id: card.id, item_type: "example", ef: next.ef, interval_days: next.interval, next_due: next.nextDue, updated_at: new Date().toISOString() }, { onConflict: "chunk_id,item_type" });
      setProgress(prev => ({ ...prev, [card.id]: { ef: next.ef, interval: next.interval, due: next.nextDue } }));
      setSessionStats(s => ({ ...s, rated: s.rated + 1 }));
      setIdx(i => i + 1);
      setRevealed(false);
    } catch (e) { setErr(e.message); }
    finally { setSaving(false); }
  }, [card, progress]);

  if (err) return h(ErrorBox, { msg: err });
  if (!filtered) return h(Loader);
  const done = idx >= filtered.length;
  const RATING_LABELS = [{ q: 0, label: "0", desc: "Blackout" }, { q: 1, label: "1", desc: "Wrong" }, { q: 2, label: "2", desc: "Hard" }, { q: 3, label: "3", desc: "OK" }, { q: 4, label: "4", desc: "Good" }, { q: 5, label: "5", desc: "Easy" }];

  return h(Fragment, null,
    h("div", { class: "page-title" }, "Example Drill"),
    h("div", { class: "page-sub" }, `${sessionStats.due} due · ${sessionStats.rated} rated this session`),
    h("div", { class: "filter-bar" },
      h("button", { class: `filter-btn ${filter === "all" ? "active" : ""}`, onClick: () => { setFilter("all"); setIdx(0); setRevealed(false); } }, "All"),
      (topics || []).map(t => h("button", { key: t.topic_id, class: `filter-btn ${filter === t.topic_id ? "active" : ""}`, onClick: () => { setFilter(t.topic_id); setIdx(0); setRevealed(false); } }, t.name)),
    ),
    done
      ? h("div", { class: "drill-done" }, h("div", { class: "drill-done-icon" }, "✓"), h("div", { class: "drill-done-title" }, "Session complete"), h("div", { class: "drill-done-sub" }, `You rated ${sessionStats.rated} example${sessionStats.rated !== 1 ? "s" : ""}.`), h("button", { class: "drill-restart", onClick: () => { setIdx(0); setRevealed(false); } }, "Restart"))
      : h(Fragment, null,
          h("div", { class: "drill-progress" }, h("div", { class: "drill-progress-bar" }, h("div", { class: "drill-progress-fill", style: { width: `${(idx / filtered.length) * 100}%` } })), h("span", { class: "drill-progress-label" }, `${idx + 1} / ${filtered.length}`)),
          h("div", { class: "drill-card" },
            h("div", { class: "drill-card-meta" }, card.codex_topics?.name && h("span", null, card.codex_topics.name), card.codex_topics?.band && h(Chip, { band: card.codex_topics.band }), card.lm && h("span", null, `Module ${card.lm}`)),
            card.heading && h("div", { class: "drill-card-heading" }, card.heading),
            h("div", { class: "drill-card-prompt" }, "Work through this example:"),
            h("div", { class: "drill-card-body" }, revealed ? card.body : h("div", { class: "drill-hidden" }, h("div", { class: "drill-hidden-text" }, "Hidden — click to reveal"))),
            !revealed
              ? h("button", { class: "drill-reveal-btn", onClick: () => setRevealed(true) }, "Reveal Answer")
              : h("div", { class: "drill-rating" }, h("div", { class: "drill-rating-label" }, "How well did you get it?"), h("div", { class: "drill-rating-btns" }, RATING_LABELS.map(({ q, label, desc }) => h("button", { key: q, class: `rating-btn q${q}`, disabled: saving, onClick: () => rate(q) }, h("span", { class: "rating-num" }, label), h("span", { class: "rating-desc" }, desc))))),
          ),
        ),
  );
}

// ── LOS Tracker ────────────────────────────────────────────────────────────────

const RATING_LABELS_LOS = [
  { q: 0, label: "0", desc: "Blackout" }, { q: 1, label: "1", desc: "Wrong" },
  { q: 2, label: "2", desc: "Hard" },    { q: 3, label: "3", desc: "OK" },
  { q: 4, label: "4", desc: "Good" },    { q: 5, label: "5", desc: "Easy" },
];

function LosStatusDot({ p }) {
  if (!p) return h("span", { class: "los-dot new", title: "New" });
  const pct = Number(p.mastery || 0);
  const cls = pct >= 80 ? "strong" : pct >= 50 ? "mid" : "weak";
  return h("span", { class: `los-dot ${cls}`, title: `Mastery ${pct}%` });
}

function LosTracker() {
  const [topics, setTopics] = useState(null);
  const [los, setLos] = useState(null);
  const [progress, setProgress] = useState({});
  const [filter, setFilter] = useState("all");
  const [mode, setMode] = useState("browse");
  const [queueIdx, setQueueIdx] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sessionRated, setSessionRated] = useState(0);
  const [err, setErr] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const sb = await getClient();
        const [topicsRes, losRes, progRes] = await Promise.all([
          sb.from("vw_codex_priority").select("topic_id, name, band, focus_index"),
          sb.from("codex_los").select("id, doc_id, topic_id, los_num, outcome, command_verb").order("topic_id").order("los_num"),
          sb.from("codex_progress").select("los_id, mastery, status, ease, interval_days, reps, next_due"),
        ]);
        if (topicsRes.error) throw topicsRes.error;
        const prog = {};
        for (const p of (progRes.data || [])) prog[p.los_id] = p;
        setTopics([...(topicsRes.data || [])].sort((a, b) => Number(b.focus_index) - Number(a.focus_index)));
        setLos(losRes.data || []);
        setProgress(prog);
      } catch (e) { setErr(e.message); }
    })();
  }, []);

  const rateLos = useCallback(async (losItem, quality) => {
    setSaving(true);
    try {
      const sb = await getClient();
      const prev = progress[losItem.id] || { ease: 2.5, interval_days: 0, reps: 0 };
      const { ef, interval, nextDue } = sm2Next(quality, Number(prev.ease), Number(prev.interval_days));
      const mastery = Math.min(100, Math.round((quality / 5) * 100));
      await sb.from("codex_reviews").insert({ los_id: losItem.id, rating: quality, reviewed_at: new Date().toISOString() });
      await sb.from("codex_progress").upsert({
        tenant_id: "00000000-0000-0000-0000-000000000001", los_id: losItem.id,
        mastery, status: quality >= 4 ? "strong" : quality >= 2 ? "mid" : "weak",
        ease: ef, interval_days: interval, reps: (Number(prev.reps) || 0) + 1,
        last_reviewed: new Date().toISOString(), next_due: nextDue.split("T")[0],
      }, { onConflict: "tenant_id,los_id" });
      setProgress(p => ({ ...p, [losItem.id]: { ...p[losItem.id], mastery, ease: ef, interval_days: interval, next_due: nextDue.split("T")[0], status: quality >= 4 ? "strong" : quality >= 2 ? "mid" : "weak", reps: (Number(prev.reps) || 0) + 1 } }));
      setSessionRated(r => r + 1);
      setQueueIdx(i => i + 1);
      setRevealed(false);
    } catch (e) { setErr(e.message); }
    finally { setSaving(false); }
  }, [progress]);

  if (err) return h(ErrorBox, { msg: err });
  if (!los || !topics) return h(Loader);

  const topicRank = Object.fromEntries(topics.map((t, i) => [t.topic_id, i]));
  const now = new Date().toISOString().split("T")[0];
  const filteredLos = filter === "all" ? los : los.filter(l => l.topic_id === filter);
  const dueQueue = [...filteredLos].filter(l => { const p = progress[l.id]; return !p || (p.next_due || "9999") <= now; }).sort((a, b) => (topicRank[a.topic_id] ?? 999) - (topicRank[b.topic_id] ?? 999));
  const totalDue = dueQueue.length;
  const totalLos = filteredLos.length;
  const totalDone = filteredLos.filter(l => progress[l.id]?.status === "strong").length;
  const grouped = [];
  for (const t of topics) { const items = filteredLos.filter(l => l.topic_id === t.topic_id); if (items.length) grouped.push({ topic: t, items }); }
  const queueCard = dueQueue[queueIdx] ?? null;
  const queueDone = queueIdx >= dueQueue.length;

  return h(Fragment, null,
    h("div", { class: "page-title" }, "LOS Tracker"),
    h("div", { class: "page-sub" }, `${totalLos} outcomes · ${totalDue} due · ${totalDone} strong · ${sessionRated} rated this session`),
    h("div", { class: "los-toolbar" },
      h("div", { class: "filter-bar" },
        h("button", { class: `filter-btn ${filter === "all" ? "active" : ""}`, onClick: () => { setFilter("all"); setQueueIdx(0); setRevealed(false); } }, "All"),
        topics.map(t => h("button", { key: t.topic_id, class: `filter-btn ${filter === t.topic_id ? "active" : ""}`, onClick: () => { setFilter(t.topic_id); setQueueIdx(0); setRevealed(false); } }, t.name)),
      ),
      h("div", { class: "mode-toggle" },
        h("button", { class: `mode-btn ${mode === "browse" ? "active" : ""}`, onClick: () => setMode("browse") }, "Browse"),
        h("button", { class: `mode-btn ${mode === "queue" ? "active" : ""}`, onClick: () => { setMode("queue"); setQueueIdx(0); setRevealed(false); } }, `Review Queue (${totalDue})`),
      ),
    ),
    mode === "browse"
      ? h("div", { class: "los-browse" },
          grouped.map(({ topic, items }) =>
            h("div", { key: topic.topic_id, class: "los-topic-group" },
              h("div", { class: "los-topic-header" }, h("span", { class: "los-topic-name" }, topic.name), h(Chip, { band: topic.band }), h("span", { class: "los-topic-count" }, `${items.filter(l => progress[l.id]?.status === "strong").length}/${items.length} strong`)),
              h("div", { class: "los-browse-list" },
                items.map(l => {
                  const p = progress[l.id];
                  const due = !p || (p.next_due || "9999") <= now;
                  return h("div", { key: l.id, class: `los-browse-row ${due ? "due" : ""}` },
                    h(LosStatusDot, { p }),
                    h("div", { class: "los-browse-content" },
                      h("div", { class: "los-browse-num" }, l.command_verb && h("span", { class: "los-verb" }, l.command_verb), `LOS ${l.los_num}`),
                      h("div", { class: "los-browse-text" }, l.outcome),
                      p && h("div", { class: "los-browse-meta" }, `Mastery ${p.mastery}% · ${p.reps} rep${p.reps !== 1 ? "s" : ""} · due ${p.next_due || "today"}`),
                    ),
                  );
                })
              ),
            )
          )
        )
      : queueDone
        ? h("div", { class: "drill-done" }, h("div", { class: "drill-done-icon" }, "✓"), h("div", { class: "drill-done-title" }, "Queue cleared"), h("div", { class: "drill-done-sub" }, `You reviewed ${sessionRated} LOS this session.`), h("button", { class: "drill-restart", onClick: () => { setQueueIdx(0); setRevealed(false); setSessionRated(0); } }, "Restart"))
        : h(Fragment, null,
            h("div", { class: "drill-progress" }, h("div", { class: "drill-progress-bar" }, h("div", { class: "drill-progress-fill", style: { width: `${(queueIdx / dueQueue.length) * 100}%` } })), h("span", { class: "drill-progress-label" }, `${queueIdx + 1} / ${dueQueue.length}`)),
            h("div", { class: "drill-card" },
              h("div", { class: "drill-card-meta" }, h("span", null, topics.find(t => t.topic_id === queueCard.topic_id)?.name || ""), h("span", null, `LOS ${queueCard.los_num}`), queueCard.command_verb && h("span", { class: "los-verb" }, queueCard.command_verb)),
              h("div", { class: "drill-card-prompt" }, "Can you state this learning outcome?"),
              h("div", { class: "drill-card-body" }, revealed ? queueCard.outcome : h("div", { class: "drill-hidden" }, h("div", { class: "drill-hidden-text" }, "Hidden — click to reveal"))),
              !revealed
                ? h("button", { class: "drill-reveal-btn", onClick: () => setRevealed(true) }, "Reveal")
                : h("div", { class: "drill-rating" }, h("div", { class: "drill-rating-label" }, "How well did you know it?"), h("div", { class: "drill-rating-btns" }, RATING_LABELS_LOS.map(({ q, label, desc }) => h("button", { key: q, class: `rating-btn q${q}`, disabled: saving, onClick: () => rateLos(queueCard, q) }, h("span", { class: "rating-num" }, label), h("span", { class: "rating-desc" }, desc))))),
            ),
          ),
  );
}

// ── Report card + targeted review ─────────────────────────────────────────────
// The record is the concept, not the question. Questions are evidence, and none
// of their text is stored or shown — codex_attempts holds performance metadata
// only.
//
// Every remediation tag is read from codex_concept_stats. Nothing in this file
// computes or sets one: a client-side tag would decouple the label from the
// attempt log and the loop would stop closing.

const CODEX_TENANT = "00000000-0000-0000-0000-000000000000";
const EXAM_DATE    = Date.UTC(2026, 10, 19);    // 19 Nov 2026
const DAY_MS       = 86400000;
const PIP_LIMIT    = 10;

const TAG_CLASS = { RELEARN: "re", CHECKLIST: "ck", MAINTAIN: "mt" };

// The tables behind this feature are the Supabase seat's and land separately.
// Until they do, every query here fails on a missing relation. That is a known
// state of the build, not an error to show the reader as a red box.
function isMissingRelation(err) {
  if (!err) return false;
  return err.code === "42P01" || err.code === "PGRST205" ||
         /does not exist|schema cache/i.test(err.message || "");
}

// Hit rate ascending, then attempt count descending, so 0 of 4 outranks 0 of 2 —
// both read 0%, but one is a hardened gap and the other is barely tested.
// Deliberately unweighted: decay and shrinkage were tried and changed no
// decisions.
function ladderOrder(a, b) {
  const ra = a?.hit_rate == null ? 1 : Number(a.hit_rate);
  const rb = b?.hit_rate == null ? 1 : Number(b.hit_rate);
  return ra - rb || Number(b?.lt_attempts || 0) - Number(a?.lt_attempts || 0);
}

// Colour tracks the same split the tag does: below 35% is a knowledge gap, the
// middle band is execution, above that it is holding.
function rateClass(pct) {
  return pct < 35 ? "z" : pct < 60 ? "mid" : "ok";
}

function pctOf(hits, attempts) {
  return attempts ? Math.round((100 * Number(hits || 0)) / Number(attempts)) : 0;
}

// ── Review scheduling ─────────────────────────────────────────────────────────
// The handoff spec asked for Leitner boxes on a codex_review_log table. Neither
// exists: the schema that landed reuses codex_drill_progress, which already
// carries SM-2 (ease, interval_days, next_due) and is what the Example Drill
// writes today. So a review card is scheduled there under its own item_type
// rather than in a second, parallel scheduler.
//
// Grading is binary, so it maps onto the SM-2 quality scale the way the practice
// units already do: a hit is 4, a miss is 1.
const REVIEW_ITEM_TYPE = "concept_unit";
const GRADE_QUALITY = { got: 4, missed: 1 };

// Never reviewed means due now.
function isDue(row, now = Date.now()) {
  if (!row) return true;
  return (Date.parse(row.next_due) || 0) <= now;
}

// Lesson units whose payload holds a question, choices or a vignette never
// become review cards. Codex stores performance metadata for this feature, and
// a card is a pointer back into the lesson — not a place to restate an item.
function isCardable(unit) {
  return unit.kind === "concept" || unit.kind === "example" || unit.kind === "recap";
}

// A card's back is the opening of the lesson unit it came from, flattened to
// plain text — enough to recognise the idea without reproducing the lesson.
function excerpt(unit, limit = 220) {
  const p = unit.payload || {};
  const raw = p.prose_md || p.prompt || p.summary_md || "";
  const flat = stripToc(String(raw))
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*`_>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > limit ? `${flat.slice(0, limit).trimEnd()}…` : flat;
}

// ── shared pieces ─────────────────────────────────────────────────────────────

function NotProvisioned({ reads }) {
  return h("div", { class: "rc-empty" },
    h("b", null, "Not wired up yet"),
    h("p", null,
      "This view reads ", h("code", null, reads),
      ". Those relations are not in the database yet, so there is nothing to " +
      "show. That is the Supabase side of the handoff, not a fault in the client."),
  );
}

// One dot per lifetime attempt, in attempt order: filled is a hit, hollow is a
// miss. This is what makes 0 of 4 legible as worse than 0 of 2 when both read
// 0%, so it is not a bar and not a percentage — the count is the information.
function Pips({ seq }) {
  const shown = seq.slice(0, PIP_LIMIT);
  const rest = seq.length - shown.length;
  const hits = seq.filter(Boolean).length;
  return h("div", {
    class: "rc-pips", role: "img",
    "aria-label": `${hits} of ${seq.length} attempts correct`,
    title: `${hits} of ${seq.length} correct`,
  },
    shown.map((hit, i) => h("i", { key: i, class: `rc-pip ${hit ? "hit" : ""}` })),
    rest > 0 && h("span", { class: "rc-pip-more" }, `+${rest}`),
  );
}

// ── Report card ───────────────────────────────────────────────────────────────
// One view, three scopes: overall → topic → module. The same three sections
// render at every level — headline, ladder, bars — and only the grouping key and
// the filter change. A module report card is the topic card filtered to one
// module, not a second component.
//
// Everything is fetched once on mount and scoped client-side, so moving between
// scopes never reloads.

const RC_SCOPE_RE = /^#\/report(?:\/([^/]+))?(?:\/(\d+))?$/;

function reportHash(topicId, module) {
  if (!topicId) return "#/report";
  return module == null ? `#/report/${topicId}` : `#/report/${topicId}/${module}`;
}

// error_class is stored snake_case. Underscores become spaces and nothing else:
// shortening "calculation_formula_recall" to "formula recall" would be editing
// the record rather than displaying it.
function humanClass(s) {
  return String(s || "").replace(/_/g, " ");
}

const pct1 = x => `${(100 * Number(x || 0)).toFixed(1)}%`;
const pct0 = x => `${Math.round(100 * Number(x || 0))}%`;
const BELOW_THRESHOLD = 0.70;

// ── scope switcher ────────────────────────────────────────────────────────────
// Two tiers, deliberately different. Ancestors are a path — unboxed text, cyan
// only as a colour. Siblings are the tab pattern used everywhere else in Codex.
// One control for both would make the hierarchy it expresses invisible.

function ScopePath({ topicId, topicName }) {
  const crumbs = [{ key: "all", label: "Overall", hash: "#/report", here: !topicId }];
  // At module scope the topic stays current: the module is a tab, not a crumb.
  if (topicId) {
    crumbs.push({ key: topicId, label: topicName || topicId, hash: reportHash(topicId), here: true });
  }
  return h("nav", { class: "rc-path", "aria-label": "Scope" },
    crumbs.map((c, i) =>
      h(Fragment, { key: c.key },
        i > 0 && h("span", { class: "rc-sep" }, "›"),
        h("button", {
          class: `rc-crumb ${c.here ? "here" : ""}`,
          "aria-current": c.here ? "true" : null,
          onClick: () => navigate(c.hash),
        }, c.label))));
}

// Each tab carries its own count and score, so the switcher summarises as well
// as navigates — the weak module is visible before you click into it.
function ScopeTabs({ items, active }) {
  return h("div", { class: "rc-tabs", role: "tablist" },
    items.map(it =>
      h("button", {
        key: String(it.key),
        class: `rc-tab ${it.key === active ? "on" : ""}`,
        role: "tab", "aria-selected": it.key === active ? "true" : "false",
        onClick: () => navigate(it.hash),
      },
        h("span", { class: "t" }, it.title),
        // Below 600px the full reading name is swapped for the module code.
        // Five full names cannot fit 380px — even the mockup's hand-shortened
        // ones overflow — and acceptance asks for no scroll at that width.
        h("span", { class: "t-short" }, it.short || it.title),
        it.note && h("span", { class: `n ${it.warn ? "warn" : ""}` }, it.note),
      )));
}

// ── ladder ────────────────────────────────────────────────────────────────────

function EvidenceChip({ attempt, showModule }) {
  const where = [
    showModule && attempt.module != null ? `M${attempt.module}` : null,
    attempt.vignette != null ? `V${attempt.vignette}` : null,
    attempt.q != null ? `Q${attempt.q}` : null,
  ].filter(Boolean).join(" ");
  return h("span", { class: `rc-q ${attempt.is_correct ? "hit" : "miss"}` },
    where || (attempt.is_correct ? "hit" : "miss"),
    !attempt.is_correct && attempt.error_class &&
      h("em", null, humanClass(attempt.error_class)),
  );
}

// The row is the claim; the expansion is the evidence for it. Position and error
// class only — a chip never carries question or vignette text.
function LadderRow({ stat, concept, attempts, spans, isOpen, onToggle, readingId }) {
  const ra = Number(stat.round_attempts || 0);
  const shown = ra ? pctOf(stat.round_hits, ra) : Math.round(100 * Number(stat.hit_rate || 0));
  // A concept that graduated and came back reads as a different thing from one
  // that never left.
  const returned = Number(stat.last_fail_round || 0) > 1;
  const sub = [stat.root_ref, spans].filter(Boolean).join(" · ");

  return h(Fragment, null,
    h("div", {
      class: `rc-row ${isOpen ? "open" : ""}`,
      role: "button", tabIndex: 0, "aria-expanded": isOpen ? "true" : "false",
      onClick: onToggle,
      onKeyDown: e => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(); }
      },
    },
      h("div", { class: "rc-lbl" }, stat.label, sub && h("small", null, sub)),
      h(Pips, { seq: attempts.map(a => !!a.is_correct) }),
      h("div", { class: `rc-rate ${rateClass(shown)}` }, `${shown}%`,
        h("small", null, `${Number(stat.lt_hits || 0)} of ${Number(stat.lt_attempts || 0)}`)),
      h("div", { class: "rc-tagwrap" },
        h("div", { class: `rc-tag ${TAG_CLASS[stat.remediation] || "mt"}` }, stat.remediation),
        returned && h("div", { class: "rc-tag rt" }, "RETURNED")),
      h("div", { class: "rc-chev" }, "›"),
    ),
    isOpen && h("div", { class: "rc-det open" },
      concept?.correction && h("div", { class: "rc-fix" },
        h("b", null, "The fix"), concept.correction),
      attempts.length > 0 && h("div", { class: "rc-ev" },
        attempts.map(a => h(EvidenceChip, { key: a.id, attempt: a, showModule: !!spans }))),
      // Editorial, not derivable here. Omitted rather than invented while null.
      concept?.pattern_note && h("p", { class: "rc-evnote" }, concept.pattern_note),
      h("div", { class: "rc-acts" },
        h("button", {
          class: "rc-btn", disabled: !readingId,
          onClick: e => { e.stopPropagation(); readingId && navigate(`#/read/${readingId}`); },
        }, "OPEN READING"),
        h("button", {
          class: "rc-btn", disabled: true,
          title: "Enabled once the concept-to-unit mapping lands",
        }, "ADD TO REVIEW"),
      ),
    ),
  );
}

function LadderGroup({ title, tag, meta, children, dimmed, note }) {
  return h("div", { class: `rc-grp ${dimmed ? "dim" : ""}` },
    h("div", { class: "rc-ghead" },
      h("div", { class: "rc-gtitle" }, tag && h("b", null, tag), title),
      meta && h("div", { class: "rc-gmeta" }, meta),
    ),
    note ? h("div", { class: "rc-gnote" }, note) : children,
  );
}

function Bars({ items }) {
  return h("div", { class: "rc-mods" },
    items.map(m =>
      h("div", { key: String(m.key), class: "rc-mod" },
        h("span", null, m.label),
        h("span", { class: "rc-attempts" },
          m.rounds != null ? h(Fragment, null,
            plural(m.rounds, "attempt", "attempts"), " · ",
            h("b", null, `${m.attempted} q`)) : `${m.attempted} q`),
        h("div", { class: "rc-bar" },
          h("div", { class: "rc-fill", style: { width: pct0(m.score) } }),
          h("div", { class: "rc-mps" })),
        h("span", { class: "rc-pct" }, `${m.correct}/${m.attempted} · ${pct0(m.score)}`),
      )));
}

// ── the view ──────────────────────────────────────────────────────────────────

function ReportCard({ topicId, module }) {
  const [data, setData] = useState(null);
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState(null);
  const [open, setOpen] = useState({});

  useEffect(() => {
    (async () => {
      try {
        const sb = await getClient();
        const [statsRes, conceptRes, attRes, topicRes, modRes, roundRes] = await Promise.all([
          sb.from("codex_concept_stats").select("*"),
          sb.from("codex_concepts").select("concept_tag, correction, pattern_note"),
          sb.from("codex_attempt_scope")
            .select("id, concept_tag, topic_id, topic_name, module, vignette, q, round, is_correct, error_class, is_reconstructed, reading_id, reading")
            .order("round").order("id"),
          sb.from("codex_topic_stats").select("*"),
          sb.from("codex_module_stats").select("*").order("module"),
          sb.from("codex_rounds").select("topic_id, round, conditions"),
        ]);
        const bad = statsRes.error || attRes.error || topicRes.error || modRes.error;
        if (bad) {
          if (isMissingRelation(bad)) { setPending(true); return; }
          throw bad;
        }
        const byTag = {};
        for (const c of (conceptRes.data || [])) byTag[c.concept_tag] = c;
        setData({
          stats: statsRes.data || [],
          concepts: byTag,
          attempts: attRes.data || [],
          topics: topicRes.data || [],
          modules: modRes.data || [],
          rounds: roundRes.error ? [] : (roundRes.data || []),
        });
      } catch (e) { setErr(e.message); }
    })();
  }, []);

  if (err) return h(ErrorBox, { msg: err });
  if (pending) return h(NotProvisioned, { reads: "codex_concept_stats, codex_attempt_scope, codex_topic_stats" });
  if (!data) return h(Loader);
  if (!data.topics.length) {
    return h("div", { class: "rc-empty" },
      h("b", null, "No attempts logged"),
      h("p", null, "The ladder builds itself from the attempt ledger. Log a round and it appears here."));
  }

  // Deficit-first everywhere a list is ranked.
  const topics = [...data.topics].sort((a, b) => Number(a.score) - Number(b.score));
  const activeTopic = topicId && topics.find(t => t.topic_id === topicId) ? topicId : null;
  const scope = activeTopic ? (module != null ? "module" : "topic") : "overall";
  const topicRow = topics.find(t => t.topic_id === activeTopic);
  const mods = data.modules
    .filter(m => !activeTopic || m.topic_id === activeTopic)
    .sort((a, b) => Number(a.score) - Number(b.score));
  const modRow = module != null ? mods.find(m => Number(m.module) === module) : null;

  const inScope = data.attempts.filter(a =>
    (!activeTopic || a.topic_id === activeTopic) &&
    (module == null || Number(a.module) === module));

  const attemptsByTag = {};
  for (const a of data.attempts) {
    if (a.concept_tag) (attemptsByTag[a.concept_tag] ||= []).push(a);
  }
  const tagsInScope = new Set(inScope.map(a => a.concept_tag).filter(Boolean));
  const stats = data.stats.filter(s =>
    (!activeTopic || s.topic_id === activeTopic) &&
    (module == null || tagsInScope.has(s.concept_tag)));

  // ── switcher ────────────────────────────────────────────────────────────────
  const tabs = scope === "overall"
    ? [{ key: "all", title: "All topics", short: "All", hash: "#/report",
         note: `${sum(topics, t => t.attempted)} q · ${pct0(weightedScore(topics))}` },
       ...topics.map(t => ({
         key: t.topic_id, title: t.topic_name, short: String(t.topic_id).toUpperCase(),
         hash: reportHash(t.topic_id),
         note: `${t.attempted} q · ${pct0(t.score)}`, warn: Number(t.score) < BELOW_THRESHOLD }))]
    : [{ key: "all", title: "All modules", short: "All", hash: reportHash(activeTopic),
         note: `${topicRow?.attempted ?? 0} q · ${pct1(topicRow?.score)}` },
       ...mods.map(m => ({
         key: m.module, title: `M${m.module} ${shortReading(m.reading)}`, short: `M${m.module}`,
         hash: reportHash(activeTopic, m.module),
         note: `${m.attempted} q · ${pct0(m.score)}`, warn: Number(m.score) < BELOW_THRESHOLD }))];
  const activeTab = scope === "overall" ? "all" : (module != null ? module : "all");

  // ── headline ────────────────────────────────────────────────────────────────
  const relearn = stats.filter(s => s.remediation === "RELEARN").length;
  const checklist = stats.filter(s => s.remediation === "CHECKLIST").length;
  const attempted = scope === "module" ? Number(modRow?.attempted || 0)
    : scope === "topic" ? Number(topicRow?.attempted || 0)
    : sum(topics, t => t.attempted);
  const correct = scope === "module" ? Number(modRow?.correct || 0)
    : scope === "topic" ? Number(topicRow?.correct || 0)
    : sum(topics, t => t.correct);
  const rounds = scope === "module" ? Number(modRow?.rounds_taken || 0)
    : scope === "topic" ? Number(topicRow?.rounds_taken || 0) : null;

  const cells = [
    { k: "Attempted", v: attempted, n: scope === "module"
        ? `${plural(Number(modRow?.vignettes || 0), "vignette", "vignettes")} · ${plural(rounds, "attempt", "attempts")}`
        : scope === "topic"
          ? `${plural(Number(topicRow?.modules || 0), "module", "modules")} · ${plural(rounds, "attempt", "attempts")}`
          : plural(topics.length, "topic", "topics") },
  ];
  if (scope === "overall") {
    // A raw mean across topics lets a strong Alternatives round mask an FSA
    // hole, which is the exact failure this view exists to prevent.
    cells.push({ k: "Weighted score", v: pct1(weightedScore(topics)), cls: "am",
                 n: `${pct1(attempted ? correct / attempted : 0)} raw · ${correct} correct` });
  } else {
    cells.push({ k: "Score", v: pct1(scope === "module" ? modRow?.score : topicRow?.score),
                 cls: "am", n: `${correct} correct` });
  }
  cells.push({ k: "Relearn", v: relearn, cls: "rd", n: "concepts" });
  cells.push({ k: "Checklist", v: checklist, cls: "am", n: "concepts" });
  if (scope === "overall") {
    cells.push({ k: "Topics worked", v: topics.length, cls: "cy", n: "with attempts" });
  } else if (scope === "topic") {
    cells.push({ k: "Exam weight", v: `${num(topicRow?.weight_low)}–${num(topicRow?.weight_high)}%`,
                 cls: "cy", n: "of Level II" });
  } else {
    cells.push({ k: "Reconstructed", v: Number(modRow?.reconstructed || 0), cls: "cy", n: "of these attempts" });
  }

  // The caveat belongs to a topic's round, so it shows wherever the scope
  // resolves to a single topic.
  const caveatTopic = activeTopic || (topics.length === 1 ? topics[0].topic_id : null);
  const caveatRound = caveatTopic
    ? Math.max(1, ...inScope.filter(a => a.topic_id === caveatTopic).map(a => Number(a.round) || 1))
    : null;
  const conditions = caveatTopic
    ? data.rounds.find(r => r.topic_id === caveatTopic && Number(r.round) === caveatRound)?.conditions
    : null;

  // ── groups ──────────────────────────────────────────────────────────────────
  const groups = buildGroups({ scope, topics, mods, stats, inScope, attemptsByTag, activeTopic, module });

  const bars = scope === "overall"
    ? topics.map(t => ({ key: t.topic_id, label: t.topic_name, attempted: t.attempted,
                         correct: t.correct, score: t.score, rounds: t.rounds_taken }))
    : scope === "topic"
      ? mods.map(m => ({ key: m.module, label: `M${m.module} · ${m.reading || `Module ${m.module}`}`,
                         attempted: m.attempted, correct: m.correct, score: m.score, rounds: m.rounds_taken }))
      : vignetteRollup(inScope).map(v => ({ key: v.vignette, label: `Vignette ${v.vignette}`,
                         attempted: v.attempted, correct: v.correct, score: v.score, rounds: null }));


  return h(Fragment, null,
    h(ScopePath, { topicId: activeTopic, topicName: topicRow?.topic_name }),
    h(ScopeTabs, { items: tabs, active: activeTab }),

    h("div", { class: "rc-strip" },
      cells.map(c =>
        h("div", { key: c.k, class: "rc-cell" },
          h("div", { class: "rc-cell-k" }, c.k),
          h("div", { class: `rc-cell-v ${c.cls || ""}` }, c.v),
          h("div", { class: "rc-cell-n" }, c.n),
        ))),

    conditions
      ? h("div", { class: "rc-caveat" }, conditions)
      : h("div", { class: "rc-caveat rc-caveat-empty" },
          "Conditions for this round were not recorded, so the score has no " +
          "context attached to it — read it as a ceiling, not a position."),

    h("h3", { class: "rc-sec" },
      scope === "module" ? "Concept ladder — by vignette"
        : scope === "overall" ? "Concept ladder — by topic" : "Concept ladder — by reading"),
    h("p", { class: "rc-secnote" },
      scope === "topic"
        ? "Grouped the way the material is packaged, so a reading you open lines " +
          "up with the concepts you owe it. Click any row for the evidence and the fix."
        : "Sorted by hit rate within each group. Click any row for the evidence and the fix."),

    groups.length === 0
      ? h("div", { class: "rc-empty" },
          h("b", null, "No concepts registered in this scope"),
          h("p", null, "A concept joins the ladder once a miss repeats. One-off " +
            "misses stay in the attempt ledger until something recurs."))
      : groups.map(g =>
          h(LadderGroup, {
            key: String(g.key), title: g.title, tag: g.tag, meta: g.meta,
            dimmed: g.rows.length === 0, note: g.rows.length === 0 ? g.note : null,
          },
            g.rows.map(s =>
              h(LadderRow, {
                key: s.concept_tag, stat: s,
                concept: data.concepts[s.concept_tag],
                attempts: attemptsByTag[s.concept_tag] || [],
                spans: spansNote(s, attemptsByTag[s.concept_tag] || [], scope),
                readingId: readingFor(s, attemptsByTag[s.concept_tag] || []),
                isOpen: !!open[s.concept_tag],
                onToggle: () => setOpen(o => ({ ...o, [s.concept_tag]: !o[s.concept_tag] })),
              })))),

    bars.length > 0 && h(Fragment, null,
      h("h3", { class: "rc-sec", style: { marginTop: "26px" } },
        scope === "module" ? "By vignette" : scope === "overall" ? "By topic" : "By module"),
      h("p", { class: "rc-secnote" },
        "Amber line marks the 70% working threshold. " +
        (scope === "module" ? "" : "The attempts column matters: 50% on one attempt is a different claim from 50% on three.")),
      h(Bars, { items: bars }),
    ),
  );
}

// ── scope helpers ─────────────────────────────────────────────────────────────

function sum(rows, pick) {
  return rows.reduce((n, r) => n + Number(pick(r) || 0), 0);
}
function num(x) {
  return x == null ? "—" : String(Number(x));
}

// Exam-weighted mean across topics: Σ(score × midpoint) / Σ(midpoint).
function weightedScore(topics) {
  let top = 0, bot = 0;
  for (const t of topics) {
    const mid = (Number(t.weight_low || 0) + Number(t.weight_high || 0)) / 2;
    if (!mid) continue;
    top += Number(t.score || 0) * mid;
    bot += mid;
  }
  return bot ? top / bot : 0;
}

// The reading title in a tab has to survive a narrow tab strip: drop the
// throat-clearing opener, keep two words, and never end on a connector.
const TAB_FILLER = /^(introduction to|overview of|investments in|an? )\s*/i;
const TAB_TRAILING = /[\s&]+(of|in|to|the|and|through|a|an)?$/i;

function shortReading(reading) {
  const s = String(reading || "").replace(TAB_FILLER, "");
  return s.split(/\s+/).slice(0, 2).join(" ").replace(TAB_TRAILING, "").trim();
}

function vignetteRollup(attempts) {
  const by = new Map();
  for (const a of attempts) {
    if (a.vignette == null) continue;
    const v = by.get(a.vignette) || { vignette: a.vignette, attempted: 0, correct: 0 };
    v.attempted++;
    if (a.is_correct) v.correct++;
    by.set(a.vignette, v);
  }
  return [...by.values()]
    .map(v => ({ ...v, score: v.attempted ? v.correct / v.attempted : 0 }))
    .sort((a, b) => a.score - b.score);
}

// A concept is homed once and annotated elsewhere, never duplicated.
function spansNote(stat, attempts, scope) {
  if (scope === "overall") return null;
  const home = scope === "module" ? firstVignette(attempts) : stat.module;
  const others = [...new Set(attempts.map(a => scope === "module" ? a.vignette : a.module))]
    .filter(k => k != null && Number(k) !== Number(home));
  if (!others.length) return null;
  const prefix = scope === "module" ? "V" : "M";
  return `also appears in ${others.map(o => prefix + o).join(", ")}`;
}

function firstVignette(attempts) {
  return attempts.length ? attempts[0].vignette : null;
}

function readingFor(stat, attempts) {
  const own = attempts.find(a => Number(a.module) === Number(stat.module) && a.reading_id);
  return own?.reading_id || attempts.find(a => a.reading_id)?.reading_id || null;
}

// Builds the ladder's groups for a scope. A group with no recurring concepts
// still renders — suppressing it would hide a reading that has been worked.
function buildGroups({ scope, topics, mods, stats, inScope, attemptsByTag, module }) {
  const homeOf = s => scope === "overall" ? s.topic_id
    : scope === "topic" ? (s.module == null ? null : Number(s.module))
    : firstVignette(attemptsByTag[s.concept_tag] || []);

  const rowsFor = key => stats
    .filter(s => {
      const home = homeOf(s);
      return String(home) === String(key);
    })
    .sort(ladderOrder);

  const oneOffNote = (rows, attempts) => {
    if (rows.length) return null;
    const misses = attempts.filter(a => !a.is_correct);
    const oneOffs = misses.filter(a => !a.concept_tag).length;
    const carried = misses.length - oneOffs;
    if (!misses.length) return "No misses. Nothing owed here.";
    return `No recurring concepts. ${plural(misses.length, "miss", "misses")}` +
      (oneOffs === misses.length
        ? ", all one-offs."
        : `, ${oneOffs} one-off and ${carried} carried under another group.`);
  };

  if (scope === "overall") {
    return topics.map(t => {
      const rows = rowsFor(t.topic_id);
      const att = inScope.filter(a => a.topic_id === t.topic_id);
      return {
        key: t.topic_id, tag: null, title: t.topic_name,
        meta: h(Fragment, null,
          h("em", null, `${t.correct}/${t.attempted} · ${pct0(t.score)}`),
          ` · ${plural(Number(t.modules || 0), "module", "modules")}` +
          ` · ${plural(Number(t.rounds_taken || 0), "attempt", "attempts")}`),
        rows, note: oneOffNote(rows, att),
      };
    });
  }

  if (scope === "topic") {
    return mods.map(m => {
      const rows = rowsFor(Number(m.module));
      const att = inScope.filter(a => Number(a.module) === Number(m.module));
      const recon = Number(m.reconstructed || 0);
      return {
        key: m.module, tag: `M${m.module}`, title: m.reading || `Module ${m.module}`,
        meta: h(Fragment, null,
          h("em", null, `${m.correct}/${m.attempted} · ${pct0(m.score)}`),
          ` · ${plural(Number(m.vignettes || 0), "vignette", "vignettes")}` +
          ` · ${plural(Number(m.rounds_taken || 0), "attempt", "attempts")}` +
          (recon ? ` · ${recon} reconstructed` : "")),
        rows, note: oneOffNote(rows, att),
      };
    });
  }

  return vignetteRollup(inScope).map(v => {
    const rows = rowsFor(v.vignette);
    const att = inScope.filter(a => Number(a.vignette) === Number(v.vignette));
    return {
      key: v.vignette, tag: `V${v.vignette}`, title: `Vignette ${v.vignette}`,
      meta: h("em", null, `${v.correct}/${v.attempted} · ${pct0(v.score)}`),
      rows, note: oneOffNote(rows, att),
    };
  });
}

// ── Review queue ──────────────────────────────────────────────────────────────
// Two sections, two different triggers, and they must stay different. RELEARN
// cards are spaced and fetched on mount by due date. PRIMING cards are fetched
// when a practice session opens, because an execution failure has to be primed
// in the seconds before the attempt, not three days earlier.
//
// Cards are the lesson units already in Codex, reached through the
// codex_concept_units join. No card content is authored here — the tag is the
// join, and the card is a pointer back into the lesson.

// The join is what makes any of this render, so it is loaded the same way by
// the queue and by the priming path.
async function loadConceptCards(sb) {
  const [statsRes, joinRes] = await Promise.all([
    sb.from("codex_concept_stats").select("*"),
    sb.from("codex_concept_units").select("concept_tag, unit_id"),
  ]);
  if (statsRes.error || joinRes.error) return { error: statsRes.error || joinRes.error };

  const join = joinRes.data || [];
  const ids = [...new Set(join.map(j => j.unit_id))];
  const unitsRes = ids.length
    ? await sb.from("codex_units").select("id, reading_id, kind, title, payload").in("id", ids)
    : { data: [] };
  if (unitsRes.error) return { error: unitsRes.error };

  const unitById = {};
  for (const u of (unitsRes.data || [])) unitById[u.id] = u;
  const cards = join
    .map(j => ({ concept_tag: j.concept_tag, unit: unitById[j.unit_id] }))
    .filter(c => c.unit && isCardable(c.unit));
  return { stats: statsRes.data || [], cards, mapped: join.length };
}

function ReviewQueue() {
  const [data, setData] = useState(null);
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(null);
  const [session, setSession] = useState(0);

  useEffect(() => {
    (async () => {
      try {
        const sb = await getClient();
        const loaded = await loadConceptCards(sb);
        if (loaded.error) {
          if (isMissingRelation(loaded.error)) { setPending(true); return; }
          throw loaded.error;
        }
        const schedRes = await sb.from("codex_drill_progress")
          .select("chunk_id, ef, interval_days, next_due")
          .eq("item_type", REVIEW_ITEM_TYPE);
        const sched = {};
        for (const r of (schedRes.data || [])) sched[r.chunk_id] = r;
        setData({ ...loaded, sched });
      } catch (e) { setErr(e.message); }
    })();
  }, []);

  // Grading moves the card's SM-2 schedule. Binary in, quality 4 or 1 out —
  // the same mapping the practice units use, so one scheduler governs both.
  const grade = useCallback(async (unitId, got) => {
    setBusy(unitId);
    try {
      const sb = await getClient();
      const prev = data.sched[unitId] || { ef: 2.5, interval_days: 0 };
      const { ef, interval, nextDue } =
        sm2Next(got ? GRADE_QUALITY.got : GRADE_QUALITY.missed,
                Number(prev.ef) || 2.5, Number(prev.interval_days) || 0);
      const row = {
        chunk_id: unitId, item_type: REVIEW_ITEM_TYPE,
        ef, interval_days: interval, next_due: nextDue,
        updated_at: new Date().toISOString(),
      };
      const { error } = await sb.from("codex_drill_progress")
        .upsert(row, { onConflict: "chunk_id,item_type" });
      if (error) throw error;
      setData(d => ({ ...d, sched: { ...d.sched, [unitId]: row } }));
    } catch (e) { setErr(e.message); }
    finally { setBusy(null); }
  }, [data]);

  if (err) return h(ErrorBox, { msg: err });
  if (pending) return h(NotProvisioned, { reads: "codex_concept_stats, codex_concept_units" });
  if (!data) return h(Loader);

  const statOf = {};
  for (const s of data.stats) statOf[s.concept_tag] = s;

  const now = Date.now();
  const due = data.cards
    .filter(c => statOf[c.concept_tag]?.remediation === "RELEARN")
    .filter(c => isDue(data.sched[c.unit.id], now))
    .sort((a, b) => ladderOrder(statOf[a.concept_tag], statOf[b.concept_tag]));

  const primingPool = data.cards.filter(c =>
    statOf[c.concept_tag]?.remediation === "CHECKLIST");

  return h(Fragment, null,
    h("div", { class: "rc-qhead" },
      h("div", null,
        h("h3", { class: "rc-sec" }, "Targeted review"),
        h("p", { class: "rc-secnote", style: { margin: 0 } },
          "Cards are pulled from lesson units already in Codex, filtered by " +
          "concept tag. No new content — the tag is the join.")),
      h("div", { class: "rc-stamp" },
        `${due.length} RELEARN · ${primingPool.length} PRIMING`),
    ),

    due.length === 0
      ? h("div", { class: "rc-empty" },
          data.mapped === 0
            ? h(Fragment, null,
                h("b", null, "Nothing due"),
                h("p", null, "Cards appear here once lesson units are tagged with a ",
                  h("code", null, "concept_tag"), " in ",
                  h("code", null, "codex_concept_units"), "."))
            : h(Fragment, null,
                h("b", null, "Nothing due"),
                h("p", null, "Every RELEARN card is scheduled ahead. The next one " +
                  "comes back on its review interval.")))
      : due.map(c =>
          h(ReviewCard, {
            key: c.unit.id, unit: c.unit, conceptTag: c.concept_tag,
            stat: statOf[c.concept_tag],
            sched: data.sched[c.unit.id],
            busy: busy === c.unit.id,
            onGrade: got => grade(c.unit.id, got),
          })),

    h("div", { class: "rc-rule" }),
    h("h3", { class: "rc-sec" }, "Priming — fires before your next attempt"),
    h("p", { class: "rc-secnote" },
      "Not on a spaced interval and not on a due date. These are execution " +
      "failures, so the card has to land in the seconds before you answer. They " +
      "are fetched when a practice session opens — the practice items inside a " +
      "reading trigger the same fetch."),

    session
      ? h(PrimingCards, { sessionKey: session })
      : h("button", {
          class: "rc-btn", onClick: () => setSession(Date.now()),
        }, "OPEN A PRACTICE SESSION"),
  );
}

function ReviewCard({ unit, conceptTag, stat, sched, busy, onGrade }) {
  const back = excerpt(unit);
  const reps = sched ? `REVIEWED · ${sched.interval_days}D` : "NEW";
  return h("div", { class: "rc-card" },
    h("div", { class: "rc-card-meta" },
      h("span", null, `RELEARN · ${conceptTag}`),
      h("span", null, [
        `${Number(stat?.lt_hits || 0)}/${Number(stat?.lt_attempts || 0)}`,
        stat?.root_ref, reps,
      ].filter(Boolean).join(" · ")),
    ),
    h("div", { class: "rc-card-body" },
      h("div", { class: "rc-front" }, unit.title || KIND_LABEL[unit.kind] || "Lesson unit"),
      back && h("div", { class: "rc-back" }, back),
    ),
    h("div", { class: "rc-acts" },
      h("button", { class: "rc-btn", disabled: busy, onClick: () => onGrade(true) }, "GOT IT"),
      h("button", { class: "rc-btn", disabled: busy, onClick: () => onGrade(false) }, "MISSED IT"),
      h("button", {
        class: "rc-btn", disabled: !unit.reading_id,
        title: unit.reading_id ? "" : "This card has no resolvable lesson",
        onClick: () => unit.reading_id && navigate(`#/read/${unit.reading_id}`),
      }, "OPEN LESSON"),
    ),
  );
}

// Display-only by design: one line, no front, no grade control. Showing one
// writes an exposure row and nothing else.
function PrimingCards({ sessionKey, compact }) {
  const [cards, setCards] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const sb = await getClient();
        const loaded = await loadConceptCards(sb);
        if (loaded.error) { if (alive) setCards([]); return; }
        const statOf = {};
        for (const s of loaded.stats) statOf[s.concept_tag] = s;
        // No due date and no interval: everything tagged CHECKLIST primes, every
        // time a session opens.
        const picked = loaded.cards
          .filter(c => statOf[c.concept_tag]?.remediation === "CHECKLIST")
          .map(c => ({ ...c, stat: statOf[c.concept_tag] }));
        if (!alive) return;
        setCards(picked);
        if (picked.length) {
          // Exposure only — no grade and no schedule move. session_type is what
          // separates a priming exposure from an ordinary view of the same unit,
          // which is the whole point of the second trigger.
          await sb.from("codex_unit_progress").upsert(picked.map(c => ({
            tenant_id: CODEX_TENANT, unit_id: c.unit.id,
            status: "viewed", session_type: "PRIMING",
            last_viewed: new Date().toISOString(),
          })), { onConflict: "tenant_id,unit_id" });
        }
      } catch { if (alive) setCards([]); }
    })();
    return () => { alive = false; };
  }, [sessionKey]);

  // Inside a practice item this is an aside, so it stays silent when it has
  // nothing to say rather than reporting on itself mid-attempt.
  if (compact) {
    if (!cards || !cards.length) return null;
    return h("div", { class: "rc-prime-strip" },
      h("div", { class: "rc-prime-head" }, "Before you answer"),
      cards.map(c => h(PrimingCard, { key: c.unit.id, card: c })),
    );
  }

  if (!cards) return h(Loader);
  if (!cards.length) {
    return h("div", { class: "rc-empty" },
      h("b", null, "Nothing to prime"),
      h("p", null, "Priming lines come from concepts tagged CHECKLIST that have a " +
        "lesson unit mapped to them. Once ", h("code", null, "codex_concept_units"),
        " is filled, they appear here whenever a session opens."));
  }
  return h(Fragment, null, cards.map(c => h(PrimingCard, { key: c.unit.id, card: c })));
}

// One line, no front, no grade control.
function PrimingCard({ card }) {
  const s = card.stat;
  return h("div", { class: "rc-card prime" },
    h("div", { class: "rc-card-meta" },
      h("span", null, `PRIMING · ${card.concept_tag}`),
      h("span", null, [
        s ? `${Number(s.lt_hits || 0)}/${Number(s.lt_attempts || 0)}` : null, s?.root_ref,
      ].filter(Boolean).join(" · ")),
    ),
    h("div", { class: "rc-card-body" },
      h("div", { class: "rc-back" }, excerpt(card.unit, 160) || card.unit.title)),
  );
}

// ── The loop ──────────────────────────────────────────────────────────────────

const LOOP_STEPS = [
  ["Attempt",    "Practice questions in the LES. Each miss maps to a concept tag."],
  ["Diagnose",   "Hit rate splits knowledge gaps from execution failures."],
  ["Review",     "RELEARN cards spaced; CHECKLIST cards primed before the next sitting."],
  ["Re-attempt", "Retake the module. Same concepts, new round."],
  ["Graduate",   "Two consecutive corrects in a later round clears the tag."],
];

function LoopView() {
  const [state, setState] = useState(null);
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const sb = await getClient();
        const [statsRes, attRes, unitRes] = await Promise.all([
          sb.from("codex_concept_stats").select("remediation"),
          sb.from("codex_attempts").select("round"),
          sb.from("codex_concept_units").select("unit_id"),
        ]);
        const bad = statsRes.error || attRes.error || unitRes.error;
        if (bad) {
          if (isMissingRelation(bad)) { setPending(true); return; }
          throw bad;
        }
        setState({
          stats: statsRes.data || [],
          rounds: (attRes.data || []).reduce((m, a) => Math.max(m, Number(a.round) || 1), 0),
          units: (unitRes.data || []).length,
        });
      } catch (e) { setErr(e.message); }
    })();
  }, []);

  if (err) return h(ErrorBox, { msg: err });
  if (pending) return h(NotProvisioned, { reads: "codex_concept_stats, codex_attempts" });
  if (!state) return h(Loader);

  // Where the loop actually stands, read off the data rather than pinned to a
  // step in a mockup.
  const tagged = state.stats.filter(s => s.remediation !== "MAINTAIN").length;
  const live =
    state.rounds === 0 ? 1 :
    state.units === 0  ? 2 :
    state.rounds === 1 ? 3 :
    tagged > 0         ? 4 : 5;

  return h(Fragment, null,
    h("h3", { class: "rc-sec" }, "The loop"),
    h("p", { class: "rc-secnote" }, "One concept, one lifecycle."),
    h("div", { class: "rc-steps" },
      LOOP_STEPS.map(([title, note], i) =>
        h("div", { key: title, class: `rc-step ${i + 1 === live ? "live" : ""}` },
          h("div", { class: "rc-step-n" }, String(i + 1).padStart(2, "0")),
          h("h5", null, title),
          h("p", null, note, i + 1 === live ? " You are here." : ""),
        ))),

    h("div", { class: "rc-gate" },
      h("h4", null, "Graduation rule"),
      h("p", null,
        "A concept clears when it is answered correctly twice in a round later " +
        "than its last failure. Hit rate displays per round, with lifetime " +
        "beneath it — otherwise an old miss weighs on the number forever and " +
        "nothing ever leaves the queue."),
      h("p", { style: { color: "var(--text-3)", fontSize: "12.5px" } },
        h("code", null, "MAINTAIN"),
        " concepts drop out of review but stay on the ladder. A later-round " +
        "failure returns the tag automatically — tags derive from the log, and " +
        "nothing in this app sets one directly."),
    ),

    state.units === 0 && h("div", { class: "rc-gate", style: { marginTop: "14px" } },
      h("h4", null, "What is blocking review"),
      h("p", null,
        "No concept is mapped to a lesson unit yet — ",
        h("code", null, "codex_concept_units"), " is empty. That mapping is the " +
        "join between the attempt ledger and the units already in Codex, and the " +
        "review queue stays empty until it exists. The report card does not " +
        "depend on it."),
    ),
  );
}

// ── Report card shell ─────────────────────────────────────────────────────────

const RC_TABS = [
  { key: "report", label: "Report card",    hash: "#/report" },
  { key: "review", label: "Review queue",   hash: "#/review" },
  { key: "loop",   label: "Close the loop", hash: "#/loop"   },
];

function ReportCardShell({ tab, topicId, module }) {
  const days = Math.ceil((EXAM_DATE - Date.now()) / DAY_MS);
  return h(Fragment, null,
    h("div", { class: "rc-head" },
      h("div", null,
        h("div", { class: "page-title" }, "Report Card"),
        h("div", { class: "page-sub", style: { marginBottom: 0 } },
          "The record is the concept. Questions are only the evidence."),
      ),
      h("div", { class: "rc-stamp" },
        h("div", null, "NEXT SITTING 19 NOV"),
        h("div", null, days > 0 ? `${days} DAYS` : "SAT"),
      ),
    ),
    h("div", { class: "rc-tabs views", role: "tablist" },
      RC_TABS.map(t =>
        h("button", {
          key: t.key, class: `rc-tab ${tab === t.key ? "on" : ""}`,
          role: "tab", "aria-selected": tab === t.key ? "true" : "false",
          onClick: () => navigate(t.hash),
        }, h("span", { class: "t" }, t.label)))),
    tab === "review" ? h(ReviewQueue)
      : tab === "loop" ? h(LoopView)
      : h(ReportCard, { topicId, module }),
  );
}

// ── App shell ──────────────────────────────────────────────────────────────────

function App() {
  const hash = useRoute();
  const [theme, setTheme] = useState(getStoredTheme);

  useEffect(() => { applyTheme(theme); }, []);

  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    setStoredTheme(next);
  };

  const readMatch  = hash.match(/^#\/read\/(.+)$/);
  const docMatch   = hash.match(/^#\/doc\/(.+)$/);   // legacy compat
  const isFormulas = hash === "#/formulas";
  const isDrill    = hash === "#/drill";
  const isLos      = hash === "#/los";
  const isReading  = !!(readMatch || docMatch);
  // Three tabs of one surface, each with its own hash so a view is linkable.
  // The report tab takes a scope path on top of that: #/report/alt/1.
  const scopeMatch = hash.match(RC_SCOPE_RE);
  const rcTab      = scopeMatch ? "report" : (RC_TABS.find(t => t.hash === hash)?.key || null);

  let page;
  if (readMatch)       page = h(ReadingPane, { docId: readMatch[1], theme, onToggleTheme: toggleTheme });
  else if (docMatch)   page = h(ReadingPane, { docId: docMatch[1],  theme, onToggleTheme: toggleTheme });
  else if (scopeMatch) page = h(ReportCardShell, {
                         tab: "report",
                         topicId: scopeMatch[1] || null,
                         module: scopeMatch[2] != null ? Number(scopeMatch[2]) : null,
                       });
  else if (rcTab)      page = h(ReportCardShell, { tab: rcTab });
  else if (isFormulas) page = h(FormulaSheet);
  else if (isDrill)    page = h(ExampleDrill);
  else if (isLos)      page = h(LosTracker);
  else                 page = h(Home);

  const isHome = !isReading && !isFormulas && !isDrill && !isLos && !rcTab;

  return h(Fragment, null,
    h("nav", { class: `topbar ${isReading ? "topbar-dim" : ""}` },
      h("div", { class: "topbar-brand" },
        "ATLAS CODEX",
        h("span", null, "CFA Level II · Nov 2026"),
      ),
      h("div", { class: "topbar-nav" },
        h("button", { class: `nav-btn ${isHome ? "active" : ""}`, onClick: () => navigate("#/") }, "Home"),
        h("button", { class: `nav-btn ${rcTab ? "active" : ""}`, onClick: () => navigate("#/report") }, "Report"),
        h("button", { class: `nav-btn ${isFormulas ? "active" : ""}`, onClick: () => navigate("#/formulas") }, "Formulas"),
        h("button", { class: `nav-btn ${isDrill ? "active" : ""}`, onClick: () => navigate("#/drill") }, "Drill"),
        h("button", { class: `nav-btn ${isLos ? "active" : ""}`, onClick: () => navigate("#/los") }, "LOS"),
      ),
    ),
    h("main", { class: `main ${isReading ? "main-reading" : ""}` }, page),
  );
}

render(h(App, null), document.getElementById("root"));
