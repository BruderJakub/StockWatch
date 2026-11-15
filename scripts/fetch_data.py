#!/usr/bin/env python3
"""
StockWatch data fetcher.

Pulls prices from the Twelve Data API (free "Basic" plan) and writes:
  data/summary.json          -> everything the table needs (prices, % changes, sparkline)
  data/symbols/<SYMBOL>.json -> full chart data for one symbol (intraday + 3y daily)

Free plan limits: 8 requests/minute, 800/day. This script stays under both:
  * intraday (5-min bars, ~5 trading days)  -> 1 request per symbol, every run
  * daily history (~3 years)                -> 1 request per symbol, once per day
  With 50 symbols and ~9 runs per trading day that is ~500 requests/day.

Only uses the Python standard library, so there is nothing to pip install.

Usage:
  TWELVE_DATA_API_KEY=xxxx python scripts/fetch_data.py
"""

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TICKERS_FILE = ROOT / "tickers.json"
DATA_DIR = ROOT / "data"
SYMBOL_DIR = DATA_DIR / "symbols"

API_URL = "https://api.twelvedata.com/time_series"
REQUESTS_PER_MINUTE = 8           # free plan limit
INTRADAY_INTERVAL = "5min"
INTRADAY_POINTS = 400             # 78 bars/day * 5 days = 390
DAILY_POINTS = 800                # ~3.2 years of trading days
SPARK_DAYS = 30                   # points in the little table sparkline

PERIODS = {                       # label -> how far back to compare
    "1W": {"days": 7},
    "1M": {"months": 1},
    "6M": {"months": 6},
    "1Y": {"months": 12},
    "3Y": {"months": 36},
}


# ---------------------------------------------------------------- helpers

def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def add_months(d, months):
    """Shift a date by N months (negative = back), clamping the day."""
    m = d.month - 1 + months
    y = d.year + m // 12
    m = m % 12 + 1
    for day in (d.day, 30, 29, 28):
        try:
            return date(y, m, day)
        except ValueError:
            continue


def pct(new, old):
    if new is None or not old:
        return None
    return round((new / old - 1) * 100, 2)


class RateLimiter:
    """Spaces requests so we never exceed N per minute."""

    def __init__(self, per_minute):
        self.gap = 60.0 / per_minute + 0.3
        self.last = 0.0

    def wait(self):
        delta = time.monotonic() - self.last
        if delta < self.gap:
            time.sleep(self.gap - delta)
        self.last = time.monotonic()


class TwelveData:
    def __init__(self, api_key):
        self.key = api_key
        self.limiter = RateLimiter(REQUESTS_PER_MINUTE)
        self.calls = 0

    def series(self, symbol, interval, outputsize):
        """Return [(datetime_str, close_float), ...] oldest first, or None on failure."""
        params = urllib.parse.urlencode({
            "symbol": symbol,
            "interval": interval,
            "outputsize": outputsize,
            "apikey": self.key,
        })
        for attempt in range(3):
            self.limiter.wait()
            self.calls += 1
            try:
                with urllib.request.urlopen(f"{API_URL}?{params}", timeout=30) as r:
                    body = json.load(r)
            except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
                log(f"  {symbol} {interval}: network error {e!r}, retrying")
                time.sleep(5)
                continue

            if body.get("status") == "error":
                code = body.get("code")
                msg = body.get("message", "")
                if code == 429:  # out of credits for this minute
                    log(f"  {symbol}: rate limited, waiting 65s")
                    time.sleep(65)
                    continue
                log(f"  {symbol} {interval}: API error {code}: {msg}")
                return None

            values = body.get("values") or []
            points = []
            for v in values:
                try:
                    points.append((v["datetime"], round(float(v["close"]), 4)))
                except (KeyError, TypeError, ValueError):
                    pass
            points.sort(key=lambda p: p[0])
            return points
        return None


# ---------------------------------------------------------------- calculations

