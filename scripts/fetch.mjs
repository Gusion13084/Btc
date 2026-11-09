// 每日數據流程（台灣時間）：09:00 抓數據（--fetch-only）→ 10:00 補齊並寫入當日快照 → 12:00 補抓失敗項目
// 做法：把每個來源的「歷史序列」快取在 data/series/，每次執行用同一套邏輯逐日重算所有指標與評分。
// 好處：今天的數值和回測用的是完全相同的計算；改了門檻，下次執行回測就會跟著更新。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { scoreAll, indexZone, decide } from '../assets/scoring.js';
import { buildLiqMap, buildLiqMapMulti } from './liqmap.mjs';
import { fetchMarket } from './market.mjs';

const ROOT = new URL('../', import.meta.url);
const read = async (p, fb) => { try { return JSON.parse(await readFile(new URL(p, ROOT), 'utf8')); } catch { return fb; } };
const write = async (p, d, pretty = true) => {
  await mkdir(new URL(p.replace(/[^/]+$/, ''), ROOT), { recursive: true });
  await writeFile(new URL(p, ROOT), (pretty ? JSON.stringify(d, null, 1) : JSON.stringify(d)) + '\n');
};

const START = '2017-01-01';   // 價格類歷史起點（均線需要約 471 天暖機）
const WINDOW = 1460;          // 相對位置（百分位）視窗：近 4 年
const BG_BUDGET = 10;         // BGeometrics 免費方案每小時 10 次、每天 15 次；每天第一次執行用滿 10 次，之後當天已抓過的會略過
const args = process.argv.slice(2);
const force = args.includes('--force'), fetchOnly = args.includes('--fetch-only');
const nowISO = new Date().toISOString();

// ---------- 小工具 ----------
const UA = { 'User-Agent': 'btc-cycle-radar/2.0 (+github actions)', Accept: 'application/json' };
async function getJSON(url, tries = 2) {
  let err;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(40000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) { err = e; if (i + 1 < tries) await new Promise(s => setTimeout(s, 3000)); }
  }
  throw new Error(`${url.split('?')[0]} → ${err.message}`);
}
const taipeiDate = (d = new Date()) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(d);
const isoDay = sec => new Date(sec * 1000).toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const fmtB = n => '$' + (n / 1e9).toFixed(1) + 'B';
const usd = n => '$' + Math.round(n).toLocaleString('en-US');
const r4 = (v, n = 4) => v == null || !Number.isFinite(v) ? null : +v.toFixed(n);
const today = taipeiDate();

function pickNumber(o, prefer = []) {
  if (o == null || typeof o !== 'object') return Number(o);
  for (const k of prefer || []) if (o[k] != null && Number.isFinite(Number(o[k]))) return Number(o[k]);
  const skip = /^(d|date|day|time|timestamp|unixts|id|ts)$/i;
  for (const [k, v] of Object.entries(o)) if (!skip.test(k) && v !== null && v !== '' && Number.isFinite(Number(v))) return Number(v);
  return NaN;
}
function pickKey(o, re) { for (const [k, v] of Object.entries(o || {})) if (re.test(k) && Number.isFinite(Number(v))) return Number(v); return null; }
function pickDate(o) {
  for (const k of ['d', 'date', 'day', 'theDay']) if (typeof o?.[k] === 'string' && /^\d{4}-\d{2}-\d{2}/.test(o[k])) return o[k].slice(0, 10);
  for (const k of ['unixTs', 'timestamp', 'time', 'ts']) if (o?.[k] != null) { const t = Number(o[k]); if (Number.isFinite(t)) return isoDay(t > 1e12 ? t / 1000 : t); }
  return null;
}
const rowsOf = j => Array.isArray(j) ? j : (j?.data || j?.values || [j]);
function supplyAt(dateStr) {
  const ts = Date.parse(dateStr) / 1000;
  const pts = [[1468022400, 15.75e6, 1800], [1589155200, 18.375e6, 900], [1713571200, 19.6875e6, 450]];
  let p = pts[0]; for (const x of pts) if (ts >= x[0]) p = x;
  return Math.min(21e6, p[1] + ((ts - p[0]) / 86400) * p[2]);
}
function merge(oldRows, newRows) {
  const m = new Map(oldRows.map(r => [r[0], r]));
  for (const r of newRows) if (r[0]) m.set(r[0], r);
  return [...m.values()].sort((a, b) => a[0].localeCompare(b[0]));
}
const pctRank = (arr, x) => ((arr.filter(v => v < x).length + 0.5 * arr.filter(v => v === x).length) / arr.length) * 100;

