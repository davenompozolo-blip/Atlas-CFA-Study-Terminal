import { h, render, Fragment } from "preact";
import { useState, useEffect, useCallback, useRef } from "preact/hooks";
import { createClient } from "@supabase/supabase-js";

// ── Supabase client (lazy-init after /api/config) ─────────────────────────────

let _sb = null;

async function getClient() {
  if (_sb) return _sb;
  const res = await fetch("/api/config");
  if (!res.ok) throw new Error("Could not load Supabase config from /api/config");
  const { url, key } = await res.json();
  if (!url || !key) throw new Error("Supabase config is empty — check Vercel env vars");
  _sb = createClient(url, key);
  return _sb;
}

// ── simple hash router ────────────────────────────────────────────────────────

function useRoute() {
  const [hash, setHash] = useState(window.location.hash || "#/");
  useEffect(() => {
    const onHash = () => setHash(window.location.hash || "#/");
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return hash;
}

function navigate(hash) {
  window.location.hash = hash;
}

// ── helpers ───────────────────────────────────────────────────────────────────

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
    h("span", { class: "mastery-val", style: { fontFamily: "var(--font-mono)" } },
      `${Math.round(pct)}%`
    ),
  );
}

// ── Home view ─────────────────────────────────────────────────────────────────

function Home() {
  const [topics, setTopics] = useState(null);
  const [docs, setDocs] = useState({});    // topic_id → [doc]
  const [open, setOpen] = useState({});
  const [err, setErr] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const sb = await getClient();
        const { data, error } = await sb
          .from("vw_codex_priority")
          .select("*");
        if (error) throw error;
        setTopics(data);
      } catch (e) {
        setErr(e.message);
      }
    })();
  }, []);

  const loadDocs = useCallback(async (topicId) => {
    if (docs[topicId]) return;
    const sb = await getClient();
    const { data } = await sb
      .from("codex_documents")
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

  const crit  = topics.filter(t => t.band === "crit");
  const focus = topics.filter(t => t.band === "focus");
  const hold  = topics.filter(t => t.band === "hold");

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
        h("div", { class: `stat-value ${avgMastery < 50 ? "red" : avgMastery < 68 ? "amber" : ""}` },
          `${avgMastery}%`),
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
          key: t.topic_id,
          topic: t,
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
      h("div", { class: "topic-name" },
        topic.name,
        h(Chip, { band: topic.band }),
      ),
      h(MasteryBar, { value: topic.avg_mastery }),
      h("span", { class: `focus-score ${focusHigh ? "high" : ""}` },
        `${Number(topic.focus_index).toFixed(0)} fi`
      ),
      h("span", { class: "expand-icon" }, "▼"),
    ),
    h("div", { class: "readings-panel" },
      docs === null
        ? h(Loader)
        : docs.length === 0
          ? h("div", { style: { color: "var(--text-3)", fontSize: 13 } }, "No documents loaded.")
          : h("div", { class: "readings-grid" },
              docs.map(doc =>
                h("div", {
                  key: doc.id,
                  class: "reading-card",
                  onClick: () => navigate(`#/doc/${doc.id}`),
                },
                  h("div", { class: "reading-title" }, doc.reading),
                  h("div", { class: "reading-meta" },
                    doc.lm ? `LM ${doc.lm}` : "",
                    `${doc.chunk_count} chunks`,
                    `${doc.los_count} LOS`,
                  ),
                )
              )
            )
    ),
  );
}

// ── Reading view ──────────────────────────────────────────────────────────────

