# StockWatch

A compact stock & ETF watchlist. It shows a table of 50 symbols with their current price and % change over 1D / 1W / 1M / 6M / 1Y / 3Y. Click a row to open its chart (1D by default), or click a % cell to open the chart at that timeframe.

- **Website:** plain HTML/CSS/JS with no build step and no libraries (`index.html`, `style.css`, `app.js`).
- **Data:** a GitHub Action runs `scripts/fetch_data.py` about once an hour while US markets are open. It pulls prices from [Twelve Data](https://twelvedata.com) (free plan) and deploys the site plus fresh data to GitHub Pages.
- **API key:** it lives in a GitHub secret and is never in the website.

```
index.html  style.css  app.js        ← the website
tickers.json                         ← your watchlist (symbols, names, default order)
scripts/fetch_data.py                ← downloads prices → data/
scripts/make_mock_data.py            ← fake data for local testing
.github/workflows/update.yml         ← hourly update + deploy
```

## Setup (one time, ~10 minutes)

1. **Create a GitHub repo** named `stockwatch` and push these files to the `main` branch. A public repo is recommended because GitHub Actions minutes are free and unlimited for public repos. Private repos get 2,000 free minutes/month, and this workflow uses roughly that much.
2. **Get a free API key.** Sign up at https://twelvedata.com and copy your API key from the dashboard.
3. **Add the key as a secret.** In the repo, go to *Settings → Secrets and variables → Actions → New repository secret*. Use the name `TWELVE_DATA_API_KEY` and paste your key as the value.
4. **Turn on Pages.** Go to *Settings → Pages → Build and deployment → Source* and choose **GitHub Actions**.
5. **Run it once.** Go to *Actions → "Update prices & deploy" → Run workflow*. The first run takes about 13 minutes because the free plan allows only 8 requests per minute. Later runs take about 7 minutes.
6. Your site is at `https://<your-username>.github.io/stockwatch/`.

After that it updates by itself every hour from 13:15 to 21:15 UTC on weekdays (about 14:15–22:15 in Zurich during winter time). Each push to `main` also redeploys.

## How the free API limits are respected

The Twelve Data Basic plan allows **8 requests/minute and 800/day**.

| What | Requests | How often |
|---|---|---|
| 5-minute bars, last ~5 days (1D + 1W charts, current price) | 1 per symbol | every run |
| Daily closes, ~3 years (1M–3Y charts and % changes) | 1 per symbol | once per day |

With 50 symbols and 9 runs per weekday, that is about 50 × 9 + 50 = **500 requests/day**. The script spaces requests about 7.8 s apart. The downloaded history is kept between runs using the Actions cache.

If you add more symbols, keep `symbols × (runs per day + 1)` under 800, or remove some hours from the `cron` line in `update.yml`.

## Changing the list

Edit `tickers.json`. Each entry has `rank` (the default sort order), `symbol`, `name`, and `type` (`Stock` or `ETF`). Every column in the table can be sorted by clicking its header. The free plan covers US-listed stocks and ETFs.

## Working on the site locally

```bash
python scripts/make_mock_data.py    # fake prices into data/
python -m http.server 8000          # open http://localhost:8000
```

To test with real data locally instead, run `TWELVE_DATA_API_KEY=yourkey python scripts/fetch_data.py`. The `data/` folder is git-ignored.

## Notes

- Prices on the free plan can be delayed, and the site refreshes hourly. That's fine for watching prices but not for trading.
- Twelve Data's free plan terms describe it as being for personal/non-display use. A personal GitHub Pages site is a gray area because Pages sites are publicly reachable. If you ever share the site widely, check their terms or move to a paid plan.
- This is not investment advice.