// ---------- 來源狀態與序列快取 ----------
const meta = await read('data/series/_meta.json', {});
const status = {};
const NAMES = { deribit: 'Deribit 期權與期貨', coinbase: 'Coinbase 溢價', okxfund: 'OKX 資金費率', eth: 'OKX ETH 日線', price: 'BTC 價格（Blockchain.com + Kraken）', fng: 'Alternative.me 恐懼貪婪', hash: 'Blockchain.com 算力', stable: 'DefiLlama 穩定幣', market: 'CoinGecko 市值', bgcore: 'BGeometrics 核心', bgaux: 'BGeometrics 輔助', okx: 'OKX 合約數據' };
const setStatus = (k, ok, error = null) => { status[k] = { name: NAMES[k], ok, error, checkedAt: nowISO }; };
const S = {};
const now = {};
const load = async name => { S[name] = await read(`data/series/${name}.json`, []); };
const save = async name => write(`data/series/${name}.json`, S[name], false);

// ---------- 抓取：免費全歷史來源 ----------
await load('price');
try {
  let base = [];
  try {
    const j = await getJSON('https://api.blockchain.info/charts/market-price?timespan=all&format=json&sampled=false');
    base = j.values.map(v => [isoDay(v.x), v.y]).filter(r => r[0] >= START && r[1] > 0);
  } catch (e) { console.warn('Blockchain.com 價格失敗，改用 Kraken 與快取：', e.message); }
  const k = await getJSON('https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=1440');
  const kr = Object.values(k.result).find(Array.isArray).map(r => [isoDay(+r[0]), +r[4]]);
  S.price = merge(merge(S.price, base), kr);
  try { const e = await getJSON('https://api.kraken.com/0/public/Ticker?pair=ETHUSD'); now.ethPrice = +Object.values(e.result)[0].c[0]; } catch {}
  setStatus('price', true);
} catch (e) { setStatus('price', false, e.message); }
if (!S.price.length) { console.error('沒有價格資料，無法計算'); process.exit(1); }

// ETH 日線（OKX，用於 ETH/BTC 濾網）：第一次抓近 5 年，之後只補最新 100 天
await load('eth');
try {
  let got = [];
  // 歷史不足（需從 2018 年起，才能算 2022 年的近 4 年百分位）就往回補
  const backfill = !S.eth.length || S.eth[0][0] > '2018-07-01';
  let after = backfill && S.eth.length ? String(Date.parse(S.eth[0][0] + 'T00:00:00Z')) : '';
  if (backfill && S.eth.length) {
    for (let k = 0; k < 15; k++) {
      const j = await getJSON(`https://www.okx.com/api/v5/market/history-candles?instId=ETH-USDT&bar=1Dutc&limit=100&after=${after}`);
      const d = j.data || []; if (!d.length) break;
      got.push(...d.map(c => [isoDay(+c[0] / 1000), +c[4]])); after = d[d.length - 1][0];
      if (isoDay(+after / 1000) < '2018-07-01') break;
      await new Promise(r => setTimeout(r, 150));
    }
    after = '';
  }
  for (let k = 0; k < (S.eth.length > 1000 ? 1 : 30); k++) {
    const j = await getJSON(`https://www.okx.com/api/v5/market/history-candles?instId=ETH-USDT&bar=1Dutc&limit=100${after ? `&after=${after}` : ''}`);
    const d = j.data || []; if (!d.length) break;
    got.push(...d.map(c => [isoDay(+c[0] / 1000), +c[4]])); after = d[d.length - 1][0];
    await new Promise(r => setTimeout(r, 150));
  }
  if (!got.length) throw new Error('沒有資料');
  S.eth = merge(S.eth, got);
  try { const e = await getJSON('https://api.kraken.com/0/public/Ticker?pair=ETHUSD'); S.eth = merge(S.eth, [[isoDay(Date.now() / 1000), +Object.values(e.result)[0].c[0]]]); } catch {}
  setStatus('eth', true);
} catch (e) { setStatus('eth', false, e.message); }

await load('fng');
try {
  const j = await getJSON('https://api.alternative.me/fng/?limit=0');
  S.fng = merge(S.fng, j.data.map(x => [isoDay(+x.timestamp), +x.value, x.value_classification]));
  setStatus('fng', true);
} catch (e) { setStatus('fng', false, e.message); }

await load('hash');
try {
  const j = await getJSON('https://api.blockchain.info/charts/hash-rate?timespan=10years&format=json&sampled=false');
  S.hash = merge(S.hash, j.values.map(v => [isoDay(v.x), v.y / 1e6]).filter(r => r[0] >= START));
  setStatus('hash', true);
} catch (e) { setStatus('hash', false, e.message); }