function Reading({ docId }) {
  const [doc, setDoc] = useState(null);
  const [chunks, setChunks] = useState(null);
  const [los, setLos] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const sb = await getClient();
        const [docRes, chunksRes, losRes] = await Promise.all([
          sb.from("codex_documents").select("*, codex_topics(name,band)").eq("id", docId).single(),
          sb.from("codex_chunks").select("*").eq("doc_id", docId).order("ord"),
          sb.from("codex_los").select("*").eq("doc_id", docId).order("los_num"),
        ]);
        if (docRes.error) throw docRes.error;
        setDoc(docRes.data);
        setChunks(chunksRes.data || []);
        setLos(losRes.data || []);
      } catch (e) {
        setErr(e.message);
      }
    })();
  }, [docId]);

  if (err) return h(ErrorBox, { msg: err });
  if (!doc || !chunks) return h(Loader);

  const topicName = doc.codex_topics?.name || "";
  const topicBand = doc.codex_topics?.band || "hold";

  return h(Fragment, null,
    h("button", { class: "back-btn", onClick: () => navigate("#/") }, "← Back"),
    h("div", { class: "doc-title" }, doc.reading),
    h("div", { class: "doc-meta" },
      doc.lm && h("span", null, `LM ${doc.lm}`),
      h(Chip, { band: topicBand }),
      h("span", null, topicName),
      h("span", { style: { color: "var(--text-3)" } }, `${doc.pages || "?"} pages`),
    ),

    h("div", { class: "reading-layout" },
      h("div", null,
        h(ChunkList, { chunks }),
      ),
      h("div", { class: "los-rail" },
        h("div", { class: "los-rail-title" }, `Learning Outcomes (${los?.length || 0})`),
        los?.length === 0
          ? h("div", { style: { fontSize: 12, color: "var(--text-3)" } }, "No LOS extracted — run PR3 fallback.")
          : los?.map(l =>
              h("div", { key: l.id, class: "los-item" },
                h("span", { class: "los-num" }, l.los_num),
                h("div", null,
                  l.command_verb && h("span", { class: "los-verb" }, l.command_verb),
                  h("div", { class: "los-text" }, l.outcome),
                ),
              )
            ),
      ),
    ),
  );
}

function ChunkList({ chunks }) {
  let lastSection = null;
  const items = [];

  for (const chunk of chunks) {
    const secTitle = chunk.section_title;
    if (secTitle && secTitle !== lastSection) {
      lastSection = secTitle;
      items.push(
        h("div", { key: `sec-${chunk.ord}`, class: "section-divider" },
          secTitle
        )
      );
    }
    items.push(h(ChunkCard, { key: chunk.id, chunk }));
  }

  return h("div", { class: "chunk-list" }, ...items);
}

function ChunkCard({ chunk }) {
  const [expanded, setExpanded] = useState(true);
  const isFormula = chunk.is_formula;
  const isExample = chunk.is_example;
  const cls = isFormula ? "formula" : isExample ? "example" : "";

  return h("div", { class: `chunk-card ${cls}` },
    h("div", { class: "chunk-heading" },
      chunk.heading || (chunk.sub_no ? `§${chunk.sub_no}` : ""),
      isFormula && h("span", { class: "chunk-type-tag" }, "FORMULA"),
      isExample && h("span", { class: "chunk-type-tag" }, "EXAMPLE"),
    ),
    (isExample
      ? h(Fragment, null,
          expanded && h("div", { class: "chunk-body" }, chunk.body),
          h("button", { class: "example-toggle", onClick: () => setExpanded(v => !v) },
            expanded ? "▲ collapse" : "▼ show example"
          ),
        )
      : h("div", { class: "chunk-body" }, chunk.body)
    ),
  );
}

