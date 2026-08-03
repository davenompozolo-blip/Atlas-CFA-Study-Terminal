#!/usr/bin/env python3
"""
ATLAS NEXUS // Volatility Dispersion Signal (VIX EQ - VIX)

Nightly EOD job. One underlying function, three basket inputs:

  market     top-SPX names (equity_sector_map.is_market_basket) vs SPY
  portfolio  current equity positions (positions x assets)      vs SPY
  sector     large-cap names per GICS sector                    vs sector SPDR ETF

For each basket: pull the options chain for every constituent plus the
benchmark leg, extract a 30D ATM implied vol per name (interpolated in
strike to the parity-implied forward, then in variance-time to 30 days),
cap/value-weight into a single basket IV, and store
spread = basket_iv - benchmark_iv in vol_dispersion_daily.

Precompute-and-store by design: the frontend only ever does windowed
reads over stored spreads. EOD only -- HISTORICAL_OPTIONS is used for
both the nightly run (previous session) and backfill; no intraday pulls.

Benchmark note: the spec names SPX/VIX for the index leg. Alpha Vantage
options coverage is listed equities/ETFs only (no index options), so the
benchmark leg is SPY 30D ATM IV computed with the *same* interpolation
as the basket legs -- methodologically cleaner than mixing a VIX quote
into a spread built from our own interpolated IVs. benchmark_ticker
records what was actually used.

Env:
  ALPHAVANTAGE_API_KEY        premium key (HISTORICAL_OPTIONS is a premium endpoint)
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY   writes bypass RLS; reads of positions too
  AV_RPM                      optional, requests/minute throttle (default 70)

Usage:
  python vol_dispersion.py                          # previous trading session, all baskets
  python vol_dispersion.py --date 2026-07-09        # one specific session
  python vol_dispersion.py --backfill 365           # resumable, skips stored days
  python vol_dispersion.py --baskets market,sector  # subset
  python vol_dispersion.py --self-test              # offline math checks, no network
"""

import argparse
import json
import math
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta

AV_URL = "https://www.alphavantage.co/query"
TARGET_DTE = 30
MIN_DTE, MAX_DTE = 5, 120
IV_FLOOR, IV_CEIL = 0.01, 4.0     # discard garbage prints outside this band
MIN_COVERAGE = 0.4                # fraction of basket that must price
MIN_ABS = 2                       # ...and never fewer than this many names

SECTOR_ETF = {
    "Technology": "XLK",
    "Financials": "XLF",
    "Energy": "XLE",
    "Health Care": "XLV",
    "Consumer Discretionary": "XLY",
    "Consumer Staples": "XLP",
    "Industrials": "XLI",
    "Materials": "XLB",
    "Utilities": "XLU",
    "Real Estate": "XLRE",
    "Communication Services": "XLC",
}
MARKET_BENCHMARK = "SPY"  # SPX/VIX proxy -- see module docstring


# ── Alpha Vantage ─────────────────────────────────────────────────────────────

class AVClient:
    """Throttled HISTORICAL_OPTIONS puller with a per-run (symbol, date) cache."""

    def __init__(self, api_key, rpm=70):
        self.api_key = api_key
        self.min_gap = 60.0 / max(1, rpm)
        self._last_call = 0.0
        self._cache = {}

    def chain(self, symbol, asof):
        key = (symbol, asof)
        if key in self._cache:
            return self._cache[key]
        params = {
            "function": "HISTORICAL_OPTIONS",
            "symbol": symbol,
            "date": asof.isoformat(),
            "datatype": "json",
            "apikey": self.api_key,
        }
        url = f"{AV_URL}?{urllib.parse.urlencode(params)}"
        payload = self._get(url)
        data = payload.get("data") or []
        self._cache[key] = data
        return data

    def _get(self, url, attempts=4):
        for attempt in range(attempts):
            wait = self._last_call + self.min_gap - time.monotonic()
            if wait > 0:
                time.sleep(wait)
            self._last_call = time.monotonic()
            try:
                with urllib.request.urlopen(url, timeout=60) as resp:
                    payload = json.loads(resp.read().decode())
            except Exception as e:
                if attempt == attempts - 1:
                    raise
                time.sleep(2 ** attempt * 2)
                continue
            # AV signals rate limiting / bad key in-band, HTTP 200
            note = payload.get("Note") or payload.get("Information")
            if note:
                if "premium" in note.lower() and "rate" not in note.lower():
                    raise RuntimeError(f"Alpha Vantage refused the call (premium endpoint?): {note}")
                time.sleep(15 * (attempt + 1))
                continue
            if payload.get("Error Message"):
                raise RuntimeError(f"Alpha Vantage error: {payload['Error Message']}")
            return payload
        raise RuntimeError("Alpha Vantage rate limit not clearing; giving up this run")


