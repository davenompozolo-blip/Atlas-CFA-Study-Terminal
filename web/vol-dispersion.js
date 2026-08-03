// ATLAS NEXUS // Volatility Dispersion Signal — frontend read layer.
//
// Portable module for the Nexus page (Rotation Map + Opportunities Ledger).
// Everything here is a windowed read over precomputed vol_dispersion_daily
// rows — no IV math client-side, the nightly job owns the numbers.
//
//   Rotation Map header   → h(DispersionBadge, { rows })          market basket
//   Rotation Map cells    → sectorReading(rowsForSector)          sector basket
//   Opportunities Ledger  → h(LedgerReliabilityFlag, { rows })    portfolio basket
//
// Fetch with fetchDispersionSeries(sb, 'market') etc. and hand the rows in.

import { h } from "preact";
import { useState } from "preact/hooks";

// ── data access ───────────────────────────────────────────────────────────────

// ~380 calendar days ≈ a 1yr trailing window of sessions, per spec.
export async function fetchDispersionSeries(sb, basketType, { sector = "", days = 380 } = {}) {
  const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const { data, error } = await sb
    .from("vol_dispersion_daily")
    .select("date, basket_iv, benchmark_iv, benchmark_ticker, spread, constituent_count")
    .eq("basket_type", basketType)
    .eq("sector", sector)
    .gte("date", since)
    .order("date", { ascending: true });
  if (error) throw new Error(`vol_dispersion_daily read failed: ${error.message}`);
  return (data || []).map((r) => ({ ...r, spread: Number(r.spread) }));
}

// ── stats ─────────────────────────────────────────────────────────────────────

export function percentileRank(values, x) {
  if (!values.length) return null;
  let below = 0;
  for (const v of values) if (v <= x) below++;
  return below / values.length;
}

export function zScore(values, x) {
  if (values.length < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1));
  return sd > 0 ? (x - mean) / sd : 0;
}

// High spread percentile = single names pricey vs index = low implied
// correlation = dispersion is WIDE (stock-picker's tape). Low percentile =
// correlation spiking = COMPRESSED (beta-driven tape). Thresholds are
// deliberately plain constants — tune here, nowhere else.
export const WIDE_PCT = 0.7;
export const COMPRESSED_PCT = 0.3;

export function classifyRegime(pct) {
  if (pct == null) return { label: "No data", key: "none", color: "var(--muted, #8b94a3)" };
  if (pct >= WIDE_PCT) return { label: "Wide", key: "wide", color: "var(--cyan, #3ad6e0)" };
  if (pct <= COMPRESSED_PCT) return { label: "Compressed", key: "compressed", color: "var(--amber, #e0a83a)" };
  return { label: "Neutral", key: "neutral", color: "var(--muted, #8b94a3)" };
}

// Degraded-data flag: the latest row priced materially fewer names than this
// basket normally does (options data missing/stale). Surface it, never hide it.
export function isDegraded(rows) {
  if (!rows.length) return false;
  const counts = rows.map((r) => r.constituent_count).sort((a, b) => a - b);
  const median = counts[Math.floor(counts.length / 2)];
  return rows[rows.length - 1].constituent_count < 0.6 * median;
}

// One-call summary used by the badge, the sector cells, and the ledger flag.
// Each basket is ranked against its OWN trailing window — sectors have their
// own baselines, never the market window.
export function dispersionSummary(rows) {
  if (!rows.length) return null;
  const spreads = rows.map((r) => r.spread);
  const latest = rows[rows.length - 1];
  const pct = percentileRank(spreads, latest.spread);
  return {
    date: latest.date,
    spread: latest.spread,
    pct,
    z: zScore(spreads, latest.spread),
    regime: classifyRegime(pct),
    degraded: isDegraded(rows),
    benchmark: latest.benchmark_ticker,
    count: latest.constituent_count,
  };
}

// Rotation Map sector cells consume this directly.
export function sectorReading(rows) {
  return dispersionSummary(rows);
}

// ── SVG helpers ───────────────────────────────────────────────────────────────