// ── Formula Sheet view ────────────────────────────────────────────────────────

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
            .eq("is_formula", true)
            .order("topic_id"),
        ]);
        if (topicsRes.error) throw topicsRes.error;
        if (formulasRes.error) throw formulasRes.error;
        setTopics(topicsRes.data || []);
        setFormulas(formulasRes.data || []);
      } catch (e) {
        setErr(e.message);
      }
    })();
  }, []);

  if (err) return h(ErrorBox, { msg: err });
  if (!formulas || !topics) return h(Loader);

  // sort topics by focus_index desc so deficit topics come first
  const topicOrder = [...topics].sort((a, b) => Number(b.focus_index) - Number(a.focus_index));
  const topicMap = Object.fromEntries(topics.map(t => [t.topic_id, t]));

  const filtered = filter === "all"
    ? formulas
    : formulas.filter(f => f.topic_id === filter);

  // group by topic preserving deficit order
  const grouped = [];
  for (const t of topicOrder) {
    const chunks = filtered.filter(f => f.topic_id === t.topic_id);
    if (chunks.length) grouped.push({ topic: t, chunks });
  }
  // any formulas whose topic isn't in vw_codex_priority
  const seen = new Set(topicOrder.map(t => t.topic_id));
  const orphan = filtered.filter(f => !seen.has(f.topic_id));
  if (orphan.length) grouped.push({ topic: null, chunks: orphan });

  return h(Fragment, null,
    h("div", { class: "page-title" }, "Formula Sheet"),
    h("div", { class: "page-sub" }, `${formulas.length} formulas · deficit topics first`),

    h("div", { class: "filter-bar" },
      h("button", {
        class: `filter-btn ${filter === "all" ? "active" : ""}`,
        onClick: () => setFilter("all"),
      }, "All"),
      topicOrder.map(t =>
        h("button", {
          key: t.topic_id,
          class: `filter-btn ${filter === t.topic_id ? "active" : ""}`,
          onClick: () => setFilter(t.topic_id),
        }, t.name)
      ),
    ),

    grouped.length === 0
      ? h("div", { class: "empty-state" }, "No formulas match.")
      : grouped.map(({ topic, chunks }) =>
          h("div", { key: topic?.topic_id || "orphan", class: "formula-group" },
            h("div", { class: "formula-group-header" },
              topic
                ? h(Fragment, null,
                    h("span", { class: "formula-group-name" }, topic.name),
                    h(Chip, { band: topic.band }),
                  )
                : h("span", { class: "formula-group-name" }, "Other"),
            ),
            h("div", { class: "formula-grid" },
              chunks.map(f =>
                h("div", { key: f.id, class: "formula-card" },
                  f.heading && h("div", { class: "formula-card-heading" }, f.heading),
                  h("div", { class: "formula-card-body" }, f.body),
                  f.lm && h("div", { class: "formula-card-meta" }, `LM ${f.lm}`),
                )
              )
            ),
          )
        ),
  );
}

// ── Example Drill view ────────────────────────────────────────────────────────