await load('stable');
try {
  const j = await getJSON('https://stablecoins.llama.fi/stablecoincharts/all');
  S.stable = merge(S.stable, j.map(c => [isoDay(+c.date), c.totalCirculatingUSD?.peggedUSD ?? c.totalCirculating?.peggedUSD]).filter(r => r[1] > 0));
  const cur = await getJSON('https://stablecoins.llama.fi/stablecoins?includePrices=true');
  now.stableBy = {}; now.stableTotal = 0;
  for (const a of cur.peggedAssets) { const v = a.circulating?.peggedUSD || 0; now.stableTotal += v; now.stableBy[a.symbol] = (now.stableBy[a.symbol] || 0) + v; }
  setStatus('stable', true);
} catch (e) { setStatus('stable', false, e.message); }
try {
  const g = (await getJSON('https://api.coingecko.com/api/v3/global')).data;
  now.totalCrypto = g.total_market_cap.usd; now.btcDom = g.market_cap_percentage?.btc ?? null;
  setStatus('market', true);
} catch (e) { setStatus('market', false, e.message); }

// ---------- 抓取：BGeometrics（增量快取＋額度控管） ----------
let bgCalls = 0;
const BG = [
  ['mvrv', 'mvrv-zscore', ['mvrvZscore', 'mvrvZScore'], 'bgcore'],
  ['nupl', 'nupl', ['nupl'], 'bgcore'],
  ['puell', 'puell-multiple', ['puellMultiple'], 'bgcore'],
  ['funding', 'funding-rate', ['fundingRate'], 'bgcore'],
  ['oi', 'open-interest-futures', ['openInterestFutures', 'openInterest'], 'bgcore'],
  ['etf', 'etf-flow-btc', ['etfFlow', 'etfFlowBtc', 'flow'], 'bgaux'],
  ['liq', 'btc-liquidations-1d', null, 'bgaux'],
  ['sthrp', 'sth-realized-price', ['sthRealizedPrice'], 'bgaux'],
  ['profit', 'supply-profit', ['supplyProfit', 'supplyInProfit'], 'bgaux'],  // 獲利中的 BTC 數量，下面換算成佔流通量 %
  ['whale', 'coins-addr-10K-1K-BTC', ['coinsAddr10K1KBtc'], 'bgaux'],
];
const bgErr = { bgcore: [], bgaux: [] };
for (const [name, path, prefer, group] of BG) {
  await load(name);
  if (!force && meta[name]?.fetched === today && meta[name]?.ok) continue;
  if (bgCalls >= BG_BUDGET) { bgErr[group].push(`${name}：本輪額度已用完，下一輪自動補抓`); continue; }
  const last = S[name].at(-1)?.[0];
  const from = last && S[name].length > 300 ? addDays(last, -3) : addDays(today, -(WINDOW + 40));
  try {
    bgCalls++;
    const arr = rowsOf(await getJSON(`https://bitcoin-data.com/v1/${path}?startday=${from}`, 1));
    let rows;
    if (name === 'liq') {
      rows = arr.map(o => [pickDate(o), pickKey(o, /long/i), pickKey(o, /short/i)]);
      if (rows.some(r => r[1] == null || r[2] == null)) throw new Error('找不到多空清算欄位：' + JSON.stringify(arr.at(-1)).slice(0, 120));
    } else rows = arr.map(o => [pickDate(o), pickNumber(o, prefer)]).filter(r => Number.isFinite(r[1]));
    if (name === 'profit') rows = rows.map(r => [r[0], r[1] > 100 ? (r[1] / supplyAt(r[0])) * 100 : r[1]]);
    if (!rows.length) throw new Error('沒有資料');
    if (rows.some(r => !r[0])) throw new Error('找不到日期欄位：' + JSON.stringify(arr.at(-1)).slice(0, 120));
    S[name] = merge(S[name], rows);
    meta[name] = { fetched: today, ok: true, last: S[name].at(-1)[0] };
  } catch (e) {
    meta[name] = { fetched: today, ok: false, error: e.message };
    bgErr[group].push(`${name}：${e.message}`);
  }
}
for (const g of ['bgcore', 'bgaux']) setStatus(g, !bgErr[g].length, bgErr[g].join('；') || null);

let lsr = null;
try {
  const j = await getJSON('https://www.okx.com/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=BTC&period=1D');
  const d = j.data?.[0];
  if (!d) throw new Error(j.msg || '無資料');
  lsr = +(Array.isArray(d) ? d[1] : d.ratio);
  setStatus('okx', true);
} catch (e) { setStatus('okx', false, e.message); }