# ── 30D ATM IV extraction (the one shared function) ───────────────────────────

def _f(x):
    try:
        v = float(x)
        return v if math.isfinite(v) else None
    except (TypeError, ValueError):
        return None


def _mid(row):
    mark = _f(row.get("mark"))
    if mark and mark > 0:
        return mark
    bid, ask = _f(row.get("bid")), _f(row.get("ask"))
    if bid and ask and bid > 0 and ask > 0:
        return (bid + ask) / 2
    last = _f(row.get("last"))
    return last if last and last > 0 else None


def _expiry_atm_iv(rows):
    """ATM IV for one expiry: forward from put-call parity at the strike where
    |C-P| is smallest, then linear IV interpolation in strike at that forward,
    averaged across the call and put legs."""
    by_strike = {}
    for r in rows:
        k = _f(r.get("strike"))
        if not k:
            continue
        side = (r.get("type") or "").lower()
        if side not in ("call", "put"):
            continue
        iv = _f(r.get("implied_volatility"))
        entry = by_strike.setdefault(k, {})
        entry[side] = {
            "mid": _mid(r),
            "iv": iv if iv and IV_FLOOR < iv < IV_CEIL else None,
        }

    paired = [
        (k, v["call"]["mid"], v["put"]["mid"])
        for k, v in by_strike.items()
        if v.get("call", {}).get("mid") and v.get("put", {}).get("mid")
    ]
    if not paired:
        return None
    k_star, c, p = min(paired, key=lambda t: abs(t[1] - t[2]))
    forward = k_star + (c - p)

    legs = []
    for side in ("call", "put"):
        pts = sorted(
            (k, v[side]["iv"])
            for k, v in by_strike.items()
            if v.get(side, {}).get("iv")
        )
        iv = _interp_at(pts, forward)
        if iv:
            legs.append(iv)
    if not legs:
        return None
    return sum(legs) / len(legs)


def _interp_at(pts, x):
    """Linear interpolation of (strike, iv) points at strike x; clamps to the
    nearest point when x falls outside the quoted range."""
    if not pts:
        return None
    if x <= pts[0][0]:
        return pts[0][1]
    if x >= pts[-1][0]:
        return pts[-1][1]
    for (k1, v1), (k2, v2) in zip(pts, pts[1:]):
        if k1 <= x <= k2:
            if k2 == k1:
                return v1
            w = (x - k1) / (k2 - k1)
            return v1 + w * (v2 - v1)
    return None


def iv_30d_atm(chain, asof):
    """The shared extraction: nearest-to-30D expiries bracketing the target,
    ATM IV per expiry, then interpolation in total variance to exactly 30D.
    Spec section 7: interpolate, don't take the closest expiry and call it 30D."""
    by_exp = {}
    for r in chain:
        try:
            exp = datetime.strptime(r.get("expiration", ""), "%Y-%m-%d").date()
        except ValueError:
            continue
        dte = (exp - asof).days
        if MIN_DTE <= dte <= MAX_DTE:
            by_exp.setdefault(dte, []).append(r)
    if not by_exp:
        return None

    ivs = {}
    for dte in sorted(by_exp, key=lambda d: abs(d - TARGET_DTE)):
        iv = _expiry_atm_iv(by_exp[dte])
        if iv:
            ivs[dte] = iv
        below = any(d <= TARGET_DTE for d in ivs)
        above = any(d > TARGET_DTE for d in ivs)
        if below and above:
            break
    if not ivs:
        return None

    lo = max((d for d in ivs if d <= TARGET_DTE), default=None)
    hi = min((d for d in ivs if d > TARGET_DTE), default=None)
    if lo is None or hi is None:
        iv = ivs[lo if hi is None else hi]
    else:
        # linear in total variance, the standard way to blend across expiries
        v_lo, v_hi = ivs[lo] ** 2 * lo, ivs[hi] ** 2 * hi
        w = (TARGET_DTE - lo) / (hi - lo)
        var30 = v_lo + w * (v_hi - v_lo)
        if var30 <= 0:
            return None
        iv = math.sqrt(var30 / TARGET_DTE)
    return iv if IV_FLOOR < iv < IV_CEIL else None


# ── Basket aggregation ────────────────────────────────────────────────────────

