// 總體流動性與供給端數據：全部免費來源，每天各呼叫一次
// - Fed 資產負債表：FRED（需要免費金鑰 FRED_API_KEY，沒有就略過淨流動性）
// - 財政部帳戶 TGA：U.S. Treasury Fiscal Data
// - 逆回購 RRP：紐約聯準銀行
// - 10 年期實質利率：美國財政部每日實質殖利率曲線
// - 美元指數：以歐洲央行匯率（Frankfurter）依 ICE DXY 權重估算
// - 那斯達克綜合指數：Nasdaq 官方 API
// - 交易所存量與流量：Coin Metrics 社群版
// - 企業、ETF、國家持倉：bitbo（BitcoinTreasuries）每日快照，系統自行累積歷史
const UA = { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36', Accept: 'application/json, text/csv, text/html, */*' };
const D = 864e5;
const iso = t => new Date(t).toISOString().slice(0, 10);
const addDays = (d, n) => iso(Date.parse(d + 'T00:00:00Z') + n * D);
const num = s => { const v = Number(String(s).replace(/[,$\s]/g, '')); return Number.isFinite(v) ? v : null; };
async function get(url, type = 'json', headers = {}) {
  const r = await fetch(url, { headers: { ...UA, ...headers }, signal: AbortSignal.timeout(45000) });
  if (!r.ok) throw new Error(`${new URL(url).host} HTTP ${r.status}`);
  return type === 'json' ? r.json() : r.text();
}
// 序列 [[date, v]]：取某天（含）以前最近的值
const valueAt = (ser, d) => { let v = null; for (const [x, y] of ser) { if (x > d) break; v = y; } return v; };
const pctRank = (arr, x) => arr.length ? (arr.filter(v => v < x).length + 0.5 * arr.filter(v => v === x).length) / arr.length * 100 : null;
const r = (v, n = 2) => v == null || !Number.isFinite(v) ? null : +v.toFixed(n);

export async function fetchMacro({ today, priceSeries = [], treasury = [], fredKey = null, log = console.log } = {}) {
  const ind = {}, errs = {}, out = {};
  const from = addDays(today, -800);
  const S = {};

  await Promise.all([
    // ---- Fed 資產負債表（週）----
    (async () => {
      if (!fredKey) throw new Error('未設定 FRED 金鑰');
      const j = await get(`https://api.stlouisfed.org/fred/series/observations?series_id=WALCL&file_type=json&observation_start=${from}&api_key=${fredKey}`);
      S.walcl = j.observations.map(o => [o.date, num(o.value)]).filter(x => x[1] != null).map(([d, v]) => [d, v / 1e3]); // 百萬 → 十億
    })().catch(e => { errs.fred = e.message; }),
    // ---- TGA（日）----
    (async () => {
      const rows = [];
      for (let p = 1; p <= 3; p++) {
        const j = await get(`https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/dts/operating_cash_balance?filter=record_date:gte:${from}&sort=-record_date&page[size]=1000&page[number]=${p}`);
        rows.push(...j.data); if (j.data.length < 1000) break;
      }
      const m = new Map();
      for (const x of rows) if (/closing balance/i.test(x.account_type) && /treasury general account|tga/i.test(x.account_type)) {
        const v = num(x.close_today_bal) ?? num(x.open_today_bal); if (v != null) m.set(x.record_date, v / 1e3); // 百萬 → 十億
      }
      S.tga = [...m].sort((a, b) => a[0] < b[0] ? -1 : 1);
      if (S.tga.length < 30) throw new Error('TGA 資料不足');
    })().catch(e => { errs.tga = e.message; }),
    // ---- 逆回購（日）----
    (async () => {
      const j = await get(`https://markets.newyorkfed.org/api/rp/reverserepo/propositions/search.json?startDate=${from}`);
      const m = new Map(); for (const o of j.repo?.operations || []) m.set(o.operationDate, (m.get(o.operationDate) || 0) + (o.totalAmtAccepted || 0) / 1e9);
      S.rrp = [...m].sort((a, b) => a[0] < b[0] ? -1 : 1);
    })().catch(e => { errs.rrp = e.message; }),
    // ---- 10 年期實質利率（日）----
    (async () => {
      const y = +today.slice(0, 4), rows = [];
      for (const yr of [y - 1, y]) {
        const t = await get(`https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${yr}/all?type=daily_treasury_real_yield_curve&field_tdr_date_value=${yr}&page&_format=csv`, 'text');
        const lines = t.trim().split(/\r?\n/), head = lines[0].split(',').map(s => s.replace(/"/g, ''));
        const ci = head.indexOf('10 YR');
        for (const l of lines.slice(1)) { const c = l.split(','); const [m, d, yy] = c[0].split('/'); const v = num(c[ci]); if (v != null) rows.push([`${yy}-${m}-${d}`, v]); }
      }
      S.real10 = rows.sort((a, b) => a[0] < b[0] ? -1 : 1);
      if (S.real10.length < 30) throw new Error('實質利率資料不足');
    })().catch(e => { errs.treasury = e.message; }),
    // ---- 美元指數估算（日）：DXY = 50.14348112 × EURUSD^-0.576 × USDJPY^0.136 × GBPUSD^-0.119 × USDCAD^0.091 × USDSEK^0.042 × USDCHF^0.036 ----
    (async () => {
      const j = await get(`https://api.frankfurter.app/${from}..?from=USD&to=EUR,JPY,GBP,CAD,SEK,CHF`);
      S.dxy = Object.entries(j.rates).map(([d, x]) => [d, 50.14348112 * Math.pow(1 / x.EUR, -0.576) * Math.pow(x.JPY, 0.136) * Math.pow(1 / x.GBP, -0.119) * Math.pow(x.CAD, 0.091) * Math.pow(x.SEK, 0.042) * Math.pow(x.CHF, 0.036)]).sort((a, b) => a[0] < b[0] ? -1 : 1);
    })().catch(e => { errs.fx = e.message; }),
    // ---- 那斯達克綜合指數（日）----
    (async () => {
      const j = await get(`https://api.nasdaq.com/api/quote/COMP/historical?assetclass=index&fromdate=${addDays(today, -400)}&todate=${today}&limit=400`, 'json', { Accept: 'application/json', Origin: 'https://www.nasdaq.com', Referer: 'https://www.nasdaq.com/' });
      const rows = j.data?.tradesTable?.rows || [];
      S.ndq = rows.map(x => { const [m, d, y] = x.date.split('/'); return [`${y}-${m}-${d}`, num(x.close)]; }).filter(x => x[1] != null).sort((a, b) => a[0] < b[0] ? -1 : 1);
      if (S.ndq.length < 60) throw new Error('那斯達克資料不足');
    })().catch(e => { errs.nasdaq = e.message; }),
    // ---- 交易所存量與流量（日）----
    (async () => {
      const rows = [];
      let url = `https://community-api.coinmetrics.io/v4/timeseries/asset-metrics?assets=btc&metrics=SplyExNtv,FlowInExNtv,FlowOutExNtv&frequency=1d&start_time=2018-01-01&page_size=10000`;
      for (let k = 0; k < 3 && url; k++) { const j = await get(url); rows.push(...j.data); url = j.next_page_url || null; }
      S.exSply = rows.map(x => [x.time.slice(0, 10), num(x.SplyExNtv)]).filter(x => x[1] != null);
      S.exNet = rows.map(x => [x.time.slice(0, 10), (num(x.FlowInExNtv) ?? 0) - (num(x.FlowOutExNtv) ?? 0)]).filter((x, i) => rows[i].FlowInExNtv != null);
      if (S.exSply.length < 400) throw new Error('交易所資料不足');
    })().catch(e => { errs.coinmetrics = e.message; }),
    // ---- 企業、ETF、國家持倉快照 ----
    (async () => {
      const h = await get('https://bitbo.io/treasuries/', 'text');
      const s = h.replace(/<[^>]+>/g, '|').replace(/\s+/g, ' ').replace(/(\| ?)+/g, '|');
      const i = s.indexOf('Totals by Category'); if (i < 0) throw new Error('持倉表格式改變');
      const seg = s.slice(i, i + 1200);
      const grab = name => { const m = seg.match(new RegExp(`\\|${name}\\|([\\d,]+)`)); return m ? num(m[1]) : null; };
      const snap = { etf: grab('ETFs'), country: grab('Countries'), public: grab('Public Companies'), private: grab('Private Companies'), miner: grab('BTC Mining Companies'), defi: grab('Defi') };
      const st = s.match(/Strategy \(MicroStrategy\)\|([\d,]+)/); snap.strategy = st ? num(st[1]) : null;
      if (!snap.etf || !snap.public || !snap.country) throw new Error('持倉數字解析失敗');
      out.treasury = [...treasury.filter(x => x[0] !== today), [today, snap]].sort((a, b) => a[0] < b[0] ? -1 : 1);
    })().catch(e => { errs.bitbo = e.message; }),
  ]);

  const lastOf = ser => ser?.length ? ser.at(-1) : null;
  const chg = (ser, days, pct = true) => { const L = lastOf(ser); if (!L) return null; const p = valueAt(ser, addDays(L[0], -days)); return p == null ? null : pct ? (L[1] / p - 1) * 100 : L[1] - p; };

  // 美國淨流動性 = Fed 資產負債表 − TGA − RRP（十億美元）
  if (S.walcl?.length && S.tga?.length) {
    const days = S.tga.map(x => x[0]).filter(d => d >= S.walcl[0][0]);
    S.netliq = days.map(d => [d, valueAt(S.walcl, d) - valueAt(S.tga, d) - (S.rrp?.length ? (valueAt(S.rrp, d) ?? 0) : 0)]);
    const L = lastOf(S.netliq), c4 = chg(S.netliq, 28), c13 = chg(S.netliq, 91);
    ind.netliq = { value: r(L[1] / 1e3, 3), fields: { chg4w: r(c4, 2), chg13w: r(c13, 2) }, asOf: L[0],
      detail: `Fed 資產 ${(valueAt(S.walcl, L[0]) / 1e3).toFixed(2)} 兆 − 財政部帳戶 ${(valueAt(S.tga, L[0]) * 10).toLocaleString('en-US', { maximumFractionDigits: 0 })} 億 − 逆回購 ${((valueAt(S.rrp || [], L[0]) ?? 0) * 10).toFixed(0)} 億（美元）・4 週 ${c4 >= 0 ? '+' : ''}${c4?.toFixed(2)}%・13 週 ${c13 >= 0 ? '+' : ''}${c13?.toFixed(2)}%` };
  }
  if (S.tga?.length) {
    const L = lastOf(S.tga), c = chg(S.tga, 28, false);
    ind.tga = { value: r(L[1] * 10, 0), fields: { chg4w: r(c * 10, 0) }, asOf: L[0], detail: `財政部帳戶 ${(L[1] * 10).toLocaleString('en-US', { maximumFractionDigits: 0 })} 億美元・4 週 ${c >= 0 ? '+' : ''}${(c * 10).toLocaleString('en-US', { maximumFractionDigits: 0 })} 億${S.rrp?.length ? `・逆回購 ${(lastOf(S.rrp)[1] * 10).toFixed(0)} 億` : ''}（帳戶增加會抽走市場資金）` };
  }
  if (S.real10?.length) {
    const L = lastOf(S.real10), c = chg(S.real10, 30, false);
    ind.realrate = { value: L[1], fields: { chg30: r(c * 100, 0) }, asOf: L[0], detail: `10 年期抗通膨公債殖利率 ${L[1].toFixed(2)}%・30 天 ${c >= 0 ? '+' : ''}${(c * 100).toFixed(0)} 基點` };
  }
  if (S.dxy?.length) {
    const L = lastOf(S.dxy), c = chg(S.dxy, 30);
    ind.dxy = { value: r(L[1], 2), fields: { chg30: r(c, 2) }, asOf: L[0], detail: `依歐洲央行匯率估算・30 天 ${c >= 0 ? '+' : ''}${c?.toFixed(2)}%` };
  }
  if (S.ndq?.length) {
    const L = lastOf(S.ndq), c = chg(S.ndq, 30);
    // BTC 與那斯達克 60 個交易日報酬相關係數
    const pm = new Map(priceSeries); const rets = [];
    for (let i = 1; i < S.ndq.length; i++) { const [d0, a0] = S.ndq[i - 1], [d1, a1] = S.ndq[i]; const b0 = pm.get(d0), b1 = pm.get(d1); if (b0 && b1) rets.push([Math.log(a1 / a0), Math.log(b1 / b0)]); }
    const w = rets.slice(-60); let corr = null;
    if (w.length >= 40) { const mx = w.reduce((s, x) => s + x[0], 0) / w.length, my = w.reduce((s, x) => s + x[1], 0) / w.length; let sxy = 0, sx = 0, sy = 0; for (const [x, y] of w) { sxy += (x - mx) * (y - my); sx += (x - mx) ** 2; sy += (y - my) ** 2; } corr = sxy / Math.sqrt(sx * sy); }
    ind.nasdaq = { value: r(c, 2), fields: { close: L[1], corr60: r(corr, 2) }, asOf: L[0], detail: `那斯達克 ${L[1].toLocaleString('en-US')}・30 天 ${c >= 0 ? '+' : ''}${c?.toFixed(1)}%${corr != null ? `・與 BTC 60 日相關係數 ${corr.toFixed(2)}` : ''}` };
  }
  if (S.exSply?.length) {
    const L = lastOf(S.exSply), c = chg(S.exSply, 30);
    const h = S.exSply.filter(x => x[0] >= addDays(L[0], -1460)).map(x => x[1]);
    ind.ex_reserve = { value: r(L[1] / 1e4, 1), fields: { chg30: r(c, 2), p: r(pctRank(h, L[1]), 1) }, asOf: L[0], detail: `交易所持有 ${(L[1] / 1e4).toFixed(1)} 萬 BTC・30 天 ${c >= 0 ? '+' : ''}${c?.toFixed(2)}%・近 4 年 ${pctRank(h, L[1]).toFixed(0)}% 百分位` };
  }
  if (S.exNet?.length >= 400) {
    const sum7 = i => { let s = 0; for (let k = Math.max(0, i - 6); k <= i; k++) s += S.exNet[k][1]; return s; };
    const n = S.exNet.length, cur = sum7(n - 1), hist = []; for (let i = Math.max(6, n - 365); i < n; i++) hist.push(sum7(i));
    const p = pctRank(hist, cur);
    ind.ex_netflow = { value: Math.round(cur), fields: { pct: r(p, 1) }, asOf: S.exNet[n - 1][0], detail: `近 7 日淨${cur >= 0 ? '流入交易所' : '流出交易所'} ${Math.abs(Math.round(cur)).toLocaleString('en-US')} BTC・一年百分位 ${p.toFixed(0)}%` };
  }
  const T = out.treasury || treasury;
  if (T.length) {
    const [d, x] = T.at(-1), tot = (x.etf || 0) + (x.public || 0) + (x.private || 0) + (x.country || 0) + (x.miner || 0);
    const ago = n => { const t = T.filter(y => y[0] <= addDays(d, -n)).at(-1); return t ? t[1] : null; };
    const totOf = y => y ? (y.etf || 0) + (y.public || 0) + (y.private || 0) + (y.country || 0) + (y.miner || 0) : null;
    const t7 = totOf(ago(7)), t30 = totOf(ago(30));
    ind.treasury = { value: Math.round(tot), fields: { chg7: t7 ? Math.round(tot - t7) : null, chg30: t30 ? Math.round(tot - t30) : null, pctSupply: r(tot / 2e5, 2) }, asOf: d,
      detail: `ETF ${(x.etf / 1e4).toFixed(1)} 萬・上市公司 ${(x.public / 1e4).toFixed(1)} 萬・國家 ${(x.country / 1e4).toFixed(1)} 萬・私人公司 ${(x.private / 1e4).toFixed(1)} 萬・礦企 ${(x.miner / 1e4).toFixed(1)} 萬 BTC${t7 ? `・7 天 ${tot - t7 >= 0 ? '+' : ''}${Math.round(tot - t7).toLocaleString('en-US')}` : '・從今天起累積變化'}` };
    if (x.strategy) { const s30 = ago(30)?.strategy, s7 = ago(7)?.strategy;
      ind.strategy = { value: x.strategy, fields: { chg30: s30 ? x.strategy - s30 : null, chg7: s7 ? x.strategy - s7 : null }, asOf: d, detail: `持有 ${x.strategy.toLocaleString('en-US')} BTC${s30 ? `・30 天 ${x.strategy - s30 >= 0 ? '+' : ''}${(x.strategy - s30).toLocaleString('en-US')}` : s7 ? `・7 天 ${x.strategy - s7 >= 0 ? '+' : ''}${(x.strategy - s7).toLocaleString('en-US')}` : '・從今天起累積變化'}` }; }
  }
  // 圖表用的近一年序列（週取樣以控制檔案大小）
  const thin = (ser, n = 1) => (ser || []).filter(x => x[0] >= addDays(today, -400)).filter((_, i, a) => i % n === 0 || i === a.length - 1).map(([d, v]) => [d, r(v, 3)]);
  out.charts = { netliq: thin(S.netliq, 3), tga: thin(S.tga, 3), real10: thin(S.real10, 2), dxy: thin(S.dxy, 2), ndq: thin(S.ndq, 2), exSply: thin(S.exSply, 3) };
  log(`總經與供給：${Object.keys(ind).join('、')}${Object.keys(errs).length ? `；失敗 ${JSON.stringify(errs)}` : ''}`);
  return { ind, errs, ...out };
}

// 重要經濟事件（美東時間），換成 UTC；夏令時間 3 月第二個週日到 11 月第一個週日
const nthSunday = (y, m, n) => { const d = new Date(Date.UTC(y, m, 1)); const first = (7 - d.getUTCDay()) % 7 + 1; return Date.UTC(y, m, first + 7 * (n - 1)); };
const etToUtc = (date, hh, mm) => { const y = +date.slice(0, 4), t = Date.parse(date + 'T00:00:00Z'); const dst = t >= nthSunday(y, 2, 2) && t < nthSunday(y, 10, 1); return new Date(t + ((hh + (dst ? 4 : 5)) * 60 + mm) * 6e4).toISOString(); };
export function upcomingEvents(events, nowIso, n = 6) {
  const list = [];
  for (const e of events) {
    const [hh, mm] = e.time.split(':').map(Number);
    list.push({ ...e, at: etToUtc(e.date, hh, mm) });
  }
  return list.filter(e => e.at >= new Date(Date.parse(nowIso) - 12 * 36e5).toISOString()).sort((a, b) => a.at < b.at ? -1 : 1).slice(0, n);
}
