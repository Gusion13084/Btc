// 套利池各平台收益比較：多家交易所資金費率、期現價差、穩定幣借貸利率
// 全部是公開 API；Binance、Bybit 在 GitHub（美國）主機上會被擋，改由 Coinalyze 取得
const UA = { 'User-Agent': 'btc-cycle-radar/2.0 (+github actions)', Accept: 'application/json' };
async function get(url, opt = {}) {
  const r = await fetch(url, { ...opt, headers: { ...UA, ...(opt.headers || {}) }, signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`${url.split('?')[0]} HTTP ${r.status}`);
  return r.json();
}
const avg = a => a.reduce((s, x) => s + x, 0) / a.length;
const D = 864e5;

// 每 8 小時結算的費率陣列（新到舊或舊到新皆可）→ 年化 %
const apr8h = rates => avg(rates) * 3 * 365 * 100;

export async function fetchArb({ okxRates = null, czKey = null, log = console.log } = {}) {
  const now = Date.now(), venues = [], errs = {};
  const add = (v) => { if (Number.isFinite(v.apr)) venues.push({ ...v, apr: +v.apr.toFixed(2), apr30: Number.isFinite(v.apr30) ? +v.apr30.toFixed(2) : null }); };

  // ---- 資金費率（做多現貨＋做空永續）----
  if (okxRates?.length >= 21) add({ kind: 'funding', venue: 'OKX', apr: apr8h(okxRates.slice(0, 21)), apr30: okxRates.length >= 90 ? apr8h(okxRates.slice(0, 90)) : null });

  await Promise.all([
    (async () => {
      const j = await get('https://api.bitget.com/api/v2/mix/market/history-fund-rate?symbol=BTCUSDT&productType=usdt-futures&pageSize=100');
      const r = (j.data || []).map(x => +x.fundingRate).filter(Number.isFinite);
      if (r.length < 21) throw new Error('資料不足');
      add({ kind: 'funding', venue: 'Bitget', apr: apr8h(r.slice(0, 21)), apr30: r.length >= 90 ? apr8h(r.slice(0, 90)) : null });
    })().catch(e => { errs.bitget = e.message; }),
    (async () => {
      const j = await get('https://api.gateio.ws/api/v4/futures/usdt/funding_rate?contract=BTC_USDT&limit=100');
      const r = (j || []).sort((a, b) => b.t - a.t).map(x => +x.r).filter(Number.isFinite);
      if (r.length < 21) throw new Error('資料不足');
      add({ kind: 'funding', venue: 'Gate', apr: apr8h(r.slice(0, 21)), apr30: r.length >= 90 ? apr8h(r.slice(0, 90)) : null });
    })().catch(e => { errs.gate = e.message; }),
    (async () => {
      const j = await get('https://www.bitmex.com/api/v1/funding?symbol=XBTUSD&count=100&reverse=true');
      const r = (j || []).map(x => +x.fundingRate).filter(Number.isFinite);
      if (r.length < 21) throw new Error('資料不足');
      add({ kind: 'funding', venue: 'BitMEX', apr: apr8h(r.slice(0, 21)), apr30: r.length >= 90 ? apr8h(r.slice(0, 90)) : null, note: '幣本位' });
    })().catch(e => { errs.bitmex = e.message; }),
    (async () => {
      // Hyperliquid 每小時結算一次
      const j = await get('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'fundingHistory', coin: 'BTC', startTime: now - 7 * D }) });
      const r = (j || []).map(x => +x.fundingRate).filter(Number.isFinite);
      if (r.length < 100) throw new Error('資料不足');
      add({ kind: 'funding', venue: 'Hyperliquid', apr: avg(r) * 24 * 365 * 100, note: '鏈上交易所' });
    })().catch(e => { errs.hyperliquid = e.message; }),
    (async () => {
      // Deribit 永續：每小時一筆，interest_8h 為該小時的 8 小時費率
      const j = await get(`https://www.deribit.com/api/v2/public/get_funding_rate_history?instrument_name=BTC-PERPETUAL&start_timestamp=${now - 7 * D}&end_timestamp=${now}`);
      const r = (j.result || []).map(x => +x.interest_8h).filter(Number.isFinite);
      if (r.length < 100) throw new Error('資料不足');
      add({ kind: 'funding', venue: 'Deribit', apr: apr8h(r), note: '幣本位' });
    })().catch(e => { errs.deribitPerp = e.message; }),
  ]);

  // Binance、Bybit：透過 Coinalyze，以同一批資料中的 OKX 校正單位
  if (czKey) {
    try {
      const cz = async p => { const r = await fetch('https://api.coinalyze.net/v1' + p, { headers: { ...UA, api_key: czKey }, signal: AbortSignal.timeout(40000) }); if (!r.ok) throw new Error(`Coinalyze ${p.split('?')[0]} HTTP ${r.status}`); return r.json(); };
      const exs = await cz('/exchanges');
      const code = n => exs.find(e => e.name.toLowerCase().includes(n))?.code;
      const want = { Binance: code('binance'), Bybit: code('bybit'), OKX: code('okx') };
      const mk = await cz('/future-markets');
      const sym = {};
      for (const [n, c] of Object.entries(want)) {
        const m = mk.find(m => m.symbol.endsWith('.' + c) && m.base_asset === 'BTC' && m.quote_asset === 'USDT' && m.is_perpetual);
        if (m) sym[n] = m.symbol;
      }
      const list = Object.values(sym);
      if (!list.length) throw new Error('找不到合約代號');
      const to = Math.floor(now / 1000);
      const h = await cz(`/funding-rate-history?symbols=${encodeURIComponent(list.join(','))}&interval=1hour&from=${to - 7 * 86400}&to=${to}`);
      const series = Object.fromEntries(Object.entries(sym).map(([n, s]) => [n, (h.find(x => x.symbol === s)?.history || []).map(b => +b.c).filter(Number.isFinite)]));
      // 每小時 K 線的收盤值＝當下的 8 小時費率；以 OKX 直連數據判斷單位（小數或百分比）
      let scale = 0.01;
      const okxDirect = venues.find(v => v.venue === 'OKX');
      const raw = series.OKX?.length > 48 ? apr8h(series.OKX) : 0;
      if (okxDirect && raw && Math.abs(okxDirect.apr) > 2 && Math.sign(raw) === Math.sign(okxDirect.apr)) {
        const ratio = okxDirect.apr / raw;
        scale = [1, 0.01, 1 / 8, 0.01 / 8, 8, 0.08].sort((a, b) => Math.abs(Math.log(ratio / a)) - Math.abs(Math.log(ratio / b)))[0];
      } else {
        const med = series.Binance?.length ? series.Binance.slice().sort((a, b) => a - b)[series.Binance.length >> 1] : 0;
        scale = Math.abs(med) > 0.002 ? 0.01 : 1;
      }
      for (const n of ['Binance', 'Bybit']) {
        const r = series[n];
        if (r?.length > 48) add({ kind: 'funding', venue: n, apr: apr8h(r) * scale, note: 'Coinalyze' });
        else errs[n.toLowerCase()] = 'Coinalyze 無資料';
      }
      log(`Coinalyze 資金費率：${JSON.stringify(sym)}，單位倍數 ${scale}`);
    } catch (e) { errs.coinalyzeFunding = e.message; }
  }

  // ---- 期現價差（買現貨＋賣到期期貨）----
  await Promise.all([
    (async () => {
      const j = await get('https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=BTC&kind=future');
      const MON = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
      for (const f of j.result || []) {
        const m = f.instrument_name.match(/-(\d{1,2})([A-Z]{3})(\d{2})$/); if (!m) continue;
        const exp = Date.UTC(2000 + +m[3], MON[m[2]], +m[1], 8), days = (exp - now) / D;
        const idx = +(f.estimated_delivery_price || f.underlying_price), mark = +f.mark_price;
        if (days < 20 || !idx || !mark) continue;
        add({ kind: 'basis', venue: 'Deribit', contract: f.instrument_name, days: Math.round(days), apr: (mark / idx - 1) * 365 / days * 100, note: '幣本位' });
      }
    })().catch(e => { errs.deribitFut = e.message; }),
    (async () => {
      const [t, ix] = await Promise.all([
        get('https://www.okx.com/api/v5/market/tickers?instType=FUTURES&instFamily=BTC-USD'),
        get('https://www.okx.com/api/v5/market/index-tickers?instId=BTC-USD'),
      ]);
      const idx = +ix.data?.[0]?.idxPx; if (!idx) throw new Error('無指數價格');
      for (const x of t.data || []) {
        const m = x.instId.match(/-(\d{2})(\d{2})(\d{2})$/); if (!m) continue;
        const exp = Date.UTC(2000 + +m[1], +m[2] - 1, +m[3], 8), days = (exp - now) / D, px = +x.last;
        if (days < 20 || !px) continue;
        add({ kind: 'basis', venue: 'OKX', contract: x.instId, days: Math.round(days), apr: (px / idx - 1) * 365 / days * 100, note: '幣本位' });
      }
    })().catch(e => { errs.okxFut = e.message; }),
  ]);

  // ---- 穩定幣借貸（不需持有 BTC，作為收益下限參考）----
  try {
    const j = await get('https://yields.llama.fi/pools');
    const pick = (proj, sym) => (j.data || []).filter(p => p.project === proj && p.chain === 'Ethereum' && p.symbol === sym).sort((a, b) => b.tvlUsd - a.tvlUsd)[0];
    for (const [proj, sym, name] of [['aave-v3', 'USDC', 'Aave USDC'], ['aave-v3', 'USDT', 'Aave USDT']]) {
      const p = pick(proj, sym);
      if (p && Number.isFinite(+p.apy)) add({ kind: 'lend', venue: name, apr: +p.apy, apr30: Number.isFinite(+p.apyMean30d) ? +p.apyMean30d : null, note: 'Ethereum 鏈上借貸' });
    }
  } catch (e) { errs.defillama = e.message; }

  // 每家期貨只留最接近 90 天的一檔（另外保留全部合約供參考）
  const basisAll = venues.filter(v => v.kind === 'basis').sort((a, b) => a.days - b.days);
  const basisPick = Object.values(basisAll.reduce((o, v) => { const c = o[v.venue]; if (!c || Math.abs(v.days - 90) < Math.abs(c.days - 90)) o[v.venue] = v; return o; }, {}));
  const list = [...venues.filter(v => v.kind !== 'basis'), ...basisPick].sort((a, b) => b.apr - a.apr);
  log(`套利收益：${list.map(v => `${v.venue}${v.kind === 'basis' ? `期貨${v.days}天` : v.kind === 'lend' ? '' : '永續'} ${v.apr}%`).join('、')}${Object.keys(errs).length ? `；失敗 ${JSON.stringify(errs)}` : ''}`);
  return { venues: list, curve: basisAll.map(v => ({ venue: v.venue, contract: v.contract, days: v.days, apr: v.apr })), errs };
}