// 短線盤勢（期權、基差、Coinbase 溢價、即時資金費率）
let MK = { ind: {}, errs: {}, arb: null };
try {
  MK = await fetchMarket({ dvolCache: await read('data/series/dvol.json', []), czKey: process.env.COINALYZE_API_KEY || null });
  if (MK.dvolSeries?.length) await write('data/series/dvol.json', MK.dvolSeries, false);
} catch (e) { console.warn('短線數據失敗：', e.message); MK.errs.deribit = e.message; }
for (const k of ['deribit', 'coinbase', 'okxfund']) setStatus(k, !MK.errs[k], MK.errs[k] || null);

try {
  let lm = null;
  if (process.env.COINALYZE_API_KEY) {
    try { lm = await buildLiqMapMulti(process.env.COINALYZE_API_KEY, m => console.log(m)); }
    catch (e) { console.warn('多交易所清算地圖失敗，改用 OKX：', e.message); }
  }
  if (!lm) { lm = await buildLiqMap(m => console.log(m)); lm.exchanges = ['OKX']; }
  lm.daily = (S.liq || []).slice(-14).map(r => ({ date: r[0], long: Math.round(r[1]), short: Math.round(r[2]) }));  // BGeometrics 全市場每日清算
  await write('data/liqmap.json', lm);
  NAMES.okxliq = lm.method === 'coinalyze' ? `清算地圖（${lm.exchanges.join('、')}）` : 'OKX 清算地圖';
  setStatus('okxliq', !lm.notes.length || lm.buckets.length > 0, lm.notes.join('；') || null);
  console.log(`清算地圖：${lm.method}、${lm.hours} 小時、${lm.buckets.length} 個價位、上方最大 ${JSON.stringify(lm.topShort[0])}、下方最大 ${JSON.stringify(lm.topLong[0])}`);
} catch (e) { NAMES.okxliq = 'OKX 清算地圖'; setStatus('okxliq', false, e.message); console.warn('清算地圖失敗：', e.message); }
for (const k of Object.keys(S)) await save(k);
await write('data/series/_meta.json', meta);

// ---------- 對齊到每日日曆 ----------
const cal = S.price.map(r => r[0]);
const N = cal.length;
const close = S.price.map(r => r[1]);
// 向前填補（最多 maxGap 天），age = 距最後一筆真實資料天數
function align(rows, col = 1, maxGap = 7, fill = true) {
  const m = new Map(rows.map(r => [r[0], r[col]]));
  const v = new Array(N).fill(null), age = new Array(N).fill(null);
  let lastV = null, lastI = -1e9;
  for (let i = 0; i < N; i++) {
    if (m.get(cal[i]) != null) { lastV = m.get(cal[i]); lastI = i; }
    if (lastV != null && i - lastI <= maxGap && (fill || i === lastI)) { v[i] = lastV; age[i] = i - lastI; }
  }
  return { v, age };
}
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
// ---------- 模擬來源延遲：歷史上每一天只用「當天實際拿得到」的數據 ----------
// BGeometrics 免費方案與 Blockchain.com 算力有數天延遲。量出每個序列目前的延遲天數，
// 把整段歷史的日期往後挪同樣天數，回測、操作紀錄與今天的判斷就和實際上線時一致。
const LAGGED = ['mvrv', 'nupl', 'puell', 'funding', 'oi', 'etf', 'liq', 'sthrp', 'profit', 'whale', 'hash'];
const LAG = {}, SS = { ...S };
for (const k of LAGGED) {
  const last = S[k]?.at(-1)?.[0];
  if (!last) { LAG[k] = 0; continue; }
  LAG[k] = Math.max(0, Math.min(14, Math.round((Date.parse(cal[N - 1]) - Date.parse(last)) / 86400000)));
  SS[k] = LAG[k] ? S[k].map(r => [addDays(r[0], LAG[k]), ...r.slice(1)]) : S[k];
}
console.log('來源延遲（天）：' + LAGGED.map(k => `${k} ${LAG[k]}`).join('、'));
const F = {
  eth: align(S.eth, 1, 3),
  fng: align(SS.fng, 1, 3), hash: align(SS.hash, 1, 7), stable: align(SS.stable, 1, 7),
  mvrv: align(SS.mvrv, 1, 7), nupl: align(SS.nupl, 1, 7), puell: align(SS.puell, 1, 7), funding: align(SS.funding, 1, 7), oi: align(SS.oi, 1, 7),
  etf: align(SS.etf, 1, 0, false), liqL: align(SS.liq, 1, 0, false), liqS: align(SS.liq, 2, 0, false),
  sthrp: align(SS.sthrp, 1, 7), profit: align(SS.profit, 1, 7), whale: align(SS.whale, 1, 7),
};
{ const a = F.funding.v.filter(v => v != null).map(Math.abs).sort((x, y) => x - y); if (a.length && a[a.length >> 1] < 0.001) F.funding.v = F.funding.v.map(v => v == null ? null : v * 100); }
{ const a = F.profit.v.filter(v => v != null); if (a.length && Math.max(...a) <= 1) F.profit.v = F.profit.v.map(v => v == null ? null : v * 100); }
{ const a = F.profit.v.filter(v => v != null); if (a.length && Math.max(...a) > 100.5) { console.warn('獲利籌碼數值超出 0–100%，略過'); F.profit.v = F.profit.v.map(() => null); } }
const etf0 = F.etf.v.findIndex(v => v != null), liq0 = F.liqL.v.findIndex(v => v != null);
const nz = (arr, i, i0) => i0 >= 0 && i >= i0 ? (arr[i] ?? 0) : 0;

