/* StockWatch — renders data/summary.json as a table and draws charts on demand. */
(() => {
  "use strict";

  const RANGES = ["1D", "1W", "1M", "6M", "1Y", "3Y"];
  const RANGE_LABEL = { "1D": "today", "1W": "past week", "1M": "past month", "6M": "past 6 months", "1Y": "past year", "3Y": "past 3 years" };
  const RANGE_MONTHS = { "1M": 1, "6M": 6, "1Y": 12, "3Y": 36 };
  const REFRESH_MS = 10 * 60 * 1000;

  const state = {
    items: [],
    filter: "all",
    query: "",
    sort: { key: "rank", dir: 1 },
    open: null,          // symbol currently expanded
    range: "1D",
    details: new Map(),  // symbol -> Promise<detail json>
  };

  const $ = (sel, el = document) => el.querySelector(sel);
  const rowsEl = $("#rows");
  const NS = "http://www.w3.org/2000/svg";

  // ---------------------------------------------------------------- formatting
  const fmtPrice = (v) => v == null ? "—" : v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtPct = (v) => v == null ? "—" : (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(2) + "%";
  const cls = (v) => v == null ? "na" : v > 0 ? "up" : v < 0 ? "down" : "";
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const parseD = (s) => ({ y: +s.slice(0, 4), m: +s.slice(5, 7), d: +s.slice(8, 10), hm: s.length > 10 ? s.slice(11, 16) : null });

  function shiftDate(iso, { days = 0, months = 0 }) {
    const d = new Date(iso.slice(0, 10) + "T00:00:00Z");
    if (months) {
      const day = d.getUTCDate();
      d.setUTCDate(1);
      d.setUTCMonth(d.getUTCMonth() + months);
      const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      d.setUTCDate(Math.min(day, last));
    }
    if (days) d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  // ---------------------------------------------------------------- data
  async function loadSummary() {
    const res = await fetch("data/summary.json?t=" + Date.now());
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    state.items = data.items || [];
    state.details.clear();
    renderMeta(data);
    render();
  }

  function loadDetail(sym) {
    if (!state.details.has(sym)) {
      const p = fetch(`data/symbols/${encodeURIComponent(sym)}.json?t=${Date.now()}`)
        .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); });
      p.catch(() => state.details.delete(sym));
      state.details.set(sym, p);
    }
    return state.details.get(sym);
  }

  function renderMeta(data) {
    const meta = $("#meta");
    const updated = data.updated ? new Date(data.updated) : null;
    const asOf = state.items.map((i) => i.asOf).filter(Boolean).sort().pop();
    const mock = /mock/i.test(data.source || "");
    meta.innerHTML =
      (updated ? `Updated <b>${updated.toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}</b>` : "") +
      (asOf ? ` · last price ${fmtStamp(asOf)} New York` : "") +
      ` · <span class="${mock ? "mock" : ""}">${data.source || ""}</span>`;
    $("#foot").textContent =
      "Prices may be delayed and are updated about once an hour while US markets are open. Not investment advice. " +
      "Tip: click a % cell to open the chart at that timeframe.";
  }

  function fmtStamp(s) {
    const p = parseD(s);
    return `${MON[p.m - 1]} ${p.d}${p.hm ? ", " + p.hm : ""}`;
  }

  // ---------------------------------------------------------------- table
  function visibleItems() {
    const q = state.query.trim().toLowerCase();
    const { key, dir } = state.sort;
    const val = (it) => RANGES.includes(key) ? it.changes?.[key] : it[key];
    return state.items
      .filter((it) => state.filter === "all" || it.type === state.filter)
      .filter((it) => !q || it.symbol.toLowerCase().includes(q) || (it.name || "").toLowerCase().includes(q))
      .sort((a, b) => {
        const va = val(a), vb = val(b);
        if (va == null && vb == null) return 0;
        if (va == null) return 1;           // missing values always last
        if (vb == null) return -1;
        if (typeof va === "string") return va.localeCompare(vb) * dir;
        return (va - vb) * dir;
      });
  }

  function sparkSVG(values) {
    if (!values || values.length < 2) return "";
    const w = 84, h = 22, min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
    const pts = values.map((v, i) => `${(i / (values.length - 1) * w).toFixed(1)},${(h - 2 - (v - min) / span * (h - 4)).toFixed(1)}`).join(" ");
    const color = values[values.length - 1] >= values[0] ? "var(--up)" : "var(--down)";
    return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
  }

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function render() {
    document.querySelectorAll("th[data-sort]").forEach((th) => {
      th.classList.toggle("sorted", th.dataset.sort === state.sort.key);
      th.classList.toggle("asc", state.sort.dir === 1);
    });

    const items = visibleItems();
    if (!items.length) {
      rowsEl.innerHTML = `<tr><td colspan="10" class="empty">No matches.</td></tr>`;
      return;
    }
    rowsEl.innerHTML = items.map((it) => `
      <tr class="row${it.symbol === state.open ? " open" : ""}" data-sym="${esc(it.symbol)}" tabindex="0">
        <td class="num rank">${it.rank ?? ""}</td>
        <td class="left"><span class="sym">${esc(it.symbol)}</span>${it.type === "ETF" ? '<span class="tag">ETF</span>' : ""}<span class="nm">${esc(it.name || "")}</span></td>
        <td class="spark-col">${sparkSVG(it.spark)}</td>
        <td class="num price">${fmtPrice(it.price)}</td>
        ${RANGES.map((r) => `<td class="num pct" data-range="${r}"><span class="${cls(it.changes?.[r])}">${fmtPct(it.changes?.[r])}</span></td>`).join("")}
      </tr>`).join("");

    if (state.open) {
      const row = rowsEl.querySelector(`tr.row[data-sym="${CSS.escape(state.open)}"]`);
      if (row) openDetail(row, state.open);
    }
  }

  // ---------------------------------------------------------------- detail panel
  function openDetail(row, sym) {
    const item = state.items.find((i) => i.symbol === sym);
    const frag = $("#detail-tpl").content.cloneNode(true);
    const tr = frag.querySelector("tr");
    $(".d-sym", tr).textContent = sym;
    $(".d-name", tr).textContent = item?.name || "";
    $(".d-last", tr).textContent = fmtPrice(item?.price);
    // keep the panel the width of the visible table, even when the table scrolls sideways (phones)
    $(".detail", tr).style.width = $(".table-wrap").clientWidth + "px";
    row.after(tr);

    tr.querySelectorAll(".ranges button").forEach((b) => b.addEventListener("click", (e) => {
      e.stopPropagation();
      state.range = b.dataset.range;
      updateDetail(tr, item);
    }));
    updateDetail(tr, item);
  }

  function updateDetail(tr, item) {
    const r = state.range;
    tr.querySelectorAll(".ranges button").forEach((b) => b.classList.toggle("on", b.dataset.range === r));
    const chg = item?.changes?.[r];
    const chgEl = $(".d-chg", tr);
    chgEl.textContent = fmtPct(chg);
    chgEl.className = "d-chg " + cls(chg);
    $(".d-range-label", tr).textContent = RANGE_LABEL[r];

    const box = $(".chart", tr);
    box.innerHTML = `<div class="msg">Loading chart…</div>`;
    loadDetail(item.symbol)
      .then((detail) => {
        if (state.open !== item.symbol || state.range !== r) return; // user moved on
        drawChart(box, seriesFor(detail, r), r, chg);
      })
      .catch(() => { box.innerHTML = `<div class="msg">Couldn't load chart data.</div>`; });
  }

  function seriesFor(detail, range) {
    if (range === "1D" || range === "1W") {
      const t = detail.intraday?.t || [], c = detail.intraday?.c || [];
      if (!t.length) return { t: [], c: [], intraday: true };
      const lastDay = t[t.length - 1].slice(0, 10);
      const from = range === "1D" ? lastDay : shiftDate(lastDay, { days: -6 });
      const idx = t.findIndex((s) => s.slice(0, 10) >= from);
      return {
        t: t.slice(idx), c: c.slice(idx), intraday: true,
        base: range === "1D" ? detail.prevClose : null,
      };
    }
    const t = detail.daily?.t || [], c = detail.daily?.c || [];
    if (!t.length) return { t: [], c: [] };
    const cutoff = shiftDate(t[t.length - 1], { months: -RANGE_MONTHS[range] });
    // start at the last close on/before the cutoff (same base as the % in the table)
    let idx = 0;
    for (let i = t.length - 1; i >= 0; i--) if (t[i] <= cutoff) { idx = i; break; }
    return { t: t.slice(idx), c: c.slice(idx) };
  }

  // ---------------------------------------------------------------- chart
  function niceTicks(min, max, count = 4) {
    const span = max - min || Math.abs(max) || 1;
    const raw = span / count, mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
    const ticks = [];
    for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) ticks.push(+v.toFixed(10));
    return ticks;
  }

  function xLabel(s, range) {
    const p = parseD(s);
    if (range === "1D") return p.hm;
    if (range === "1W" || range === "1M") return `${MON[p.m - 1]} ${p.d}`;
    if (range === "6M" || range === "1Y") return p.m === 1 ? String(p.y) : MON[p.m - 1];
    return String(p.y);
  }

  function el(name, attrs = {}, parent) {
    const n = document.createElementNS(NS, name);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }

  function drawChart(box, s, range, chg) {
    box.innerHTML = "";
    if (s.c.length < 2) { box.innerHTML = `<div class="msg">Not enough data for this range yet.</div>`; return; }

    const W = box.clientWidth, H = box.clientHeight;
    const pad = { l: 4, r: 54, t: 12, b: 22 };
    const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;

    let min = Math.min(...s.c), max = Math.max(...s.c);
    if (s.base != null) { min = Math.min(min, s.base); max = Math.max(max, s.base); }
    const padY = (max - min) * 0.08 || max * 0.01;
    min -= padY; max += padY;

    const n = s.c.length;
    const x = (i) => pad.l + (i / (n - 1)) * iw;
    const y = (v) => pad.t + (1 - (v - min) / (max - min)) * ih;

    const up = (chg ?? (s.c[n - 1] - s.c[0])) >= 0;
    const color = up ? "var(--up)" : "var(--down)";
    const gid = "g" + Math.random().toString(36).slice(2);

    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none" }, box);
    const defs = el("defs", {}, svg);
    const grad = el("linearGradient", { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
    el("stop", { offset: "0%", "stop-color": up ? "#34d399" : "#f87171", "stop-opacity": 0.22 }, grad);
    el("stop", { offset: "100%", "stop-color": up ? "#34d399" : "#f87171", "stop-opacity": 0 }, grad);

    // horizontal grid + right-side price axis
    for (const v of niceTicks(min, max)) {
      el("line", { class: "gridline", x1: pad.l, x2: pad.l + iw, y1: y(v), y2: y(v) }, svg);
      const t = el("text", { class: "axis", x: pad.l + iw + 8, y: y(v) + 3.5 }, svg);
      t.textContent = fmtPrice(v);
    }

    // x-axis labels: for 1W one per trading day, otherwise ~5 evenly spaced
    let xIdx = [];
    const maxLabels = Math.max(2, Math.floor(iw / 80));
    if (range === "1W") {
      s.t.forEach((ts, i) => { if (i === 0 || ts.slice(0, 10) !== s.t[i - 1].slice(0, 10)) xIdx.push(i); });
    } else if (range !== "1D" && range !== "1M") {
      // label where a new month (6M, 1Y) or new year (3Y) starts
      const cut = range === "3Y" ? 4 : 7;
      s.t.forEach((ts, i) => { if (i > 0 && ts.slice(0, cut) !== s.t[i - 1].slice(0, cut)) xIdx.push(i); });
      const step = Math.ceil(xIdx.length / maxLabels);
      xIdx = xIdx.filter((_, j) => j % step === 0);
    } else {
      const k = Math.max(2, Math.min(6, Math.floor(iw / 110)));
      for (let j = 0; j < k; j++) xIdx.push(Math.round(j * (n - 1) / (k - 1)));
    }
    const boundary = range !== "1D" && range !== "1M";
    xIdx.forEach((i, j) => {
      if (boundary && i !== 0) el("line", { class: "gridline", x1: x(i), x2: x(i), y1: pad.t, y2: pad.t + ih, opacity: 0.6 }, svg);
      const anchor = boundary ? "start" : j === 0 ? "start" : j === xIdx.length - 1 ? "end" : "middle";
      const t = el("text", { class: "axis", x: x(i) + (boundary && i !== 0 ? 4 : 0), y: H - 6, "text-anchor": anchor }, svg);
      t.textContent = xLabel(s.t[i], range);
    });

    // previous-close reference line (1D)
    if (s.base != null) {
      el("line", { class: "baseline", x1: pad.l, x2: pad.l + iw, y1: y(s.base), y2: y(s.base) }, svg);
      const t = el("text", { class: "axis", x: pad.l + 2, y: y(s.base) - 4 }, svg);
      t.textContent = "prev close";
    }

    const d = s.c.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
    el("path", { d: `${d}L${x(n - 1)},${pad.t + ih}L${x(0)},${pad.t + ih}Z`, fill: `url(#${gid})` }, svg);
    el("path", { d, fill: "none", stroke: color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round", "vector-effect": "non-scaling-stroke" }, svg);

    // hover layer: crosshair + dot + tooltip
    const cross = el("line", { class: "cross", y1: pad.t, y2: pad.t + ih, visibility: "hidden" }, svg);
    const dot = el("circle", { r: 4, fill: color, stroke: "var(--panel-2)", "stroke-width": 2, visibility: "hidden" }, svg);
    const tip = document.createElement("div");
    tip.className = "tip"; tip.hidden = true;
    box.appendChild(tip);
    const hit = el("rect", { x: pad.l, y: 0, width: iw, height: H, fill: "transparent" }, svg);

    const ref = s.base ?? s.c[0];
    const move = (e) => {
      const r = svg.getBoundingClientRect();
      const px = (e.clientX - r.left) * (W / r.width);
      const i = Math.max(0, Math.min(n - 1, Math.round((px - pad.l) / iw * (n - 1))));
      const cx = x(i), cy = y(s.c[i]);
      cross.setAttribute("x1", cx); cross.setAttribute("x2", cx); cross.setAttribute("visibility", "visible");
      dot.setAttribute("cx", cx); dot.setAttribute("cy", cy); dot.setAttribute("visibility", "visible");
      const p = (s.c[i] / ref - 1) * 100;
      tip.innerHTML = `<b>${fmtPrice(s.c[i])}</b> <span class="${cls(p)}">${fmtPct(p)}</span><span class="t">${fmtStamp(s.t[i])}</span>`;
      tip.hidden = false;
      const tw = tip.offsetWidth;
      tip.style.left = Math.max(tw / 2, Math.min(W - tw / 2, cx * r.width / W)) + "px";
      tip.style.top = Math.max(0, cy - 10) + "px";
    };
    const leave = () => { cross.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); tip.hidden = true; };
    hit.addEventListener("pointermove", move);
    hit.addEventListener("pointerdown", move);
    hit.addEventListener("pointerleave", leave);

    box.setAttribute("aria-label", `${range} price chart, from ${fmtPrice(s.c[0])} to ${fmtPrice(s.c[n - 1])}`);
  }

  // ---------------------------------------------------------------- events
  rowsEl.addEventListener("click", (e) => {
    const row = e.target.closest("tr.row");
    if (!row) return;
    const sym = row.dataset.sym;
    const cell = e.target.closest("td.pct");
    if (cell) {
      // clicking a % cell opens (or switches) the chart at that timeframe
      state.range = cell.dataset.range;
      state.open = sym;
    } else if (state.open === sym) {
      state.open = null;
    } else {
      state.open = sym;
      state.range = "1D";
    }
    render();
  });
  rowsEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.matches("tr.row")) e.target.click();
  });

  document.querySelectorAll("th[data-sort]").forEach((th) => th.addEventListener("click", () => {
    const key = th.dataset.sort;
    if (state.sort.key === key) state.sort.dir *= -1;
    else state.sort = { key, dir: key === "rank" || key === "symbol" ? 1 : -1 };
    render();
  }));

  document.querySelectorAll("[data-filter]").forEach((b) => b.addEventListener("click", () => {
    state.filter = b.dataset.filter;
    document.querySelectorAll("[data-filter]").forEach((x) => x.classList.toggle("on", x === b));
    render();
  }));

  $("#search").addEventListener("input", (e) => { state.query = e.target.value; render(); });

  let rt;
  window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => state.open && render(), 150); });

  loadSummary().catch((err) => {
    $("#meta").textContent = "Could not load data/summary.json (" + err.message + ").";
    rowsEl.innerHTML = `<tr><td colspan="10" class="empty">No data yet. Run the GitHub Action, or <code>python scripts/make_mock_data.py</code> for local testing.</td></tr>`;
  });
  setInterval(() => loadSummary().catch(() => {}), REFRESH_MS);
})();
