// 日報用數據摘要：讀取網站資料檔，輸出當日日報需要的所有數字（JSON）
// 用法：node scripts/report-data.mjs
import { readFile } from 'node:fs/promises';
const J = async p => JSON.parse(await readFile(new URL('../' + p, import.meta.url), 'utf8'));
const [l, h, m, c, b] = await Promise.all([J('data/latest.json'), J('data/history.json'), J('data/liqmap.json'), J('config/indicators.json'), J('data/backtest.json')]);
const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(new Date());
const rows = b.rows.map(r => Object.fromEntries(b.fields.map((f, i) => [f, r[i]])));
const at = n => rows[rows.length - 1 - n];
const snap = h.at(-1);
const pct = (a, x) => x ? +((a / x - 1) * 100).toFixed(1) : null;
const prev = h.filter(x => x.date < snap.date && !x.legacy).at(-1) || null;
const bandOf = (d, v) => { if (!d.bands || v == null || !Number.isFinite(+v)) return null; return d.bands.find(b => b.to == null || +v < b.to) || null; };
const ind = c.indicators.map(d => {
  const v = l.indicators[d.id] || {};
  const bv = d.bandField ? v.fields?.[d.bandField] : v.value;
  const band = bandOf(d, bv);
  const pv = prev?.values?.[d.id] ?? null;
  const pband = d.bandField ? null : bandOf(d, pv);
  return { id: d.id, name: d.name, tier: d.tier || 'core', group: d.group, value: v.display ?? v.value ?? null, p4y: v.fields?.p ?? null,
    band: band ? `${band.label}（${band.tone || 'neu'}）` : null, prevValue: pv, prevBand: pband && band && pband.label !== band.label ? pband.label : undefined,
    prevP4y: prev?.pct?.[d.id] ?? null,
    fields: v.fields || {}, asOf: v.asOf ?? null, ok: v.ok ?? false, detail: v.detail || '', score: snap.items?.[d.id] ?? null, prevScore: prev?.items?.[d.id] ?? null };
});
const out = {
  check: {
    today, dataDate: l.date, snapshotAt: l.snapshotAt, pending: !!l.pending,
    isToday: l.date === today && snap.date === today && !l.pending,
    failedSources: Object.entries(l.sources || {}).filter(([, s]) => !s.ok).map(([k, s]) => `${s.name}: ${s.error}`),
  },
  price: { btc: l.btcPrice, eth: l.ethPrice, d1: pct(at(0).price, at(1)?.price), d7: pct(at(0).price, at(7)?.price), d30: pct(at(0).price, at(30)?.price), price30dAgo: at(30)?.price },
  cycleIndex: { value: l.index, zone: l.indexZone, d7: at(7)?.idx != null ? +(l.index - at(7).idx).toFixed(1) : null, d30: at(30)?.idx != null ? +(l.index - at(30).idx).toFixed(1) : null },
  ma50w: at(0).ma50w, ethbtcP4y: at(0).ethPct,
  scores: { cbs: snap.cbs, cbsMax: 28, cbsLevel: snap.cbsLevel, cbsConfirm: snap.cbsConfirm, cts: snap.cts, ctsMax: 25, ctsLevel: snap.ctsLevel, ctsConfirm: snap.ctsConfirm },
  decision: snap.decision,
  previous: prev && { date: prev.date, btcPrice: prev.btcPrice, cbs: prev.cbs, cts: prev.cts, cbsLevel: prev.cbsLevel, ctsLevel: prev.ctsLevel, idx: prev.idx, decisionTitle: prev.decision?.title },
  arb: l.arb ?? null,
  levels: { cbs: c.levels.cbs.map(x => ({ min: x.min, name: x.name, target: x.batch?.target ?? null })), cts: c.levels.cts.map(x => ({ min: x.min, name: x.name, target: x.batch?.target ?? null })) },
  indicators: ind,
  liquidation: { generatedAt: m.generatedAt, method: m.method, exchanges: m.exchanges, price: m.price, near5: m.near5, near10: m.near10, topShort: m.topShort, topLong: m.topLong, realized: m.realized },
  last14: rows.slice(-14).map(r => ({ date: r.date, price: r.price, cbs: r.cbs, cts: r.cts, idx: r.idx })),
  lags: l.lags,
};
console.log(JSON.stringify(out, null, 1));
