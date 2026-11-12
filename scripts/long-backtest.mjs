// 長週期回測：用 Coin Metrics 社群版（免費）補齊 2012 年起的價格與鏈上數據，
// 以和每日流程相同的評分邏輯逐日重算 CBS、CTS、週期指數，輸出 data/long-backtest.json。
// 2022-11 以後才有的數據（資金費率、短期持有者成本、獲利籌碼、巨鯨、ETF）沿用 data/series 的快取。
import { readFile, writeFile } from 'node:fs/promises';
import { scoreAll } from '../assets/scoring.js';

const ROOT = new URL('../', import.meta.url);
const read = async (p, fb) => { try { return JSON.parse(await readFile(new URL(p, ROOT), 'utf8')); } catch { return fb; } };
const WINDOW = 1460;
const UA = { 'User-Agent': 'btc-cycle-radar/2.0 (+github actions)', Accept: 'application/json' };
const r4 = (v, n = 4) => v == null || !Number.isFinite(v) ? null : +v.toFixed(n);
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const pctRank = (arr, x) => ((arr.filter(v => v < x).length + 0.5 * arr.filter(v => v === x).length) / arr.length) * 100;
function supplyAt(dateStr) {
  const ts = Date.parse(dateStr) / 1000;
  const pts = [[1230940800, 0, 7200], [1354060800, 10.5e6, 3600], [1468022400, 15.75e6, 1800], [1589155200, 18.375e6, 900], [1713571200, 19.6875e6, 450]];
  let p = pts[0]; for (const x of pts) if (ts >= x[0]) p = x;
  return Math.min(21e6, p[1] + ((ts - p[0]) / 86400) * p[2]);
}