// SM-2 interval calculation
function sm2Next(quality, prevEF, prevInterval) {
  const ef = Math.max(1.3, prevEF + 0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
  let interval;
  if (quality < 3) {
    interval = 1;
  } else if (prevInterval <= 1) {
    interval = 1;
  } else if (prevInterval === 1) {
    interval = 6;
  } else {
    interval = Math.round(prevInterval * ef);
  }
  return { ef, interval, nextDue: new Date(Date.now() + interval * 86400000).toISOString() };
}

function ExampleDrill() {
  const [examples, setExamples] = useState(null);
  const [idx, setIdx] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [filter, setFilter] = useState("all");
  const [topics, setTopics] = useState(null);
  const [progress, setProgress] = useState({});  // chunk_id → {ef, interval, due}
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);
  const [sessionStats, setSessionStats] = useState({ rated: 0, due: 0 });

  useEffect(() => {
    (async () => {
      try {
        const sb = await getClient();
        const [topicsRes, examplesRes, progressRes] = await Promise.all([
          sb.from("vw_codex_priority").select("topic_id, name, band, focus_index"),
          sb.from("codex_chunks")
            .select("id, doc_id, topic_id, heading, body, lm, codex_topics(name, band)")
            .eq("is_example", true)
            .order("topic_id"),
          sb.from("codex_drill_progress")
            .select("chunk_id, ef, interval_days, next_due")
            .eq("item_type", "example"),
        ]);
        if (topicsRes.error) throw topicsRes.error;
        if (examplesRes.error) throw examplesRes.error;

        const prog = {};
        for (const p of (progressRes.data || [])) {
          prog[p.chunk_id] = { ef: p.ef, interval: p.interval_days, due: p.next_due };
        }

        const topicOrder = [...(topicsRes.data || [])].sort((a, b) => Number(b.focus_index) - Number(a.focus_index));
        setTopics(topicOrder);
        setProgress(prog);

        // sort: due first (deficit-topic-first within due), then new
        const now = new Date().toISOString();
        const due = [];
        const fresh = [];
        for (const ex of (examplesRes.data || [])) {
          const p = prog[ex.id];
          if (!p || p.due <= now) due.push(ex);
          else fresh.push(ex);
        }
        // stable topic-order sort within each bucket
        const topicRank = Object.fromEntries(topicOrder.map((t, i) => [t.topic_id, i]));
        const byRank = (a, b) => (topicRank[a.topic_id] ?? 999) - (topicRank[b.topic_id] ?? 999);
        due.sort(byRank);
        fresh.sort(byRank);

        const all = [...due, ...fresh];
        setExamples(all);
        setSessionStats({ rated: 0, due: due.length });
        setIdx(0);
        setRevealed(false);
      } catch (e) {
        setErr(e.message);
      }
    })();
  }, []);

  const filtered = examples
    ? (filter === "all" ? examples : examples.filter(e => e.topic_id === filter))
    : null;

  const card = filtered?.[idx] ?? null;

  const rate = useCallback(async (quality) => {
    if (!card) return;
    setSaving(true);
    try {
      const sb = await getClient();
      const prev = progress[card.id] || { ef: 2.5, interval: 0 };
      const next = sm2Next(quality, prev.ef, prev.interval);

      await sb.from("codex_reviews").insert({
        chunk_id: card.id,
        rating: quality,
        reviewed_at: new Date().toISOString(),
      });

      await sb.from("codex_drill_progress").upsert({
        chunk_id: card.id,
        item_type: "example",
        ef: next.ef,
        interval_days: next.interval,
        next_due: next.nextDue,
        updated_at: new Date().toISOString(),
      }, { onConflict: "chunk_id,item_type" });

      setProgress(prev => ({ ...prev, [card.id]: { ef: next.ef, interval: next.interval, due: next.nextDue } }));
      setSessionStats(s => ({ ...s, rated: s.rated + 1 }));
      setIdx(i => i + 1);
      setRevealed(false);
    } catch (e) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  }, [card, progress]);

  if (err) return h(ErrorBox, { msg: err });
  if (!filtered) return h(Loader);

  const done = idx >= filtered.length;

  return h(Fragment, null,
    h("div", { class: "page-title" }, "Example Drill"),
    h("div", { class: "page-sub" },
      `${sessionStats.due} due · ${sessionStats.rated} rated this session`
    ),

    h("div", { class: "filter-bar" },
      h("button", {
        class: `filter-btn ${filter === "all" ? "active" : ""}`,
        onClick: () => { setFilter("all"); setIdx(0); setRevealed(false); },
      }, "All"),
      (topics || []).map(t =>
        h("button", {
          key: t.topic_id,
          class: `filter-btn ${filter === t.topic_id ? "active" : ""}`,
          onClick: () => { setFilter(t.topic_id); setIdx(0); setRevealed(false); },
        }, t.name)
      ),
    ),

    done
      ? h("div", { class: "drill-done" },
          h("div", { class: "drill-done-icon" }, "✓"),
          h("div", { class: "drill-done-title" }, "Session complete"),
          h("div", { class: "drill-done-sub" },
            `You rated ${sessionStats.rated} example${sessionStats.rated !== 1 ? "s" : ""}.`
          ),
          h("button", { class: "drill-restart", onClick: () => { setIdx(0); setRevealed(false); } },
            "Restart"
          ),
        )
      : h(Fragment, null,
          h("div", { class: "drill-progress" },
            h("div", { class: "drill-progress-bar" },
              h("div", { class: "drill-progress-fill", style: { width: `${(idx / filtered.length) * 100}%` } })
            ),
            h("span", { class: "drill-progress-label" }, `${idx + 1} / ${filtered.length}`),
          ),

          h("div", { class: "drill-card" },
            h("div", { class: "drill-card-meta" },
              card.codex_topics?.name && h("span", null, card.codex_topics.name),
              card.codex_topics?.band && h(Chip, { band: card.codex_topics.band }),
              card.lm && h("span", null, `LM ${card.lm}`),
            ),
            card.heading && h("div", { class: "drill-card-heading" }, card.heading),

            h("div", { class: "drill-card-prompt" }, "Work through this example:"),
            h("div", { class: "drill-card-body" },
              revealed
                ? card.body
                : h("div", { class: "drill-hidden" },
                    h("div", { class: "drill-hidden-text" }, "Hidden — click to reveal"),
                  )
            ),

            !revealed
              ? h("button", { class: "drill-reveal-btn", onClick: () => setRevealed(true) },
                  "Reveal Answer"
                )
              : h("div", { class: "drill-rating" },
                  h("div", { class: "drill-rating-label" }, "How well did you get it?"),
                  h("div", { class: "drill-rating-btns" },
                    [
                      { q: 0, label: "0", desc: "Blackout" },
                      { q: 1, label: "1", desc: "Wrong" },
                      { q: 2, label: "2", desc: "Hard" },
                      { q: 3, label: "3", desc: "OK" },
                      { q: 4, label: "4", desc: "Good" },
                      { q: 5, label: "5", desc: "Easy" },
                    ].map(({ q, label, desc }) =>
                      h("button", {
                        key: q,
                        class: `rating-btn q${q}`,
                        disabled: saving,
                        onClick: () => rate(q),
                      },
                        h("span", { class: "rating-num" }, label),
                        h("span", { class: "rating-desc" }, desc),
                      )
                    )
                  ),
                ),
          ),
        ),
  );
}

