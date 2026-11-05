// 短線盤勢數據：Deribit 期權與期貨、Coinbase 溢價、OKX 即時資金費率
// 全部是免費公開 API；任一來源失敗不影響其他項目
const UA = { 'User-Agent': 'btc-cycle-radar/2.0 (+github actions)', Accept: 'application/json' };
async function get(url) {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`${url.split('?')[0]} HTTP ${r.status}`);
  return r.json();
}
const MON = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
// BTC-27NOV26 → 到期時間（Deribit 在 08:00 UTC 結算）
function expiryOf(name) {
  const m = name.match(/-(\d{1,2})([A-Z]{3})(\d{2})/); if (!m) return null;
  return Date.UTC(2000 + +m[3], MON[m[2]], +m[1], 8);
}
const pctRank = (arr, x) => ((arr.filter(v => v < x).length + 0.5 * arr.filter(v => v === x).length) / arr.length) * 100;

export async function fetchMarket({ dvolCache = [], log = console.log } = {}) {
  const ind = {}, errs = {}, now = Date.now();
  let dvolSeries = dvolCache;

  // 1) DVOL：Deribit 30 天隱含波動率指數，抓近 4 年日線算百分位
  try {
    const have = new Map(dvolCache.map(r => [r[0], r[1]]));
    const from = dvolCache.length > 1000 ? now - 20 * 864e5 : now - 1500 * 864e5;
    let end = now;
    for (let k = 0; k < 4 && end > from; k++) {
      const j = await get(`https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=BTC&resolution=1D&start_timestamp=${Math.floor(from)}&end_timestamp=${Math.floor(end)}`);
      const d = j.result?.data || [];
      if (!d.length) break;
      for (const c of d) have.set(new Date(c[0]).toISOString().slice(0, 10), +c[4]);
      const minT = Math.min(...d.map(c => c[0]));
      if (j.result.continuation == null || minT <= from) break;
      end = minT - 1;
    }
    dvolSeries = [...have.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([d, v]) => [d, v]);
    const tk = await get('https://www.deribit.com/api/v2/public/get_index_price?index_name=btcdvol_usdc').catch(() => null);
    const cur = +(tk?.result?.index_price) || dvolSeries.at(-1)[1];
    const w = dvolSeries.slice(-1460).map(r => r[1]);
    const d7 = dvolSeries.at(-8)?.[1];
    ind.dvol = { value: +cur.toFixed(1), fields: { p: +pctRank(w, cur).toFixed(1) }, detail: `近 4 年 ${w.length} 天：最低 ${Math.min(...w).toFixed(0)}、最高 ${Math.max(...w).toFixed(0)}${d7 ? `・7 天前 ${d7.toFixed(1)}` : ''}` };
  } catch (e) { errs.deribit = 'DVOL：' + e.message; }

  // 2) 期權：Put/Call 未平倉比、30 天 ±10% 價外偏斜、ATM 隱含波動率
  try {
    const j = await get('https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=BTC&kind=option');
    const opts = (j.result || []).map(o => {
      const m = o.instrument_name.match(/-(\d+)-([CP])$/);
      return m ? { name: o.instrument_name, exp: expiryOf(o.instrument_name), k: +m[1], cp: m[2], iv: +o.mark_iv, oi: +o.open_interest || 0, u: +o.underlying_price } : null;
    }).filter(o => o && o.exp > now);
    const oiP = opts.filter(o => o.cp === 'P').reduce((s, o) => s + o.oi, 0), oiC = opts.filter(o => o.cp === 'C').reduce((s, o) => s + o.oi, 0);
    if (!oiC) throw new Error('沒有期權資料');
    ind.pcr = { value: +(oiP / oiC).toFixed(3), fields: {}, detail: `賣權 ${Math.round(oiP).toLocaleString('en-US')} BTC・買權 ${Math.round(oiC).toLocaleString('en-US')} BTC（全部到期日）` };
    const exps = [...new Set(opts.map(o => o.exp))];
    const target = now + 30 * 864e5;
    const exp = exps.filter(e => e - now >= 14 * 864e5).sort((a, b) => Math.abs(a - target) - Math.abs(b - target))[0];
    const se = opts.filter(o => o.exp === exp && o.iv > 0);
    const u = se[0]?.u;
    const near = (cp, k) => se.filter(o => o.cp === cp).sort((a, b) => Math.abs(a.k - k) - Math.abs(b.k - k))[0];
    const put = near('P', u * 0.9), call = near('C', u * 1.1), atmC = near('C', u), atmP = near('P', u);
    if (!put || !call) throw new Error('找不到價外期權');
    const days = Math.round((exp - now) / 864e5);
    const atm = (atmC.iv + atmP.iv) / 2;
    ind.skew = { value: +(put.iv - call.iv).toFixed(1), fields: { atm: +atm.toFixed(1), days },
      detail: `${days} 天到期：賣權 ${put.k.toLocaleString('en-US')} IV ${put.iv.toFixed(1)}%・買權 ${call.k.toLocaleString('en-US')} IV ${call.iv.toFixed(1)}%・ATM ${atm.toFixed(1)}%` };
  } catch (e) { errs.deribit = (errs.deribit ? errs.deribit + '；' : '') + '期權：' + e.message; }

  // 3) 期現基差年化：Deribit 到期日最接近 90 天的期貨
  try {
    const j = await get('https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=BTC&kind=future');
    const fut = (j.result || []).filter(f => !/PERPETUAL/.test(f.instrument_name)).map(f => ({ name: f.instrument_name, exp: expiryOf(f.instrument_name), mark: +f.mark_price, idx: +(f.estimated_delivery_price || f.underlying_price) }))
      .filter(f => f.exp && f.exp - now > 20 * 864e5 && f.mark && f.idx);
    const f = fut.sort((a, b) => Math.abs(a.exp - now - 90 * 864e5) - Math.abs(b.exp - now - 90 * 864e5))[0];
    if (!f) throw new Error('找不到合適期貨');
    const days = (f.exp - now) / 864e5, prem = f.mark / f.idx - 1;
    ind.basis = { value: +(prem * 365 / days * 100).toFixed(2), fields: { days: Math.round(days), prem: +(prem * 100).toFixed(2) },
      detail: `${f.name}（${Math.round(days)} 天）溢價 ${(prem * 100).toFixed(2)}%・期貨 $${Math.round(f.mark).toLocaleString('en-US')} / 指數 $${Math.round(f.idx).toLocaleString('en-US')}` };
  } catch (e) { errs.deribit = (errs.deribit ? errs.deribit + '；' : '') + '期貨：' + e.message; }

  // 4) 資金費率年化：OKX BTC-USDT 永續，近 7 天平均（每 8 小時一次）
  try {
    const j = await get('https://www.okx.com/api/v5/public/funding-rate-history?instId=BTC-USDT-SWAP&limit=100');
    const r = (j.data || []).map(x => +(x.realizedRate ?? x.fundingRate)).filter(Number.isFinite);
    if (r.length < 21) throw new Error('資料不足');
    const apr = a => a.reduce((s, x) => s + x, 0) / a.length * 3 * 365 * 100;
    const cur = await get('https://www.okx.com/api/v5/public/funding-rate?instId=BTC-USDT-SWAP').catch(() => null);
    const next = +(cur?.data?.[0]?.fundingRate);
    ind.fundapr = { value: +apr(r.slice(0, 21)).toFixed(2), fields: { apr30: +apr(r.slice(0, 90)).toFixed(2), next: Number.isFinite(next) ? +(next * 100).toFixed(4) : null },
      detail: `近 30 天平均年化 ${apr(r.slice(0, 90)).toFixed(1)}%${Number.isFinite(next) ? `・本期 ${(next * 100).toFixed(4)}%（8 小時）` : ''}` };
  } catch (e) { errs.okxfund = e.message; }

  // 5) Coinbase 溢價：Coinbase BTC-USD 對 OKX BTC-USDT，近 7 天每小時平均
  try {
    const [cb, ok, ut] = await Promise.all([
      get('https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=3600'),
      get('https://www.okx.com/api/v5/market/candles?instId=BTC-USDT&bar=1H&limit=300'),
      get('https://api.exchange.coinbase.com/products/USDT-USD/candles?granularity=3600').catch(() => []),
    ]);
    // OKX 以 USDT 計價：用 Coinbase 的 USDT/USD 匯率換成美元，排除 USDT 偏離 1 美元造成的系統性折溢價
    const usdt = new Map((ut || []).map(c => [c[0], +c[4]]));
    const okMap = new Map((ok.data || []).map(c => [Math.floor(+c[0] / 1000), +c[4]]));
    const pairs = (cb || []).map(c => [c[0], +c[4], okMap.get(c[0]) && okMap.get(c[0]) * (usdt.get(c[0]) || 1)]).filter(p => p[2]).sort((a, b) => a[0] - b[0]);
    const usdtAdj = usdt.size > 48;
    if (pairs.length < 48) throw new Error('對齊資料不足 ' + pairs.length);
    const prem = pairs.map(p => (p[1] / p[2] - 1) * 100);
    const avg = a => a.reduce((s, x) => s + x, 0) / a.length;
    const p7 = avg(prem.slice(-168)), p24 = avg(prem.slice(-24));
    const neg = prem.slice(-168).filter(x => x < 0).length;
    ind.cbprem = { value: +p7.toFixed(3), fields: { p24: +p24.toFixed(3), last: +prem.at(-1).toFixed(3) },
      detail: `近 24 小時 ${p24 >= 0 ? '+' : ''}${p24.toFixed(3)}%・最近一小時 ${prem.at(-1) >= 0 ? '+' : ''}${prem.at(-1).toFixed(3)}%・7 天內 ${Math.round(neg / Math.min(168, prem.length) * 100)}% 時間為折價${usdtAdj ? '・已用 USDT/USD 匯率校正' : '・未校正 USDT 匯率'}` };
  } catch (e) { errs.coinbase = e.message; }

  // 套利池建議：比較資金費率套利與期現套利的年化收益
  let arb = null;
  if (ind.fundapr || ind.basis) {
    const f = ind.fundapr?.value ?? null, b = ind.basis?.value ?? null;
    const best = f != null && (b == null || f >= b) ? 'funding' : 'basis';
    const top = best === 'funding' ? f : b;
    let advice;
    if (f != null && f < 0) advice = '資金費率為負：資金費率套利（做多現貨＋做空永續）會付費，暫停或改做期現套利。';
    else if (top < 5) advice = `兩種套利年化都低於 5%（最高 ${top.toFixed(1)}%），收益偏低，可考慮部分改放穩定幣借貸或定存。`;
    else advice = `${best === 'funding' ? '資金費率套利' : `期現套利（${ind.basis.fields.days} 天期）`}年化約 ${top.toFixed(1)}%，收益較高，套利池優先配置這一種。`;
    if (top > 20) advice += ' 年化超過 20% 代表多頭槓桿擁擠，常見於過熱階段。';
    arb = { funding: f, basis: b, basisDays: ind.basis?.fields.days ?? null, best, advice };
  }
  log(`短線數據：${Object.keys(ind).join('、')}${Object.keys(errs).length ? `；失敗 ${JSON.stringify(errs)}` : ''}`);
  return { ind, errs, arb, dvolSeries };
}