async function cm(asset, metrics) {
  const out = [];
  let url = `https://community-api.coinmetrics.io/v4/timeseries/asset-metrics?assets=${asset}&metrics=${metrics.join(',')}&frequency=1d&start_time=2011-06-01&page_size=10000`;
  for (let k = 0; k < 10 && url; k++) {
    const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error(`Coin Metrics ${asset} HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    out.push(...(j.data || []));
    url = j.next_page_url || null;
  }
  return out;
}
const btc = await cm('btc', ['PriceUSD', 'CapMrktCurUSD', 'CapMVRVCur', 'IssTotUSD', 'HashRate']);
const eth = await cm('eth', ['PriceUSD']);
console.log(`Coin Metrics：BTC ${btc.length} 天（${btc[0]?.time?.slice(0, 10)} → ${btc.at(-1)?.time?.slice(0, 10)}）、ETH ${eth.length} 天`);

// 日曆：以 Coin Metrics 價格為準，最後幾天用快取價格補齊
const priceM = new Map(btc.filter(r => r.PriceUSD).map(r => [r.time.slice(0, 10), +r.PriceUSD]));
for (const [d, v] of await read('data/series/price.json', [])) if (!priceM.has(d)) priceM.set(d, v);
const cal = [...priceM.keys()].sort().filter(d => d >= '2011-06-01');
const N = cal.length, close = cal.map(d => priceM.get(d));
const at = new Map(cal.map((d, i) => [d, i]));

// 鏈上：MVRV Z（以至今為止的市值標準差）、NUPL、Puell
const mc = new Array(N).fill(null), rc = new Array(N).fill(null), iss = new Array(N).fill(null), hash = new Array(N).fill(null);
for (const r of btc) { const i = at.get(r.time.slice(0, 10)); if (i == null) continue; mc[i] = r.CapMrktCurUSD ? +r.CapMrktCurUSD : null; rc[i] = r.CapMVRVCur && r.CapMrktCurUSD ? +r.CapMrktCurUSD / +r.CapMVRVCur : null; iss[i] = r.IssTotUSD ? +r.IssTotUSD : null; hash[i] = r.HashRate ? +r.HashRate : null; }
const raw = { mvrv: new Array(N).fill(null), nupl: new Array(N).fill(null), puell: new Array(N).fill(null) };
{ let n = 0, s = 0, s2 = 0; const isq = [];
  for (let i = 0; i < N; i++) {
    if (mc[i] != null) { n++; s += mc[i]; s2 += mc[i] * mc[i]; }
    const sd = n > 30 ? Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2)) : null;
    if (mc[i] != null && rc[i] != null && sd) { raw.mvrv[i] = (mc[i] - rc[i]) / sd; raw.nupl[i] = (mc[i] - rc[i]) / mc[i]; }
    if (iss[i] != null) isq.push(iss[i]); else isq.push(null);
    const w = isq.slice(-365).filter(x => x != null);
    if (iss[i] != null && w.length >= 300) raw.puell[i] = iss[i] / (w.reduce((a, b) => a + b, 0) / w.length);
  }
}
// 來源延遲：鏈上 7 天、算力 8 天、資金費率 8 天、ETF 3 天（與目前實際延遲一致）
const LAG = { chain: 7, hash: 8, funding: 8, etf: 3 };
const shift = (arr, n) => { const o = new Array(N).fill(null); for (let i = 0; i < N; i++) if (arr[i] != null && i + n < N) o[i + n] = arr[i]; return o; };
const fill = (arr, gap = 7) => { const o = arr.slice(); let lv = null, li = -1e9; for (let i = 0; i < N; i++) { if (arr[i] != null) { lv = arr[i]; li = i; } else if (lv != null && i - li <= gap) o[i] = lv; } return o; };
const F = { mvrv: fill(shift(raw.mvrv, LAG.chain)), nupl: fill(shift(raw.nupl, LAG.chain)), puell: fill(shift(raw.puell, LAG.chain)), hash: fill(shift(hash, LAG.hash)) };
const series = async (name, lag = 0, col = 1, gap = 7, doFill = true) => {
  const a = new Array(N).fill(null);
  for (const r of await read(`data/series/${name}.json`, [])) { const i = at.get(addDays(r[0], lag)); if (i != null) a[i] = r[col]; }
  return doFill ? fill(a, gap) : a;
};
F.fng = await series('fng', 0, 1, 3); F.stable = await series('stable');
F.funding = await series('funding', LAG.funding); F.oi = await series('oi', LAG.funding);
F.sthrp = await series('sthrp', LAG.chain); F.profit = await series('profit', LAG.chain); F.whale = await series('whale', 2);
F.etf = await series('etf', LAG.etf, 1, 0, false);
{ const a = F.funding.filter(v => v != null).map(Math.abs).sort((x, y) => x - y); if (a.length && a[a.length >> 1] < 0.001) F.funding = F.funding.map(v => v == null ? null : v * 100); }
{ const a = F.profit.filter(v => v != null); if (a.length && Math.max(...a) <= 1) F.profit = F.profit.map(v => v == null ? null : v * 100); }
const ethM = new Map(eth.filter(r => r.PriceUSD).map(r => [r.time.slice(0, 10), +r.PriceUSD]));
for (const [d, v] of await read('data/series/eth.json', [])) if (!ethM.has(d)) ethM.set(d, v);
F.eth = cal.map(d => ethM.get(d) ?? null);

// ---------- 逐日指標（與 scripts/fetch.mjs 相同的公式） ----------
const config = await read('config/indicators.json');
const defs = config.indicators;
const V = {}; for (const d of defs) V[d.id] = new Array(N).fill(null);
const FX = Array.from({ length: N }, () => ({}));
const pre = [0]; for (const c of close) pre.push(pre.at(-1) + c);
const sma = (i, n) => i + 1 >= n ? (pre[i + 1] - pre[i + 1 - n]) / n : null;
const ema150 = new Array(N).fill(null);
{ const k = 2 / 151; let e = null; for (let i = 0; i < N; i++) { if (i === 149) e = sma(i, 150); else if (i > 149) e = close[i] * k + e * (1 - k); ema150[i] = e; } }
const isSunday = d => new Date(d + 'T00:00:00Z').getUTCDay() === 0;
function rsiW(arr) {
  const n = 14; if (arr.length <= n) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = arr[i] - arr[i - 1]; d > 0 ? (g += d) : (l -= d); }
  g /= n; l /= n;
  for (let i = n + 1; i < arr.length; i++) { const d = arr[i] - arr[i - 1]; g = (g * 13 + Math.max(d, 0)) / n; l = (l * 13 + Math.max(-d, 0)) / n; }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}
{ const h = F.hash, hp = [0], cnt = [0];
  for (const x of h) { hp.push(hp.at(-1) + (x ?? 0)); cnt.push(cnt.at(-1) + (x != null ? 1 : 0)); }
  const m = (i, n) => i + 1 >= n && cnt[i + 1] - cnt[i + 1 - n] === n ? (hp[i + 1] - hp[i + 1 - n]) / n : null;
  let lastCross = -1e9, prevBelow = null;
  for (let i = 0; i < N; i++) {
    const a = m(i, 30), b = m(i, 60); if (a == null || b == null) continue;
    const below = a < b;
    if (prevBelow === true && !below) lastCross = i;
    prevBelow = below;
    V.hashribbons[i] = below ? 'capitulation' : i - lastCross <= 20 ? 'recovery' : 'normal';
  }
}
const weekly = [], ssrArr = new Array(N).fill(null);
const etf0 = F.etf.findIndex(v => v != null);
const nz = (i) => etf0 >= 0 && i >= etf0 ? (F.etf[i] ?? 0) : 0;
for (let i = 0; i < N; i++) {
  const c = close[i];
  if (isSunday(cal[i])) weekly.push(c);
  const wk = isSunday(cal[i]) ? weekly : [...weekly.slice(-300), c];
  const set = (id, v, fields) => { if (V[id] && v != null && Number.isFinite(v)) { V[id][i] = v; if (fields) FX[i][id] = fields; } };
  set('rsi_w', rsiW(wk.slice(-300)));
  if (wk.length >= 200) set('wma200', c / (wk.slice(-200).reduce((s, x) => s + x, 0) / 200));
  if (sma(i, 350)) set('pi_top', sma(i, 111) / (2 * sma(i, 350)));
  if (sma(i, 471) && ema150[i]) set('pi_bottom', ema150[i] / (0.745 * sma(i, 471)));
  if (sma(i, 200)) set('mayer', c / sma(i, 200));
  set('mvrv', F.mvrv[i]); set('nupl', F.nupl[i]); set('puell', F.puell[i]);
  if (F.fng[i] != null) { const w = F.fng.slice(Math.max(0, i - 13), i + 1).filter(x => x != null); set('fng', F.fng[i], w.length >= 14 ? { min14: Math.min(...w) } : {}); }
  if (F.stable[i]) ssrArr[i] = c * supplyAt(cal[i]) / F.stable[i];
  if (F.stable[i] && i >= 30 && F.stable[i - 30]) set('stable30', (F.stable[i] / F.stable[i - 30] - 1) * 100);
  if (F.funding[i] != null) {
    const f = { max3: Math.max(...F.funding.slice(Math.max(0, i - 2), i + 1).map(x => x ?? -Infinity)) };
    const oi = F.oi.slice(Math.max(0, i - 364), i + 1).filter(x => x != null);
    if (oi.length >= 30 && F.oi[i] != null) {
      const cur = F.oi[i], peak = Math.max(...oi), low14 = Math.min(...oi.slice(-14)), wk1 = F.oi[i - 7];
      const dd = (1 - cur / peak) * 100, rebound = cur > low14 * 1.03 && wk1 != null && cur > wk1;
      f.oiDD = rebound ? r4(dd, 1) : 0; f.oi = r4(cur / 1e9, 2); f.oiDrop = r4(dd, 1);
    }
    set('funding', F.funding[i], f);
  }
  if (etf0 >= 0 && i >= etf0 + 6) {
    const roll = j => { let s = 0; for (let k = j - 6; k <= j; k++) s += nz(k); return s; };
    const hist = []; for (let j = Math.max(etf0 + 6, i - 179); j <= i; j++) hist.push(roll(j));
    if (hist.length >= 40) set('etf_flow', roll(i), { pct7: r4(pctRank(hist, roll(i)), 1) });
  }
  if (F.sthrp[i]) set('sth_mvrv', c / F.sthrp[i]);
  if (F.eth[i]) set('ethbtc', F.eth[i] / c);
  set('profit_supply', F.profit[i]);
  if (F.whale[i] != null && i >= 30 && F.whale[i - 30]) set('whale', (F.whale[i] / F.whale[i - 30] - 1) * 100);
}
for (let i = 0; i < N; i++) if (ssrArr[i] != null) {
  V.ssr[i] = ssrArr[i];
  const w = []; for (let k = Math.max(0, i - WINDOW + 1); k <= i; k++) if (ssrArr[k] != null) w.push(ssrArr[k]);
  if (w.length >= 365) FX[i].ssr = { pct: r4(pctRank(w, ssrArr[i]), 1) };
}
const P = {};
for (const d of defs) if (d.rel) {
  P[d.id] = new Array(N).fill(null);
  const v = V[d.id];
  for (let i = 0; i < N; i++) {
    if (v[i] == null) continue;
    let lt = 0, eq = 0, n = 0;
    for (let k = Math.max(0, i - WINDOW + 1); k <= i; k++) { const x = v[k]; if (x == null) continue; n++; if (x < v[i]) lt++; else if (x === v[i]) eq++; }
    if (n >= 365) P[d.id][i] = r4(((lt + 0.5 * eq) / n) * 100, 1);
  }
}
const indicatorsAt = i => { const o = {}; for (const d of defs) { const v = V[d.id][i]; if (v == null) continue; const fields = { ...(FX[i][d.id] || {}) }; if (P[d.id]?.[i] != null) fields.p = P[d.id][i]; o[d.id] = { value: typeof v === 'number' ? r4(v, 5) : v, fields }; } return o; };
const cycleIndex = i => { const ps = defs.filter(d => d.index && P[d.id]?.[i] != null).map(d => P[d.id][i]); return ps.length >= 5 ? r4(ps.reduce((a, b) => a + b, 0) / ps.length, 1) : null; };
// ETF 近 30 日淨流量百分位
const E30 = new Array(N).fill(null), E30P = new Array(N).fill(null);
if (etf0 >= 0) for (let i = etf0 + 29; i < N; i++) {
  let s = 0; for (let k = i - 29; k <= i; k++) s += nz(k); E30[i] = s;
  const h = E30.slice(Math.max(etf0 + 29, i - WINDOW + 1), i + 1).filter(x => x != null);
  if (h.length >= 120) E30P[i] = r4(pctRank(h, s), 1);
}
const start = cal.indexOf('2016-01-01');
const rows = [];
for (let i = start; i < N; i++) {
  const s = scoreAll(config, indicatorsAt(i));
  const ma = sma(i, config.trend?.ma || 350);
  rows.push([cal[i], Math.round(close[i] * 100) / 100, s.cbs.score, s.cts.score, s.cbs.confirm.pct, s.cts.confirm.pct, cycleIndex(i), ma ? Math.round(ma) : null, P.ethbtc?.[i] ?? null, E30P[i],
    defs.filter(d => d.index && P[d.id]?.[i] != null).length]);
}
await writeFile(new URL('data/long-backtest.json', ROOT), JSON.stringify({ generatedAt: new Date().toISOString(), lags: LAG, source: 'Coin Metrics Community + data/series',
  fields: ['date', 'price', 'cbs', 'cts', 'cbsConfirm', 'ctsConfirm', 'idx', 'ma50w', 'ethPct', 'etf30p', 'idxN'], rows }) + '\n');
const y = rows.filter(r => r[0].endsWith('-01-01') || r[0] === rows.at(-1)[0]).map(r => `${r[0]} $${Math.round(r[1])} CBS${r[2]} CTS${r[3]} 指數${r[6]}(${r[10]})`);
console.log(y.join('\n'));
console.log(`完成：${rows.length} 天`);