// ---------- 逐日計算指標原始值 ----------
const config = await read('config/indicators.json');
const defs = config.indicators;
const V = {}; for (const d of defs) V[d.id] = new Array(N).fill(null);
const FX = Array.from({ length: N }, () => ({}));
const weekly = [];
{ // Hash Ribbons：30 日線跌破 60 日線為投降；重新站上後 20 天內為恢復
  const h = F.hash.v, hp = [0], cnt = [0];
  for (const x of h) { hp.push(hp.at(-1) + (x ?? 0)); cnt.push(cnt.at(-1) + (x != null ? 1 : 0)); }
  const m = (i, n) => i + 1 >= n && cnt[i + 1] - cnt[i + 1 - n] === n ? (hp[i + 1] - hp[i + 1 - n]) / n : null;
  let lastCross = -1e9, prevBelow = null;
  for (let i = 0; i < N; i++) {
    const a = m(i, 30), b = m(i, 60); if (a == null || b == null) continue;
    const below = a < b;
    if (prevBelow === true && !below) lastCross = i;
    prevBelow = below;
    if (V.hashribbons) V.hashribbons[i] = below ? 'capitulation' : i - lastCross <= 20 ? 'recovery' : 'normal';
    FX[i].hr = [a, b];
  }
}
const ssrArr = new Array(N).fill(null);
for (let i = 0; i < N; i++) {
  const c = close[i];
  if (isSunday(cal[i])) weekly.push(c);
  const wk = isSunday(cal[i]) ? weekly : [...weekly.slice(-300), c];
  const set = (id, v, fields) => { if (V[id] && v != null && Number.isFinite(v)) { V[id][i] = v; if (fields) FX[i][id] = fields; } };
  set('rsi_w', rsiW(wk.slice(-300)));
  if (wk.length >= 200) { const w = wk.slice(-200).reduce((s, x) => s + x, 0) / 200; set('wma200', c / w); FX[i].w200 = w; }
  if (sma(i, 350)) set('pi_top', sma(i, 111) / (2 * sma(i, 350)));
  if (sma(i, 471) && ema150[i]) set('pi_bottom', ema150[i] / (0.745 * sma(i, 471)));
  if (sma(i, 200)) set('mayer', c / sma(i, 200));
  set('mvrv', F.mvrv.v[i]); set('nupl', F.nupl.v[i]); set('puell', F.puell.v[i]);
  if (F.fng.v[i] != null) {
    const w = F.fng.v.slice(Math.max(0, i - 13), i + 1).filter(x => x != null);
    set('fng', F.fng.v[i], w.length >= 14 ? { min14: Math.min(...w) } : {});
  }
  if (F.stable.v[i]) ssrArr[i] = c * supplyAt(cal[i]) / F.stable.v[i];
  if (F.stable.v[i] && i >= 30 && F.stable.v[i - 30]) set('stable30', (F.stable.v[i] / F.stable.v[i - 30] - 1) * 100);
  if (F.funding.v[i] != null) {
    const f = { max3: Math.max(...F.funding.v.slice(Math.max(0, i - 2), i + 1).map(x => x ?? -Infinity)) };
    const oi = F.oi.v.slice(Math.max(0, i - 364), i + 1).filter(x => x != null);
    if (oi.length >= 30 && F.oi.v[i] != null) {
      const cur = F.oi.v[i], peak = Math.max(...oi), low14 = Math.min(...oi.slice(-14)), wk1 = F.oi.v[i - 7];
      const dd = (1 - cur / peak) * 100, rebound = cur > low14 * 1.03 && wk1 != null && cur > wk1;
      f.oiDD = rebound ? r4(dd, 1) : 0; f.oi = r4(cur / 1e9, 2); f.oiDrop = r4(dd, 1); FX[i].oi = { cur, dd, rebound };
    }
    set('funding', F.funding.v[i], f);
  }
  if (etf0 >= 0 && i >= etf0 + 6) {
    const roll = j => { let s = 0; for (let k = j - 6; k <= j; k++) s += nz(F.etf.v, k, etf0); return s; };
    const hist = []; for (let j = Math.max(etf0 + 6, i - 179); j <= i; j++) hist.push(roll(j));
    if (hist.length >= 40) set('etf_flow', roll(i), { pct7: r4(pctRank(hist, roll(i)), 1) });
  }
  if (liq0 >= 0 && i >= liq0 + 2) {
    const s3 = (arr, j) => nz(arr, j, liq0) + nz(arr, j - 1, liq0) + nz(arr, j - 2, liq0);
    const hl = [], hs = []; for (let j = Math.max(liq0 + 2, i - 179); j <= i; j++) { hl.push(s3(F.liqL.v, j)); hs.push(s3(F.liqS.v, j)); }
    if (hl.length >= 40) set('liq', nz(F.liqL.v, i, liq0) + nz(F.liqS.v, i, liq0), { longPct: r4(pctRank(hl, hl.at(-1)), 1), shortPct: r4(pctRank(hs, hs.at(-1)), 1) });
  }
  if (F.sthrp.v[i]) set('sth_mvrv', c / F.sthrp.v[i]);
  if (F.eth.v[i]) set('ethbtc', F.eth.v[i] / c);
  set('profit_supply', F.profit.v[i]);
  if (F.whale.v[i] != null && i >= 30 && F.whale.v[i - 30]) set('whale', (F.whale.v[i] / F.whale.v[i - 30] - 1) * 100);
}
// ETF 與清算是「每日事件」：最後一筆真實資料之後的日子視為未知，沿用最後一天的計算結果
for (const [id, rows] of [['etf_flow', SS.etf], ['liq', SS.liq]]) {
  const last = rows.at(-1)?.[0]; if (!last || !V[id]) continue;
  const li = cal.indexOf(last); if (li < 0) continue;
  for (let i = li + 1; i < N && i - li <= 14; i++) { V[id][i] = V[id][li]; FX[i][id] = FX[li][id]; }
}
for (let i = 0; i < N; i++) if (ssrArr[i] != null && V.ssr) {
  V.ssr[i] = ssrArr[i];
  const w = []; for (let k = Math.max(0, i - WINDOW + 1); k <= i; k++) if (ssrArr[k] != null) w.push(ssrArr[k]);
  if (w.length >= 365) FX[i].ssr = { pct: r4(pctRank(w, ssrArr[i]), 1) };
}
// 相對位置 p：近 4 年百分位，只用當天以前的資料
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
function indicatorsAt(i) {
  const out = {};
  for (const d of defs) {
    const v = V[d.id][i];
    if (v == null) continue;
    const fields = { ...(FX[i][d.id] || {}) };
    if (P[d.id]?.[i] != null) fields.p = P[d.id][i];
    out[d.id] = { value: typeof v === 'number' ? r4(v, 5) : v, fields };
  }
  return out;
}
function cycleIndex(i) {
  const ps = defs.filter(d => d.index && P[d.id]?.[i] != null).map(d => P[d.id][i]);
  return ps.length >= 5 ? r4(ps.reduce((a, b) => a + b, 0) / ps.length, 1) : null;
}

