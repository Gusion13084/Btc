// 清算地圖（OKX BTC-USDT 永續，估算）
// 估算方法：近 30 天每小時「未平倉量增加」視為新開倉，開倉價取該小時均價，依常見槓桿分布推算爆倉價；
// 未平倉量減少時按比例視為平倉；價格已經掃過的爆倉價視為已清算並移除。
// 另外整理 OKX 公布的實際強平紀錄。金額只代表 OKX 一家，用來看相對分布，不是全市場總額。
const UA = { 'User-Agent': 'btc-cycle-radar/2.0 (+github actions)', Accept: 'application/json' };
const OKX = 'https://www.okx.com/api/v5';
async function okx(path) {
  const r = await fetch(OKX + path, { headers: UA, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`${path.split('?')[0]} HTTP ${r.status}`);
  const j = await r.json();
  if (j.code && j.code !== '0') throw new Error(`${path.split('?')[0]} code ${j.code} ${j.msg || ''}`);
  return j.data || [];
}
const LEV = [[5, 0.15], [10, 0.30], [25, 0.30], [50, 0.15], [100, 0.10]];
const MMR = 0.004;
const HOURS = 720;
// Rubik 統計一次最多 100 筆：用 end（毫秒）往回翻頁；若參數無效（拿到重複資料）就停止
async function rubikPaged(path, log) {
  const all = new Map(); let end = '';
  for (let k = 0; k < 8 && all.size < HOURS; k++) {
    if (k) await new Promise(r => setTimeout(r, 600)); // Rubik 限速約每 2 秒 5 次
    const d = await okx(path + (end ? `&end=${end}` : ''));
    const before = all.size;
    for (const r of d) all.set(+r[0], r);
    if (!d.length || all.size === before) break;
    end = String(Math.min(...d.map(r => +r[0])) - 1);
  }
  return [...all.values()];
}

export async function buildLiqMap(log = console.log) {
  const notes = [];
  // 1) 每小時 K 線（最新在前，分頁往回抓）
  let candles = [], after = '';
  for (let k = 0; k < 8 && candles.length < HOURS; k++) {
    const d = await okx(`/market/history-candles?instId=BTC-USDT-SWAP&bar=1H&limit=100${after ? `&after=${after}` : ''}`);
    if (!d.length) break;
    candles.push(...d); after = d[d.length - 1][0];
  }
  candles = candles.map(c => ({ ts: +c[0], o: +c[1], h: +c[2], l: +c[3], c: +c[4], volUsd: +(c[7] ?? 0) || (+c[6] * +c[4]) || 0 }))
    .filter(c => Number.isFinite(c.c)).sort((a, b) => a.ts - b.ts);
  if (candles.length < 48) throw new Error('K 線不足：' + candles.length);
  const price = candles.at(-1).c;
  // 2) 每小時未平倉量（USD）
  let oi = new Map();
  try {
    const d = await rubikPaged(`/rubik/stat/contracts/open-interest-history?instId=BTC-USDT-SWAP&period=1H&limit=100`);
    for (const r of d) { const row = Array.isArray(r) ? r : [r.ts, r.oi, r.oiCcy, r.oiUsd]; const usd = +row[3] || (+row[2] * price); if (usd) oi.set(+row[0], usd); }
    log(`OKX OI 歷史 ${oi.size} 筆，樣本 ${JSON.stringify(d[0])}`);
  } catch (e) { notes.push('OI 歷史：' + e.message); }
  if (oi.size < 48) {
    try {
      const d = await okx(`/rubik/stat/contracts/open-interest-volume?ccy=BTC&period=1H`);
      oi = new Map(d.map(r => [+r[0], +r[1]]));
      log(`OKX OI（備援）${oi.size} 筆，樣本 ${JSON.stringify(d[0])}`);
    } catch (e) { notes.push('OI 備援：' + e.message); }
  }
  // 3) 主動買賣量，用來分配多空
  const taker = new Map();
  await new Promise(r => setTimeout(r, 2500));
  try {
    const d = await rubikPaged(`/rubik/stat/taker-volume-contract?instId=BTC-USDT-SWAP&period=1H&limit=100`);
    for (const r of d) taker.set(+r[0], { sell: +r[1], buy: +r[2] });
    log(`OKX 主動買賣 ${taker.size} 筆，樣本 ${JSON.stringify(d[0])}`);
  } catch (e) { notes.push('主動買賣量：' + e.message); }

  // 4) 模擬倉位
  let pos = []; // {px, side:'L'|'S', usd}
  let prevOi = null, used = 0;
  const firstOi = oi.size >= 48 ? Math.min(...oi.keys()) : 0;
  for (const c of candles) {
    if (c.ts < firstOi) continue;
    // 先清算本小時被掃到的倉位
    pos = pos.filter(p => p.side === 'L' ? c.l > p.px : c.h < p.px);
    const cur = oi.get(c.ts);
    let opened = 0;
    if (cur != null && prevOi != null) {
      const d = cur - prevOi;
      if (d > 0) opened = d;
      else if (d < 0 && prevOi > 0) { const k = Math.max(0, 1 + d / prevOi); pos.forEach(p => p.usd *= k); }
      used++;
    } else if (oi.size < 48) opened = c.volUsd * 0.05; // 沒有 OI 時，用成交量的一小部分當作新倉位
    if (cur != null) prevOi = cur;
    if (opened > 0) {
      const t = taker.get(c.ts); const lr = t && t.buy + t.sell > 0 ? t.buy / (t.buy + t.sell) : 0.5;
      const entry = (c.h + c.l + c.c) / 3;
      for (const [lev, w] of LEV) {
        pos.push({ side: 'L', px: entry * (1 - 1 / lev + MMR), usd: opened * lr * w });
        pos.push({ side: 'S', px: entry * (1 + 1 / lev - MMR), usd: opened * (1 - lr) * w });
      }
    }
  }
  if (!used && oi.size >= 48) notes.push('OI 與 K 線時間對不上');
  // 5) 依價位分桶（0.5% 一格，現價 ±15%）
  const step = Math.max(100, Math.round(price * 0.005 / 50) * 50);
  const lo = price * 0.85, hi = price * 1.15;
  const B = new Map();
  for (const p of pos) {
    if (p.px < lo || p.px > hi || p.usd < 1) continue;
    const k = Math.floor(p.px / step) * step;
    const b = B.get(k) || { price: k, long: 0, short: 0 };
    p.side === 'L' ? (b.long += p.usd) : (b.short += p.usd);
    B.set(k, b);
  }
  const buckets = [...B.values()].sort((a, b) => b.price - a.price).map(b => ({ price: b.price, long: Math.round(b.long), short: Math.round(b.short) }));
  const sum = (f, a, b) => buckets.filter(x => x.price >= a && x.price < b).reduce((s, x) => s + x[f], 0);
  const top = (f, cond) => buckets.filter(cond).sort((a, b) => b[f] - a[f]).slice(0, 3).map(x => ({ price: x.price, usd: x[f], dist: +((x.price / price - 1) * 100).toFixed(1) }));
  const realized = null;
  return {
    generatedAt: new Date().toISOString(), price: Math.round(price), step, hours: candles.length, oiPoints: oi.size, method: oi.size >= 48 ? 'oi' : 'volume',
    buckets,
    near5: { long: Math.round(sum('long', price * 0.95, price)), short: Math.round(sum('short', price, price * 1.05)) },
    near10: { long: Math.round(sum('long', price * 0.9, price)), short: Math.round(sum('short', price, price * 1.1)) },
    topLong: top('long', x => x.price < price), topShort: top('short', x => x.price > price),
    realized, notes,
  };
}

// ---------- 多交易所版本（Coinalyze，需要免費 API 金鑰） ----------
const CZ = 'https://api.coinalyze.net/v1';
const PREFER = ['binance', 'bybit', 'okx', 'bitget', 'deribit', 'hyperliquid', 'gate', 'bitmex', 'coinbase', 'kraken'];
async function cz(path, key, log) {
  for (let t = 0; t < 3; t++) {
    const r = await fetch(CZ + path, { headers: { ...UA, api_key: key }, signal: AbortSignal.timeout(40000) });
    if (r.status === 429) { const w = (+r.headers.get('retry-after') || 30) + 1; log(`Coinalyze 限速，等待 ${w} 秒`); await sleep(w * 1000); continue; }
    if (!r.ok) throw new Error(`Coinalyze ${path.split('?')[0]} HTTP ${r.status}`);
    return r.json();
  }
  throw new Error('Coinalyze 限速重試失敗');
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function buildLiqMapMulti(key, log = console.log) {
  const exs = await cz('/exchanges', key, log);
  const exName = new Map(exs.map(e => [e.code, e.name]));
  const mk = await cz('/future-markets', key, log);
  const cand = mk.filter(m => m.base_asset === 'BTC' && m.is_perpetual && ['USDT', 'USD', 'USDC'].includes(m.quote_asset) && m.has_ohlcv_data)
    .map(m => ({ ...m, ex: (exName.get(m.symbol.split('.').pop()) || m.exchange || '').toString() }))
    .filter(m => PREFER.some(p => m.ex.toLowerCase().includes(p)))
    .sort((a, b) => PREFER.findIndex(p => a.ex.toLowerCase().includes(p)) - PREFER.findIndex(p => b.ex.toLowerCase().includes(p)));
  // 每個交易所最多取 2 個主要合約（USDT 與幣本位），總數上限 10，以符合每分鐘 40 次限制
  const pick = [], perEx = {};
  for (const m of cand) { const k = m.ex; if ((perEx[k] || 0) >= 2 || pick.length >= 10) continue; perEx[k] = (perEx[k] || 0) + 1; pick.push(m); }
  if (!pick.length) throw new Error('找不到 BTC 永續合約');
  const syms = pick.map(m => m.symbol).join(',');
  const to = Math.floor(Date.now() / 1000), from = to - HOURS * 3600;
  const q = `symbols=${encodeURIComponent(syms)}&interval=1hour&from=${from}&to=${to}`;
  const oiR = await cz(`/open-interest-history?${q}&convert_to_usd=true`, key, log);
  await sleep(+process.env.CZ_WAIT_MS || 62000); // 每個 symbol 算一次呼叫：分三個時段送出，避免超過每分鐘 40 次
  const pxR = await cz(`/ohlcv-history?${q}`, key, log);
  await sleep(+process.env.CZ_WAIT_MS || 62000);
  const lqR = await cz(`/liquidation-history?${q}&convert_to_usd=true`, key, log);
  const by = (arr) => new Map((arr || []).map(x => [x.symbol, x.history || []]));
  const OI = by(oiR), PX = by(pxR), LQ = by(lqR);
  log(`Coinalyze：${pick.map(m => `${m.ex}:${m.symbol}`).join('、')}；OI 樣本 ${JSON.stringify((oiR[0]?.history || [])[0])}；K 線樣本 ${JSON.stringify((pxR[0]?.history || [])[0])}；清算樣本 ${JSON.stringify((lqR[0]?.history || []).at(-1))}`);
  let pos = [], ref = null, used = [];
  for (const m of pick) {
    const oi = new Map((OI.get(m.symbol) || []).map(h => [h.t, h.c]));
    const px = (PX.get(m.symbol) || []).filter(h => h.c > 0);
    if (oi.size < 48 || px.length < 48) continue;
    used.push(m.ex);
    if (!ref || px.length > ref.length) ref = px;
    let mine = [], prev = null;
    for (const c of px) {
      mine = mine.filter(p => p.side === 'L' ? c.l > p.px : c.h < p.px);
      const cur = oi.get(c.t);
      if (cur != null && prev != null) {
        const d = cur - prev;
        if (d > 0) {
          const lr = c.v > 0 && c.bv != null ? Math.min(1, Math.max(0, c.bv / c.v)) : 0.5;
          const entry = (c.h + c.l + c.c) / 3;
          for (const [lev, w] of LEV) {
            mine.push({ side: 'L', px: entry * (1 - 1 / lev + MMR), usd: d * lr * w });
            mine.push({ side: 'S', px: entry * (1 + 1 / lev - MMR), usd: d * (1 - lr) * w });
          }
        } else if (d < 0 && prev > 0) { const k = Math.max(0, 1 + d / prev); mine.forEach(p => p.usd *= k); }
      }
      if (cur != null) prev = cur;
    }
    pos.push(...mine);
  }
  if (!ref) throw new Error('Coinalyze 數據不足');
  const price = ref.at(-1).c;
  const out = bucketize(pos, price);
  // 實際清算：每小時多空清算額，依當小時價格分桶（近 7 天）與 24 小時合計
  const pxAt = new Map(ref.map(h => [h.t, h.c]));
  const real = new Map(); let l24 = 0, s24 = 0, l7 = 0, s7 = 0;
  for (const m of pick) for (const h of LQ.get(m.symbol) || []) {
    const age = to - h.t; if (age > 7 * 86400) continue;
    const p = pxAt.get(h.t); const L = +h.l || 0, Sx = +h.s || 0;
    l7 += L; s7 += Sx; if (age <= 86400) { l24 += L; s24 += Sx; }
    if (!p) continue;
    const k = Math.floor(p / out.step) * out.step; const b = real.get(k) || { price: k, long: 0, short: 0 };
    b.long += L; b.short += Sx; real.set(k, b);
  }
  const realTop = [...real.values()].map(b => ({ ...b, total: b.long + b.short })).sort((a, b) => b.total - a.total).slice(0, 5)
    .map(b => ({ price: b.price, long: Math.round(b.long), short: Math.round(b.short) }));
  return { ...out, generatedAt: new Date().toISOString(), price: Math.round(price), hours: ref.length, method: 'coinalyze',
    exchanges: [...new Set(used)], symbols: pick.map(m => m.symbol),
    realized: { h24: { long: Math.round(l24), short: Math.round(s24) }, d7: { long: Math.round(l7), short: Math.round(s7) }, top: realTop }, notes: [] };
}

function bucketize(pos, price) {
  const step = Math.max(100, Math.round(price * 0.005 / 50) * 50);
  const lo = price * 0.85, hi = price * 1.15;
  const B = new Map();
  for (const p of pos) {
    if (p.px < lo || p.px > hi || p.usd < 1) continue;
    const k = Math.floor(p.px / step) * step;
    const b = B.get(k) || { price: k, long: 0, short: 0 };
    p.side === 'L' ? (b.long += p.usd) : (b.short += p.usd);
    B.set(k, b);
  }
  const buckets = [...B.values()].sort((a, b) => b.price - a.price).map(b => ({ price: b.price, long: Math.round(b.long), short: Math.round(b.short) }));
  const sum = (f, a, b) => buckets.filter(x => x.price >= a && x.price < b).reduce((s, x) => s + x[f], 0);
  const top = (f, cond) => buckets.filter(cond).sort((a, b) => b[f] - a[f]).slice(0, 3).map(x => ({ price: x.price, usd: x[f], dist: +((x.price / price - 1) * 100).toFixed(1) }));
  return { step, buckets,
    near5: { long: Math.round(sum('long', price * 0.95, price)), short: Math.round(sum('short', price, price * 1.05)) },
    near10: { long: Math.round(sum('long', price * 0.9, price)), short: Math.round(sum('short', price, price * 1.1)) },
    topLong: top('long', x => x.price < price), topShort: top('short', x => x.price > price) };
}
