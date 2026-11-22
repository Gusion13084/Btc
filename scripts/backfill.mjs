// 歷史數據回補：把各免費來源「能拿到的最長歷史」存進 data/series（只增不刪），供未來新指標與研究調用。
// 每天執行，但每個來源只有在本地序列起點晚於 TARGET 時才會做完整回補；回補完成後只是很便宜的檢查。
// 這支程式只寫入序列檔，不影響網站任何指標或評分的計算。
// - 總經：Fed 資產負債表（FRED，需 FRED_API_KEY）、TGA、逆回購、10 年期實質利率、美元指數估算、那斯達克
// - Coin Metrics 社群版：BTC 全部免費日線指標（2010 起）→ data/series/cm_btc_all.json
import { readFile, writeFile } from 'node:fs/promises';

const ROOT = new URL('../', import.meta.url);
const TARGET = '2015-01-01';
const UA = { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36', Accept: 'application/json, text/csv, */*' };
const today = new Date().toISOString().slice(0, 10);
const num = s => { const v = Number(String(s).replace(/[,$\s]/g, '')); return Number.isFinite(v) ? v : null; };
const read = async (p, fb) => { try { return JSON.parse(await readFile(new URL(p, ROOT), 'utf8')); } catch { return fb; } };
const write = (p, v) => writeFile(new URL(p, ROOT), JSON.stringify(v) + '\n');
async function get(url, type = 'json', headers = {}) {
  const r = await fetch(url, { headers: { ...UA, ...headers }, signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`${new URL(url).host} HTTP ${r.status}`);
  return type === 'json' ? r.json() : r.text();
}
function merge(oldRows, newRows) {
  const m = new Map(oldRows.map(r => [r[0], r]));
  for (const r of newRows) if (r[0] && !m.has(r[0])) m.set(r[0], r); // 回補只補缺的日子，不覆蓋既有數值
  return [...m.values()].sort((a, b) => a[0].localeCompare(b[0]));
}
const log = [];
async function backfill(name, fetcher, { prec = 8 } = {}) {
  const path = `data/series/m_${name}.json`, cur = await read(path, []);
  if (cur.length && cur[0][0] <= TARGET) return;
  try {
    const rows = (await fetcher()).filter(r => r[0] >= TARGET && r[1] != null).map(([d, v]) => [d, +(+v).toPrecision(prec)]);
    if (!rows.length) throw new Error('沒有資料');
    const out = merge(cur, rows); await write(path, out);
    log.push(`${name}：${cur[0]?.[0] ?? '無'} → ${out[0][0]}（+${out.length - cur.length} 天）`);
  } catch (e) { log.push(`${name}：回補失敗 ${e.message}`); }
}

// Fed 資產負債表（週，十億美元）
await backfill('walcl', async () => {
  const key = process.env.FRED_API_KEY; if (!key) throw new Error('未設定 FRED 金鑰（排程中會自動回補）');
  const j = await get(`https://api.stlouisfed.org/fred/series/observations?series_id=WALCL&file_type=json&observation_start=${TARGET}&api_key=${key}`);
  return j.observations.map(o => [o.date, num(o.value) == null ? null : num(o.value) / 1e3]);
});
// TGA（日，十億美元）：2021-10 前帳戶名稱為 Federal Reserve Account
await backfill('tga', async () => {
  const rows = [];
  for (let p = 1; p <= 40; p++) {
    const j = await get(`https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/dts/operating_cash_balance?filter=record_date:gte:${TARGET}&sort=record_date&page[size]=10000&page[number]=${p}&fields=record_date,account_type,close_today_bal,open_today_bal`);
    rows.push(...j.data); if (j.data.length < 10000) break;
  }
  const m = new Map();
  for (const x of rows) {
    const t = x.account_type || '';
    const isTga = (/closing balance/i.test(t) && /treasury general account|tga/i.test(t)) || /^federal reserve account$/i.test(t);
    if (!isTga) continue;
    const v = num(x.close_today_bal) ?? num(x.open_today_bal); if (v != null) m.set(x.record_date, v / 1e3);
  }
  return [...m];
});
// 逆回購（日，十億美元）
await backfill('rrp', async () => {
  const j = await get(`https://markets.newyorkfed.org/api/rp/reverserepo/propositions/search.json?startDate=${TARGET}&endDate=${today}`);
  const m = new Map(); for (const o of j.repo?.operations || []) m.set(o.operationDate, (m.get(o.operationDate) || 0) + (o.totalAmtAccepted || 0) / 1e9);
  return [...m];
});
// 10 年期實質利率（日，%）
await backfill('real10', async () => {
  const rows = [];
  for (let yr = +TARGET.slice(0, 4); yr <= +today.slice(0, 4); yr++) {
    const t = await get(`https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${yr}/all?type=daily_treasury_real_yield_curve&field_tdr_date_value=${yr}&page&_format=csv`, 'text');
    const lines = t.trim().split(/\r?\n/), head = lines[0].split(',').map(s => s.replace(/"/g, '')), ci = head.indexOf('10 YR');
    for (const l of lines.slice(1)) { const c = l.split(','); const [m, d, yy] = c[0].split('/'); const v = num(c[ci]); if (v != null) rows.push([`${yy}-${m}-${d}`, v]); }
  }
  return rows;
}, { prec: 6 });
// 美元指數估算（與 macro.mjs 相同的 DXY 權重）
await backfill('dxy', async () => {
  const j = await get(`https://api.frankfurter.app/${TARGET}..${today}?from=USD&to=EUR,JPY,GBP,CAD,SEK,CHF`);
  return Object.entries(j.rates).map(([d, x]) => [d, 50.14348112 * Math.pow(1 / x.EUR, -0.576) * Math.pow(x.JPY, 0.136) * Math.pow(1 / x.GBP, -0.119) * Math.pow(x.CAD, 0.091) * Math.pow(x.SEK, 0.042) * Math.pow(x.CHF, 0.036)]);
});
// 那斯達克綜合指數（日收盤）
await backfill('ndq', async () => {
  const j = await get(`https://api.nasdaq.com/api/quote/COMP/historical?assetclass=index&fromdate=${TARGET}&todate=${today}&limit=9999`, 'json', { Accept: 'application/json', Origin: 'https://www.nasdaq.com', Referer: 'https://www.nasdaq.com/' });
  return (j.data?.tradesTable?.rows || []).map(x => { const [m, d, y] = x.date.split('/'); return [`${y}-${m}-${d}`, num(x.close)]; });
});

// Coin Metrics 社群版：BTC 全部免費日線指標。第一次抓 2010 起完整歷史，之後每天只補最近 60 天。
{
  const path = 'data/series/cm_btc_all.json';
  const skip = new Set(['AssetCompletionTime', 'AssetEODCompletionTime', 'ReferenceRate', 'ReferenceRateUSD']);
  try {
    const cat = await get('https://community-api.coinmetrics.io/v4/catalog-v2/asset-metrics?assets=btc&page_size=1000');
    const metrics = cat.data[0].metrics.filter(x => x.frequencies.some(f => f.frequency === '1d') && !skip.has(x.metric)).map(x => x.metric).sort();
    const cur = await read(path, { fields: [], rows: [] });
    const full = !cur.rows.length || cur.fields.join() !== ['date', ...metrics].join();
    const start = full ? '2010-07-18' : cur.rows.at(-60)?.[0] || '2010-07-18';
    const rows = [], byDay = new Map();
    for (let i = 0; i < metrics.length; i += 10) { // 一次最多 10 個指標，避免網址過長
      const ms = metrics.slice(i, i + 10);
      let url = `https://community-api.coinmetrics.io/v4/timeseries/asset-metrics?assets=btc&metrics=${ms.join(',')}&frequency=1d&start_time=${start}&page_size=10000`;
      for (let k = 0; k < 10 && url; k++) {
        const j = await get(url);
        for (const x of j.data || []) { const d = x.time.slice(0, 10); let r = byDay.get(d); if (!r) { rows.push(r = { d, v: {} }); byDay.set(d, r); } for (const m of ms) if (x[m] != null) r.v[m] = num(x[m]); }
        url = j.next_page_url || null; await new Promise(r => setTimeout(r, 300));
      }
    }
    const fields = ['date', ...metrics];
    const fresh = rows.map(r => [r.d, ...metrics.map(m => r.v[m] ?? null)]);
    const m = new Map((full ? [] : cur.rows).map(r => [r[0], r])); for (const r of fresh) m.set(r[0], r); // 最近 60 天允許來源修正
    const out = [...m.values()].sort((a, b) => a[0].localeCompare(b[0]));
    await write(path, { fields, source: 'Coin Metrics Community API', rows: out });
    log.push(`Coin Metrics 全指標：${metrics.length} 項、${out[0][0]} 起共 ${out.length} 天${full ? '（完整回補）' : ''}`);
  } catch (e) { log.push(`Coin Metrics 全指標：失敗 ${e.message}`); }
}
console.log('歷史回補：' + (log.join('；') || '全部已完整，無需回補'));