function pathFor(rows, w, hgt, pad, lo, hi) {
  const n = rows.length;
  const x = (i) => pad + (i / Math.max(1, n - 1)) * (w - 2 * pad);
  const y = (v) => hgt - pad - ((v - lo) / (hi - lo || 1)) * (hgt - 2 * pad);
  return { d: rows.map((r, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(r).toFixed(1)}`).join(" "), x, y };
}

function Sparkline({ rows, color }) {
  const w = 84, hgt = 22, pad = 2;
  const spreads = rows.map((r) => r.spread);
  if (spreads.length < 2) return null;
  const { d } = pathFor(spreads, w, hgt, pad, Math.min(...spreads), Math.max(...spreads));
  return h("svg", { width: w, height: hgt, "aria-hidden": true, style: { display: "block" } },
    h("path", { d, fill: "none", stroke: color, "stroke-width": 1.5, "stroke-linejoin": "round" }),
  );
}

// ── Rotation Map header badge (market basket) ────────────────────────────────

export function DispersionBadge({ rows, title = "Dispersion Regime" }) {
  const [open, setOpen] = useState(false);
  const s = dispersionSummary(rows || []);
  if (!s) return h("div", { class: "disp-badge", style: badgeStyle("var(--muted, #8b94a3)") },
    h("span", { style: { opacity: 0.7 } }, `${title}: no data yet`));

  return h("div", { class: "disp-badge-wrap", style: { fontFamily: "var(--font-mono, monospace)" } },
    h("button", {
      class: "disp-badge",
      style: { ...badgeStyle(s.regime.color), cursor: "pointer" },
      onClick: () => setOpen(!open),
      "aria-expanded": open,
      title: `spread ${fmt(s.spread)} vs ${s.benchmark} · z ${fmt(s.z)} · ${s.count} names priced`,
    },
      h("span", { style: { color: "var(--text-muted, #8b94a3)" } }, `${title}: `),
      h("span", { style: { color: s.regime.color, fontWeight: 600 } }, s.regime.label),
      h("span", { style: { color: "var(--text-muted, #8b94a3)", marginLeft: "6px" } },
        s.pct != null ? `${Math.round(s.pct * 100)}th pct` : ""),
      s.degraded && h("span", {
        style: { color: "var(--amber, #e0a83a)", marginLeft: "6px" },
        title: `Only ${s.count} names priced — thin sample, read with caution`,
      }, "◈ degraded"),
      h("span", { style: { marginLeft: "8px" } }, h(Sparkline, { rows, color: s.regime.color })),
    ),
    open && h(DispersionHistory, { rows }),
  );
}

function badgeStyle(color) {
  return {
    display: "inline-flex", alignItems: "center", gap: "2px",
    padding: "4px 10px", borderRadius: "6px",
    background: "var(--card, #11161f)", border: `1px solid ${color}`,
    fontSize: "12px", fontFamily: "var(--font-mono, monospace)",
    color: "var(--text, #dbe2ea)",
  };
}

// Expanded view: full spread history with the trailing percentile band,
// plus a z-score strip on its own scale below (two charts, one shared x —
// never a dual axis). Hover gives a crosshair + tooltip.
export function DispersionHistory({ rows }) {
  const [hover, setHover] = useState(null);
  const w = 560, hMain = 160, hZ = 64, pad = 10;
  const spreads = rows.map((r) => r.spread);
  if (spreads.length < 2) return null;

  const lo = Math.min(...spreads), hi = Math.max(...spreads);
  const main = pathFor(spreads, w, hMain, pad, lo, hi);
  const zs = rows.map((_, i) => zScore(spreads.slice(0, i + 1), spreads[i]) ?? 0);
  const zAbs = Math.max(2.5, ...zs.map(Math.abs));
  const zed = pathFor(zs, w, hZ, 6, -zAbs, zAbs);

  const onMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = (e.clientX - rect.left - pad) / (rect.width - 2 * pad);
    const i = Math.max(0, Math.min(rows.length - 1, Math.round(frac * (rows.length - 1))));
    setHover(i);
  };

  const gridLine = (y, label, hgt) => [
    h("line", { x1: pad, x2: w - pad, y1: y, y2: y, stroke: "var(--grid, #232a36)", "stroke-width": 1 }),
    h("text", { x: w - pad + 2, y: y + 3, "font-size": 9, fill: "var(--text-muted, #8b94a3)" }, label),
  ];

  return h("div", {
    class: "disp-history",
    style: {
      marginTop: "8px", padding: "12px", background: "var(--card, #11161f)",
      border: "1px solid var(--grid, #232a36)", borderRadius: "8px", width: "fit-content",
    },
  },
    h("div", { style: { fontSize: "11px", color: "var(--text-muted, #8b94a3)", marginBottom: "6px" } },
      "Basket-vs-index 30D IV spread — trailing window"),
    h("svg", { width: w + 30, height: hMain, onMouseMove: onMove, onMouseLeave: () => setHover(null) },
      gridLine(main.y(0), "0", hMain),
      h("path", { d: main.d, fill: "none", stroke: "var(--cyan, #3ad6e0)", "stroke-width": 2, "stroke-linejoin": "round" }),
      hover != null && [
        h("line", { x1: main.x(hover), x2: main.x(hover), y1: pad, y2: hMain - pad, stroke: "var(--text-muted, #8b94a3)", "stroke-dasharray": "3,3" }),
        h("circle", { cx: main.x(hover), cy: main.y(spreads[hover]), r: 3.5, fill: "var(--cyan, #3ad6e0)", stroke: "var(--bg, #0a0d12)", "stroke-width": 2 }),
      ],
    ),
    h("div", { style: { fontSize: "10px", color: "var(--text-muted, #8b94a3)", margin: "2px 0" } }, "z-score"),
    h("svg", { width: w + 30, height: hZ },
      gridLine(zed.y(0), "0", hZ),
      gridLine(zed.y(2), "+2", hZ),
      gridLine(zed.y(-2), "-2", hZ),
      h("path", { d: zed.d, fill: "none", stroke: "var(--cyan, #3ad6e0)", "stroke-width": 1.5, opacity: 0.75 }),
      hover != null && h("line", { x1: zed.x(hover), x2: zed.x(hover), y1: 4, y2: hZ - 4, stroke: "var(--text-muted, #8b94a3)", "stroke-dasharray": "3,3" }),
    ),
    h("div", { style: { fontSize: "11px", color: "var(--text, #dbe2ea)", marginTop: "6px", minHeight: "14px", fontFamily: "var(--font-mono, monospace)" } },
      hover != null
        ? `${rows[hover].date}  spread ${fmt(spreads[hover])}  z ${fmt(zs[hover])}  ${rows[hover].constituent_count} names vs ${rows[hover].benchmark_ticker}`
        : `${rows[rows.length - 1].date}  latest spread ${fmt(spreads[spreads.length - 1])}`),
  );
}

// ── Opportunities Ledger annotation (portfolio basket) ────────────────────────
//
// v1 is display-only by design: when the portfolio-basket regime is
// compressed/inverted, isolated-merit scores are less trustworthy — say so,
// change nothing in the scoring. Reweighting the scoring legs off this
// signal is explicitly deferred to v2 until the signal has a track record.

export function LedgerReliabilityFlag({ rows }) {
  const s = dispersionSummary(rows || []);
  if (!s || s.regime.key !== "compressed") return null;
  return h("div", {
    class: "ledger-disp-flag",
    role: "note",
    style: {
      display: "flex", alignItems: "center", gap: "8px",
      padding: "6px 10px", borderRadius: "6px", fontSize: "12px",
      fontFamily: "var(--font-mono, monospace)",
      background: "var(--card, #11161f)", border: "1px solid var(--amber, #e0a83a)",
      color: "var(--text, #dbe2ea)",
    },
  },
    h("span", { style: { color: "var(--amber, #e0a83a)", fontWeight: 600 } }, "⚠ Correlation regime"),
    h("span", null,
      `Portfolio dispersion is compressed (${Math.round(s.pct * 100)}th pct` +
      `${s.degraded ? ", degraded sample" : ""}). Beta is driving the tape — ` +
      "isolated-merit scores are less reliable right now."),
  );
}

function fmt(x) {
  return x == null ? "–" : (x >= 0 ? "+" : "") + x.toFixed(3);
}