// ---------- 回測：每一天都只用當時已知的資料計分 ----------
let bt0 = V.mvrv ? V.mvrv.findIndex(v => v != null) : -1;
if (bt0 < 0) bt0 = Math.max(0, N - WINDOW);
const backtest = [];
for (let i = bt0; i < N; i++) {
  const s = scoreAll(config, indicatorsAt(i));
  const ma = sma(i, config.trend?.ma || 350);
  backtest.push([cal[i], Math.round(close[i]), s.cbs.score, s.cts.score, s.cbs.confirm.pct, s.cts.confirm.pct, cycleIndex(i), ma ? Math.round(ma) : null, P.ethbtc?.[i] ?? null]);
}
await write('data/backtest.json', { fields: ['date', 'price', 'cbs', 'cts', 'cbsConfirm', 'ctsConfirm', 'idx', 'ma50w', 'ethPct'], rows: backtest }, false);

// ---------- 今天的完整資料與說明文字 ----------
const L = N - 1;
const latest = await read('data/latest.json', {});
const ind = indicatorsAt(L);
const fx = FX[L];
const detail = {
  rsi_w: `週收盤 ${usd(weekly.at(-1) ?? close[L])}`,
  wma200: fx.w200 ? `BTC ${usd(close[L])} / 200WMA ${usd(fx.w200)}` : '',
  pi_top: sma(L, 350) ? `111DMA ${usd(sma(L, 111))} / 350DMA×2 ${usd(2 * sma(L, 350))}` : '',
  pi_bottom: sma(L, 471) ? `150EMA ${usd(ema150[L])} / 471DMA×0.745 ${usd(0.745 * sma(L, 471))}` : '',
  mayer: sma(L, 200) ? `200DMA ${usd(sma(L, 200))}` : '',
  hashribbons: fx.hr ? `SMA30 ${fx.hr[0].toFixed(0)} EH/s / SMA60 ${fx.hr[1].toFixed(0)} EH/s` : '',
  fng: [S.fng.at(-1)?.[2], fx.fng?.min14 != null ? `近 14 天最低 ${fx.fng.min14}` : ''].filter(Boolean).join('・'),
  funding: fx.oi ? `OI ${fx.oi.cur > 1e6 ? fmtB(fx.oi.cur) : fx.oi.cur.toFixed(2) + 'B'}・較一年高點 -${fx.oi.dd.toFixed(0)}%${fx.oi.rebound ? '・回升中' : ''}` : '',
  sth_mvrv: F.sthrp.v[L] ? `短期持有者成本 ${usd(F.sthrp.v[L])}` : '',
  profit_supply: ind.profit_supply ? `被套籌碼約 ${(100 - ind.profit_supply.value).toFixed(1)}%` : '',
  stable30: F.stable.v[L] && F.stable.v[L - 30] ? `${fmtB(F.stable.v[L - 30])} → ${fmtB(F.stable.v[L])}` : '',
};
if (ind.ssr) {
  const p = [];
  if (ind.ssr.fields.pct != null) p.push(`4 年百分位 ${ind.ssr.fields.pct}%`);
  if (now.stableTotal) p.push(`穩定幣 ${fmtB(now.stableTotal)}`);
  if (now.totalCrypto && now.stableBy?.USDT) { ind.ssr.fields.usdtd = r4(now.stableBy.USDT / now.totalCrypto * 100, 2); p.push(`USDT.D ${ind.ssr.fields.usdtd}%`); }
  detail.ssr = p.join('・');
}
if (ind.etf_flow) {
  const f = S.etf.map(r => r[1]); const med = [...f].map(Math.abs).sort((a, b) => a - b)[f.length >> 1] || 0;
  const fmt = v => med > 1e5 ? `${v < 0 ? '-' : '+'}$${(Math.abs(v) / 1e6).toFixed(0)}M` : `${v < 0 ? '-' : '+'}${Math.round(Math.abs(v)).toLocaleString('en-US')} BTC`;
  let st = 0; for (let k = f.length - 1; k >= 0 && f[k] < 0; k--) st++;
  ind.etf_flow.display = fmt(ind.etf_flow.value);
  detail.etf_flow = `近 7 日 ${fmt(ind.etf_flow.value)}・最近一日 ${fmt(f.at(-1))}${st > 1 ? `・連續流出 ${st} 天` : ''}・半年百分位 ${ind.etf_flow.fields.pct7}%`;
}
if (ind.liq) {
  const m = v => v > 1e5 ? '$' + (v / 1e6).toFixed(0) + 'M' : Math.round(v).toLocaleString('en-US') + ' BTC';
  const lr = S.liq.at(-1);
  ind.liq.display = m(ind.liq.value);
  detail.liq = `最近一日多單 ${m(lr[1])}・空單 ${m(lr[2])}・近 3 日多單百分位 ${ind.liq.fields.longPct}%`;
}
if (ind.whale) detail.whale = `持倉 ${Math.round(F.whale.v[L]).toLocaleString('en-US')} BTC（30 日 ${ind.whale.value >= 0 ? '+' : ''}${Math.round(F.whale.v[L] - F.whale.v[L - 30]).toLocaleString('en-US')}）`;
if (now.btcDom != null) ind.btcdom = { value: r4(now.btcDom, 2), fields: {} };
for (const [k, v] of Object.entries(MK.ind)) { ind[k] = { value: v.value, fields: v.fields || {} }; detail[k] = v.detail; }
if (lsr != null) { ind.lsr = { value: r4(lsr, 3), fields: {} }; detail.lsr = `多頭帳戶約 ${(lsr / (1 + lsr) * 100).toFixed(0)}%`; }

