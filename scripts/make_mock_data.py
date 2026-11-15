#!/usr/bin/env python3
"""
Creates FAKE price data in the same format as fetch_data.py, so you can work on
the website locally without an API key. Never deployed (the GitHub Action
overwrites data/ with real prices).

  python scripts/make_mock_data.py
  python -m http.server 8000      # then open http://localhost:8000
"""

import json
import random
from datetime import date, datetime, timedelta, timezone

from fetch_data import DATA_DIR, SYMBOL_DIR, TICKERS_FILE, build_symbol


def trading_days(end, n):
    days, d = [], end
    while len(days) < n:
        if d.weekday() < 5:
            days.append(d)
        d -= timedelta(days=1)
    return list(reversed(days))


def main():
    random.seed(42)
    tickers = json.loads(TICKERS_FILE.read_text())["tickers"]
    SYMBOL_DIR.mkdir(parents=True, exist_ok=True)
    end = date.today()
    while end.weekday() >= 5:
        end -= timedelta(days=1)
    days = trading_days(end, 800)

    rows = []
    for meta in tickers:
        price = random.uniform(30, 900)
        drift = random.uniform(-0.0003, 0.0012)
        vol = random.uniform(0.008, 0.028)
        daily = []
        for d in days:
            price *= 1 + random.gauss(drift, vol)
            daily.append((d.isoformat(), round(price, 2)))

        intraday = []
        for d in days[-5:]:
            p = dict(daily)[d.isoformat()] * (1 + random.gauss(0, vol / 2))
            t = datetime(d.year, d.month, d.day, 9, 30)
            for _ in range(78):
                p *= 1 + random.gauss(0, vol / 9)
                intraday.append((t.strftime("%Y-%m-%d %H:%M:%S"), round(p, 2)))
                t += timedelta(minutes=5)

        detail, row = build_symbol(meta, intraday, daily)
        (SYMBOL_DIR / f"{meta['symbol']}.json").write_text(json.dumps(detail, separators=(",", ":")))
        rows.append(row)

    summary = {
        "updated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "MOCK DATA (not real prices)",
        "items": rows,
    }
    (DATA_DIR / "summary.json").write_text(json.dumps(summary, separators=(",", ":")))
    print(f"Wrote mock data for {len(rows)} symbols to {DATA_DIR}")


if __name__ == "__main__":
    main()
