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

// ── App shell ─────────────────────────────────────────────────────────────────

function App() {
  const hash = useRoute();

  let page;
  const docMatch = hash.match(/^#\/doc\/(.+)$/);
  if (docMatch) {
    page = h(Reading, { docId: docMatch[1] });
  } else {
    page = h(Home);
  }

  const isHome    = !docMatch;
  const isReading = !!docMatch;

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
      ),
    ),
    h("main", { class: "main" }, page),
  );
}

render(h(App, null), document.getElementById("root"));