def basket_iv(av, names, asof, log):
    """Weighted-average 30D ATM IV across [(ticker, weight), ...].
    Returns (iv, priced_count). Weights renormalise over the names that
    actually priced, so a missing name doesn't drag the average."""
    priced = []
    for ticker, weight in names:
        try:
            iv = iv_30d_atm(av.chain(ticker, asof), asof)
        except RuntimeError:
            raise
        except Exception as e:
            log(f"    {ticker}: chain error ({e})")
            iv = None
        if iv:
            priced.append((weight, iv))
        else:
            log(f"    {ticker}: no usable 30D ATM IV")
    if not priced:
        return None, 0
    total_w = sum(w for w, _ in priced)
    return sum(w * iv for w, iv in priced) / total_w, len(priced)


def compute_day(av, sb, asof, baskets, existing, log):
    """All requested basket rows for one session. Returns rows to upsert."""
    rows = []

    def spread_row(basket_type, sector, names, bench_ticker):
        if (basket_type, sector) in existing:
            log(f"  {basket_type}{'/' + sector if sector else ''}: already stored, skipping")
            return
        b_iv, count = basket_iv(av, names, asof, log)
        need = max(MIN_ABS, math.ceil(MIN_COVERAGE * len(names)))
        if b_iv is None or count < need:
            log(f"  {basket_type}{'/' + sector if sector else ''}: only {count}/{len(names)} priced (need {need}), not writing")
            return
        bench_iv = iv_30d_atm(av.chain(bench_ticker, asof), asof)
        if bench_iv is None:
            log(f"  {basket_type}{'/' + sector if sector else ''}: benchmark {bench_ticker} did not price, not writing")
            return
        rows.append({
            "date": asof.isoformat(),
            "basket_type": basket_type,
            "sector": sector,
            "basket_iv": round(b_iv, 6),
            "benchmark_iv": round(bench_iv, 6),
            "benchmark_ticker": bench_ticker,
            "spread": round(b_iv - bench_iv, 6),
            "constituent_count": count,
        })
        log(f"  {basket_type}{'/' + sector if sector else ''}: spread {b_iv - bench_iv:+.4f} ({count}/{len(names)} names)")

    sector_map = sb.table("equity_sector_map").select("*").execute().data

    if "market" in baskets:
        names = [(r["ticker"], float(r["weight"])) for r in sector_map if r["is_market_basket"]]
        spread_row("market", "", names, MARKET_BENCHMARK)

    if "sector" in baskets:
        for sector, etf in SECTOR_ETF.items():
            names = [(r["ticker"], float(r["weight"])) for r in sector_map if r["gics_sector"] == sector]
            if names:
                spread_row("sector", sector, names, etf)

    if "portfolio" in baskets:
        pos = (
            sb.table("positions")
            .select("market_value, assets(symbol, asset_class)")
            .execute()
            .data
        )
        holdings = {}
        for p in pos:
            a = p.get("assets") or {}
            mv = _f(p.get("market_value"))
            if not mv or mv <= 0:
                continue
            if (a.get("asset_class") or "").lower() not in ("us_equity", "equity", "stock"):
                continue
            sym = a.get("symbol")
            if sym:
                holdings[sym] = holdings.get(sym, 0.0) + mv
        if holdings:
            spread_row("portfolio", "", sorted(holdings.items()), MARKET_BENCHMARK)
        else:
            log("  portfolio: no equity positions in the book, skipping")

    return rows


# ── Runner ────────────────────────────────────────────────────────────────────

def trading_days(back_from, n):
    """Weekdays going back n calendar days. Market holidays yield empty
    chains and are skipped naturally by the coverage floor."""
    days, d = [], back_from
    cutoff = back_from - timedelta(days=n)
    while d > cutoff:
        if d.weekday() < 5:
            days.append(d)
        d -= timedelta(days=1)
    return days