// 指標對應的來源與資料新鮮度
const srcOf = { mvrv: 'bgcore', nupl: 'bgcore', puell: 'bgcore', funding: 'bgcore', etf_flow: 'bgaux', liq: 'bgaux', sth_mvrv: 'bgaux', profit_supply: 'bgaux', whale: 'bgaux', fng: 'fng', hashribbons: 'hash', ssr: 'stable', stable30: 'stable', btcdom: 'market', lsr: 'okx', ethbtc: 'eth', dvol: 'deribit', skew: 'deribit', pcr: 'deribit', basis: 'deribit', fundapr: 'okxfund', cbprem: 'coinbase' };
const lagOf = { mvrv: 'mvrv', nupl: 'nupl', puell: 'puell', hashribbons: 'hash', funding: 'funding', sth_mvrv: 'sthrp', profit_supply: 'profit', whale: 'whale', etf_flow: 'etf', liq: 'liq' };
const ageOf = { mvrv: F.mvrv, nupl: F.nupl, puell: F.puell, fng: F.fng, hashribbons: F.hash, funding: F.funding, sth_mvrv: F.sthrp, profit_supply: F.profit, whale: F.whale, stable30: F.stable, ssr: F.stable };
const lastReal = { etf_flow: S.etf.at(-1)?.[0], liq: S.liq.at(-1)?.[0] };
const maxAge = { etf_flow: 10, liq: 10, fng: 3 };
latest.indicators = {};
for (const d of defs) {
  const x = ind[d.id], src = srcOf[d.id] || 'price';
  let age = (ageOf[d.id]?.age?.[L] ?? 0) + (LAG[lagOf[d.id]] || 0);
  if (lastReal[d.id]) age = Math.round((Date.parse(cal[L]) - Date.parse(lastReal[d.id])) / 86400000);
  const ok = !!x && age <= (maxAge[d.id] ?? 14);
  const asOf = addDays(cal[L], -age);
  latest.indicators[d.id] = x ? { ...x, detail: detail[d.id] || '', ok, date: today, asOf, fetchedAt: nowISO, source: src, age } : { value: null, ok: false, source: src };
}
latest.sources = status;
latest.date = today; latest.updatedAt = nowISO; latest.btcPrice = Math.round(close[L]); latest.legacy = false;
latest.index = cycleIndex(L);
latest.indexZone = indexZone(config, latest.index)?.name ?? null;
latest.bgCalls = bgCalls;
latest.lags = LAG;
latest.arb = MK.arb;
latest.ethPrice = now.ethPrice ?? latest.ethPrice ?? null;