// ── LOS Tracker view ─────────────────────────────────────────────────────────

const RATING_LABELS = [
  { q: 0, label: "0", desc: "Blackout" },
  { q: 1, label: "1", desc: "Wrong" },
  { q: 2, label: "2", desc: "Hard" },
  { q: 3, label: "3", desc: "OK" },
  { q: 4, label: "4", desc: "Good" },
  { q: 5, label: "5", desc: "Easy" },
];

function LosStatusDot({ p }) {
  if (!p) return h("span", { class: "los-dot new", title: "New" });
  const pct = Number(p.mastery || 0);
  const cls = pct >= 80 ? "strong" : pct >= 50 ? "mid" : "weak";
  return h("span", { class: `los-dot ${cls}`, title: `Mastery ${pct}%` });
}

function LosTracker() {
  const [topics, setTopics]   = useState(null);
  const [los, setLos]         = useState(null);       // all LOS rows
  const [progress, setProgress] = useState({});       // los_id → progress row
  const [filter, setFilter]   = useState("all");
  const [mode, setMode]       = useState("browse");   // "browse" | "queue"
  const [queueIdx, setQueueIdx] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [saving, setSaving]   = useState(false);
  const [sessionRated, setSessionRated] = useState(0);
  const [err, setErr]         = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const sb = await getClient();
        const [topicsRes, losRes, progRes] = await Promise.all([
          sb.from("vw_codex_priority").select("topic_id, name, band, focus_index"),
          sb.from("codex_los").select("id, doc_id, topic_id, los_num, outcome, command_verb")
            .order("topic_id").order("los_num"),
          sb.from("codex_progress").select("los_id, mastery, status, ease, interval_days, reps, next_due"),
        ]);
        if (topicsRes.error) throw topicsRes.error;
        if (losRes.error) throw losRes.error;

        const prog = {};
        for (const p of (progRes.data || [])) prog[p.los_id] = p;

        const sorted = [...(topicsRes.data || [])].sort(
          (a, b) => Number(b.focus_index) - Number(a.focus_index)
        );
        setTopics(sorted);
        setLos(losRes.data || []);
        setProgress(prog);
      } catch (e) {
        setErr(e.message);
      }
    })();
  }, []);

  const rateLos = useCallback(async (losItem, quality) => {
    setSaving(true);
    try {
      const sb = await getClient();
      const prev = progress[losItem.id] || { ease: 2.5, interval_days: 0, reps: 0 };
      const { ef, interval, nextDue } = sm2Next(quality, Number(prev.ease), Number(prev.interval_days));
      const mastery = Math.min(100, Math.round((quality / 5) * 100));

      await sb.from("codex_reviews").insert({
        los_id: losItem.id,
        rating: quality,
        reviewed_at: new Date().toISOString(),
      });

      const TENANT = "00000000-0000-0000-0000-000000000001";
      await sb.from("codex_progress").upsert({
        tenant_id: TENANT,
        los_id: losItem.id,
        mastery,
        status: quality >= 4 ? "strong" : quality >= 2 ? "mid" : "weak",
        ease: ef,
        interval_days: interval,
        reps: (Number(prev.reps) || 0) + 1,
        last_reviewed: new Date().toISOString(),
        next_due: nextDue.split("T")[0],
      }, { onConflict: "tenant_id,los_id" });

      setProgress(p => ({
        ...p,
        [losItem.id]: {
          ...p[losItem.id],
          mastery, ease: ef, interval_days: interval,
          next_due: nextDue.split("T")[0],
          status: quality >= 4 ? "strong" : quality >= 2 ? "mid" : "weak",
          reps: (Number(prev.reps) || 0) + 1,
        }
      }));
      setSessionRated(r => r + 1);
      setQueueIdx(i => i + 1);
      setRevealed(false);
    } catch (e) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  }, [progress]);

  if (err) return h(ErrorBox, { msg: err });
  if (!los || !topics) return h(Loader);

  const topicRank = Object.fromEntries(topics.map((t, i) => [t.topic_id, i]));
  const now = new Date().toISOString().split("T")[0];

  const filteredLos = filter === "all"
    ? los
    : los.filter(l => l.topic_id === filter);

  // due queue: no progress or next_due <= today, sorted by deficit rank
  const dueQueue = [...filteredLos]
    .filter(l => { const p = progress[l.id]; return !p || (p.next_due || "9999") <= now; })
    .sort((a, b) => (topicRank[a.topic_id] ?? 999) - (topicRank[b.topic_id] ?? 999));

  const totalDue   = dueQueue.length;
  const totalLos   = filteredLos.length;
  const totalDone  = filteredLos.filter(l => progress[l.id]?.status === "strong").length;

  // browse: group by topic
  const grouped = [];
  for (const t of topics) {
    const items = filteredLos.filter(l => l.topic_id === t.topic_id);
    if (items.length) grouped.push({ topic: t, items });
  }

  const queueCard = dueQueue[queueIdx] ?? null;
  const queueDone = queueIdx >= dueQueue.length;

  return h(Fragment, null,
    h("div", { class: "page-title" }, "LOS Tracker"),
    h("div", { class: "page-sub" },
      `${totalLos} outcomes · ${totalDue} due · ${totalDone} strong · ${sessionRated} rated this session`
    ),

    h("div", { class: "los-toolbar" },
      h("div", { class: "filter-bar" },
        h("button", {
          class: `filter-btn ${filter === "all" ? "active" : ""}`,
          onClick: () => { setFilter("all"); setQueueIdx(0); setRevealed(false); },
        }, "All"),
        topics.map(t =>
          h("button", {
            key: t.topic_id,
            class: `filter-btn ${filter === t.topic_id ? "active" : ""}`,
            onClick: () => { setFilter(t.topic_id); setQueueIdx(0); setRevealed(false); },
          }, t.name)
        ),
      ),
      h("div", { class: "mode-toggle" },
        h("button", {
          class: `mode-btn ${mode === "browse" ? "active" : ""}`,
          onClick: () => setMode("browse"),
        }, "Browse"),
        h("button", {
          class: `mode-btn ${mode === "queue" ? "active" : ""}`,
          onClick: () => { setMode("queue"); setQueueIdx(0); setRevealed(false); },
        }, `Review Queue (${totalDue})`),
      ),
    ),

    mode === "browse"
      ? h("div", { class: "los-browse" },
          grouped.map(({ topic, items }) =>
            h("div", { key: topic.topic_id, class: "los-topic-group" },
              h("div", { class: "los-topic-header" },
                h("span", { class: "los-topic-name" }, topic.name),
                h(Chip, { band: topic.band }),
                h("span", { class: "los-topic-count" },
                  `${items.filter(l => progress[l.id]?.status === "strong").length}/${items.length} strong`
                ),
              ),
              h("div", { class: "los-browse-list" },
                items.map(l => {
                  const p = progress[l.id];
                  const due = !p || (p.next_due || "9999") <= now;
                  return h("div", { key: l.id, class: `los-browse-row ${due ? "due" : ""}` },
                    h(LosStatusDot, { p }),
                    h("div", { class: "los-browse-content" },
                      h("div", { class: "los-browse-num" },
                        l.command_verb && h("span", { class: "los-verb" }, l.command_verb),
                        `LOS ${l.los_num}`,
                      ),
                      h("div", { class: "los-browse-text" }, l.outcome),
                      p && h("div", { class: "los-browse-meta" },
                        `Mastery ${p.mastery}% · ${p.reps} rep${p.reps !== 1 ? "s" : ""} · due ${p.next_due || "today"}`
                      ),
                    ),
                  );
                })
              ),
            )
          )
        )
      : queueDone
        ? h("div", { class: "drill-done" },
            h("div", { class: "drill-done-icon" }, "✓"),
            h("div", { class: "drill-done-title" }, "Queue cleared"),
            h("div", { class: "drill-done-sub" },
              `You reviewed ${sessionRated} LOS this session.`
            ),
            h("button", { class: "drill-restart",
              onClick: () => { setQueueIdx(0); setRevealed(false); setSessionRated(0); }
            }, "Restart"),
          )
        : h(Fragment, null,
            h("div", { class: "drill-progress" },
              h("div", { class: "drill-progress-bar" },
                h("div", { class: "drill-progress-fill",
                  style: { width: `${(queueIdx / dueQueue.length) * 100}%` } })
              ),
              h("span", { class: "drill-progress-label" }, `${queueIdx + 1} / ${dueQueue.length}`),
            ),

            h("div", { class: "drill-card" },
              h("div", { class: "drill-card-meta" },
                h("span", null, topics.find(t => t.topic_id === queueCard.topic_id)?.name || ""),
                h("span", null, `LOS ${queueCard.los_num}`),
                queueCard.command_verb && h("span", { class: "los-verb" }, queueCard.command_verb),
              ),
              h("div", { class: "drill-card-prompt" }, "Can you state this learning outcome?"),
              h("div", { class: "drill-card-body" },
                revealed
                  ? queueCard.outcome
                  : h("div", { class: "drill-hidden" },
                      h("div", { class: "drill-hidden-text" }, "Hidden — click to reveal")
                    )
              ),
              !revealed
                ? h("button", { class: "drill-reveal-btn", onClick: () => setRevealed(true) },
                    "Reveal"
                  )
                : h("div", { class: "drill-rating" },
                    h("div", { class: "drill-rating-label" }, "How well did you know it?"),
                    h("div", { class: "drill-rating-btns" },
                      RATING_LABELS.map(({ q, label, desc }) =>
                        h("button", {
                          key: q,
                          class: `rating-btn q${q}`,
                          disabled: saving,
                          onClick: () => rateLos(queueCard, q),
                        },
                          h("span", { class: "rating-num" }, label),
                          h("span", { class: "rating-desc" }, desc),
                        )
                      )
                    ),
                  ),
            ),
          ),
  );
}