def previous_session(today):
    d = today - timedelta(days=1)
    while d.weekday() >= 5:
        d -= timedelta(days=1)
    return d


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    ap.add_argument("--date", help="session date YYYY-MM-DD (default: previous trading session)")
    ap.add_argument("--backfill", type=int, metavar="DAYS", help="walk back this many calendar days, resumable")
    ap.add_argument("--baskets", default="market,sector,portfolio", help="comma list: market,sector,portfolio")
    ap.add_argument("--dry-run", action="store_true", help="compute but don't write")
    ap.add_argument("--self-test", action="store_true", help="offline checks of the IV math, no network")
    args = ap.parse_args()

    if args.self_test:
        return self_test()

    api_key = os.environ.get("ALPHAVANTAGE_API_KEY") or os.environ.get("ALPHA_VANTAGE_API_KEY")
    sb_url = os.environ.get("SUPABASE_URL")
    sb_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or os.environ.get("SUPABASE_KEY")
    if not (api_key and sb_url and sb_key):
        sys.exit("Missing env: need ALPHAVANTAGE_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY")

    from supabase import create_client
    sb = create_client(sb_url, sb_key)
    av = AVClient(api_key, rpm=int(os.environ.get("AV_RPM", "70")))
    baskets = {b.strip() for b in args.baskets.split(",") if b.strip()}
    log = print

    if args.backfill:
        days = trading_days(previous_session(date.today()), args.backfill)
    elif args.date:
        days = [datetime.strptime(args.date, "%Y-%m-%d").date()]
    else:
        days = [previous_session(date.today())]

    total = 0
    for asof in days:
        stored = (
            sb.table("vol_dispersion_daily")
            .select("basket_type, sector")
            .eq("date", asof.isoformat())
            .execute()
            .data
        )
        existing = {(r["basket_type"], r["sector"]) for r in stored}
        log(f"{asof} ({len(existing)} rows already stored)")
        rows = compute_day(av, sb, asof, baskets, existing, log)
        if rows and not args.dry_run:
            sb.table("vol_dispersion_daily").upsert(
                rows, on_conflict="date,basket_type,sector"
            ).execute()
        total += len(rows)
    log(f"done: {total} row(s) {'computed (dry run)' if args.dry_run else 'written'}")


# ── Offline self-test ─────────────────────────────────────────────────────────

def _synth_chain(asof, spot, vols_by_dte):
    """Flat-ish synthetic chain: strikes around spot, IV per expiry, marks
    consistent enough for the parity forward to land at spot."""
    rows = []
    for dte, iv in vols_by_dte.items():
        exp = (asof + timedelta(days=dte)).isoformat()
        for k in range(int(spot * 0.9), int(spot * 1.1) + 1, 5):
            intrinsic_c = max(spot - k, 0)
            intrinsic_p = max(k - spot, 0)
            tv = iv * spot * math.sqrt(dte / 365) * 0.4
            rows.append({"expiration": exp, "strike": str(k), "type": "call",
                         "mark": str(intrinsic_c + tv), "implied_volatility": str(iv)})
            rows.append({"expiration": exp, "strike": str(k), "type": "put",
                         "mark": str(intrinsic_p + tv), "implied_volatility": str(iv)})
    return rows


def self_test():
    asof = date(2026, 7, 9)

    # flat vol surface -> 30D ATM IV must recover the flat vol
    chain = _synth_chain(asof, 100, {23: 0.25, 37: 0.25})
    iv = iv_30d_atm(chain, asof)
    assert iv and abs(iv - 0.25) < 1e-6, f"flat surface: {iv}"

    # upward term structure -> result strictly between the two expiry vols
    chain = _synth_chain(asof, 100, {23: 0.20, 37: 0.30})
    iv = iv_30d_atm(chain, asof)
    assert iv and 0.20 < iv < 0.30, f"term structure: {iv}"
    # and closer to the variance-time blend than a naive average
    v = math.sqrt((0.04 * 23 + ((0.09 * 37 - 0.04 * 23) * 7 / 14)) / 30)
    assert abs(iv - v) < 1e-6, f"variance-time interp: {iv} vs {v}"

    # single usable expiry -> falls back to it
    chain = _synth_chain(asof, 100, {23: 0.22})
    iv = iv_30d_atm(chain, asof)
    assert iv and abs(iv - 0.22) < 1e-6, f"single expiry: {iv}"

    # garbage IVs are rejected
    chain = _synth_chain(asof, 100, {30: 9.0})
    assert iv_30d_atm(chain, asof) is None, "IV ceiling not enforced"

    # empty / out-of-window chains
    assert iv_30d_atm([], asof) is None
    assert iv_30d_atm(_synth_chain(asof, 100, {200: 0.2}), asof) is None

    # interpolation helper clamps outside the quoted range
    assert _interp_at([(90, 0.3), (110, 0.2)], 100) == 0.25
    assert _interp_at([(90, 0.3), (110, 0.2)], 80) == 0.3
    assert _interp_at([(90, 0.3), (110, 0.2)], 120) == 0.2

    print("self-test: all checks passed")


if __name__ == "__main__":
    main()