if (fetchOnly) {
  latest.pending = true;
  await write('data/latest.json', latest);
  console.log(`已更新數據（尚未寫入快照）・BGeometrics 用量 ${bgCalls}・回測 ${backtest.length} 天`);
  process.exit(0);
}
latest.pending = false; latest.snapshotAt = nowISO;
const s = scoreAll(config, latest.indicators);
const history = await read('data/history.json', []);
const entry = {
  date: today, btcPrice: latest.btcPrice, cbs: s.cbs.score, cts: s.cts.score,
  cbsConfirm: s.cbs.confirm.pct, ctsConfirm: s.cts.confirm.pct, idx: latest.index,
  cbsLevel: s.cbs.level.name, ctsLevel: s.cts.level.name, action: s.cbs.level.action,
  values: { ...Object.fromEntries(defs.map(d => [d.id, latest.indicators[d.id]?.value ?? null])), oi: latest.indicators.funding?.fields?.oi ?? null },
  pct: Object.fromEntries(defs.filter(d => latest.indicators[d.id]?.fields?.p != null).map(d => [d.id, latest.indicators[d.id].fields.p])),
  items: Object.fromEntries(defs.map(d => [d.id, [s.cbs.items[d.id]?.pts ?? null, s.cts.items[d.id]?.pts ?? null]])),
  indexZone: latest.indexZone,
};
{ // 當天的操作建議（與儀表板同一套邏輯）
  const rows = backtest.map(r => ({ date: r[0], price: r[1], cbs: r[2], cts: r[3], idx: r[6], ma50w: r[7], ethPct: r[8] }));
  rows[rows.length - 1] = { ...rows[rows.length - 1], date: today, cbs: s.cbs.score, cts: s.cts.score, idx: latest.index };
  const d = decide(config, s, rows, latest.index);
  entry.decision = { tone: d.tone, title: d.title, action: d.action, notes: d.notes, target: d.target, last: d.position?.last ? { date: d.position.last.date, label: d.position.last.label, target: d.position.last.target, type: d.position.last.type } : null };
  latest.ledger = d.ledger;
}
const hi = history.findIndex(h => h.date === today);
if (hi >= 0) history[hi] = entry; else history.push(entry);
history.sort((a, b) => a.date.localeCompare(b.date));
await write('data/latest.json', latest);
await write('data/history.json', history);
console.log(`快照 ${today}：CBS ${s.cbs.score}/${s.cbs.max} ${s.cbs.level.name}（確認 ${s.cbs.confirm.pct ?? '—'}%）・CTS ${s.cts.score}/${s.cts.max} ${s.cts.level.name}・週期指數 ${latest.index ?? '—'}・BGeometrics 用量 ${bgCalls}・回測 ${backtest.length} 天`);