// ── App shell ─────────────────────────────────────────────────────────────────

function App() {
  const hash = useRoute();

  let page;
  const docMatch     = hash.match(/^#\/doc\/(.+)$/);
  const isFormulas   = hash === "#/formulas";
  const isDrill      = hash === "#/drill";
  const isLos        = hash === "#/los";

  if (docMatch)        page = h(Reading,      { docId: docMatch[1] });
  else if (isFormulas) page = h(FormulaSheet);
  else if (isDrill)    page = h(ExampleDrill);
  else if (isLos)      page = h(LosTracker);
  else                 page = h(Home);

  const isHome = !docMatch && !isFormulas && !isDrill && !isLos;

  return h(Fragment, null,
    h("nav", { class: "topbar" },
      h("div", { class: "topbar-brand" },
        "ATLAS CODEX",
        h("span", null, "CFA Level II · Nov 2026"),
      ),
      h("div", { class: "topbar-nav" },
        h("button", {
          class: `nav-btn ${isHome ? "active" : ""}`,
          onClick: () => navigate("#/"),
        }, "Home"),
        h("button", {
          class: `nav-btn ${isFormulas ? "active" : ""}`,
          onClick: () => navigate("#/formulas"),
        }, "Formulas"),
        h("button", {
          class: `nav-btn ${isDrill ? "active" : ""}`,
          onClick: () => navigate("#/drill"),
        }, "Drill"),
        h("button", {
          class: `nav-btn ${isLos ? "active" : ""}`,
          onClick: () => navigate("#/los"),
        }, "LOS"),
      ),
    ),
    h("main", { class: "main" }, page),
  );
}

render(h(App, null), document.getElementById("root"));