def build_symbol(meta, intraday, daily):
    """Combine raw series into the per-symbol chart file + its summary row."""
    if not daily and not intraday:
        return None, None

    # Current price = latest 5-min close if it's newer than the latest daily bar.
    if intraday:
        last_ts, price = intraday[-1]
        price_date = last_ts[:10]
    else:
        price_date, price = daily[-1]

    # Daily closes strictly before the current trading day.
    past = [(d, c) for d, c in daily if d < price_date]
    prev_close = past[-1][1] if past else None

    # Long-range chart line: past daily closes + today's current price.
    daily_line = past + [(price_date, price)]

    today = date.fromisoformat(price_date)
    changes = {"1D": pct(price, prev_close)}
    for label, delta in PERIODS.items():
        target = (today - timedelta(days=delta["days"])) if "days" in delta \
            else add_months(today, -delta["months"])
        base = None
        for d, c in reversed(past):
            if d <= target.isoformat():
                base = c
                break
        changes[label] = pct(price, base)

    detail = {
        "symbol": meta["symbol"],
        "prevClose": prev_close,
        "intraday": {"t": [t for t, _ in intraday], "c": [c for _, c in intraday]},
        "daily": {"t": [t for t, _ in daily_line], "c": [c for _, c in daily_line]},
    }
    row = {
        "rank": meta.get("rank"),
        "symbol": meta["symbol"],
        "name": meta.get("name", meta["symbol"]),
        "type": meta.get("type", "Stock"),
        "price": round(price, 2),
        "prevClose": prev_close,
        "asOf": intraday[-1][0] if intraday else price_date,
        "changes": changes,
        "spark": [round(c, 2) for _, c in daily_line[-SPARK_DAYS:]],
    }
    return detail, row


def symbol_path(symbol):
    return SYMBOL_DIR / f"{symbol}.json"


def load_raw(symbol):
    """Raw cache kept next to the published file so daily data is reused all day."""
    p = SYMBOL_DIR / f"{symbol}.raw.json"
    if p.exists():
        try:
            return json.loads(p.read_text())
        except json.JSONDecodeError:
            pass
    return {}


def save_raw(symbol, raw):
    (SYMBOL_DIR / f"{symbol}.raw.json").write_text(json.dumps(raw, separators=(",", ":")))


# ---------------------------------------------------------------- main

def main():
    api_key = os.environ.get("TWELVE_DATA_API_KEY", "").strip()
    if not api_key:
        sys.exit("TWELVE_DATA_API_KEY is not set. Get a free key at https://twelvedata.com")

    tickers = json.loads(TICKERS_FILE.read_text())["tickers"]
    SYMBOL_DIR.mkdir(parents=True, exist_ok=True)
    td = TwelveData(api_key)
    today_utc = datetime.now(timezone.utc).date().isoformat()
    force_daily = os.environ.get("FORCE_DAILY") == "1"

    rows, failures = [], []
    for i, meta in enumerate(tickers, 1):
        sym = meta["symbol"]
        raw = load_raw(sym)
        log(f"({i}/{len(tickers)}) {sym}")

        # Daily history: only once per UTC day (it barely changes intraday).
        if force_daily or raw.get("dailyFetched") != today_utc or not raw.get("daily"):
            daily = td.series(sym, "1day", DAILY_POINTS)
            if daily:
                raw["daily"] = daily
                raw["dailyFetched"] = today_utc

        intraday = td.series(sym, INTRADAY_INTERVAL, INTRADAY_POINTS)
        if intraday:
            raw["intraday"] = intraday

        daily = [tuple(p) for p in raw.get("daily", [])]
        intraday = [tuple(p) for p in raw.get("intraday", [])]
        detail, row = build_symbol(meta, intraday, daily)
        if not row:
            failures.append(sym)
            continue

        save_raw(sym, raw)
        symbol_path(sym).write_text(json.dumps(detail, separators=(",", ":")))
        rows.append(row)

    summary = {
        "updated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "Twelve Data",
        "items": rows,
    }
    (DATA_DIR / "summary.json").write_text(json.dumps(summary, separators=(",", ":")))
    log(f"Done: {len(rows)} symbols written, {len(failures)} failed {failures or ''}; "
        f"{td.calls} API requests used.")
    if not rows:
        sys.exit(1)


if __name__ == "__main__":
    main()
