// 組合信號：多個指標同時成立時的歷史表現與目前狀態，輸出 data/combos.json
// 歷史統計使用 data/series 的每日數據並依實際延遲位移（每天只用當時拿得到的數據）
// 目前狀態使用 data/latest.json 的最新數值（資金費率用即時年化）
// 只作盤勢參考，不計入 CBS / CTS，也不改變倉位規則
import { readFile, writeFile } from 'node:fs/promises';

const ROOT = new URL('../', import.meta.url);
const J = async (p, fb) => { try { return JSON.parse(await readFile(new URL(p, ROOT), 'utf8')); } catch { return fb; } };
const D = 864e5, add = (d, n) => new Date(Date.parse(d) + n * D).toISOString().slice(0, 10);
const latest = await J('data/latest.json'), lag = latest.lags || {};
const price = await J('data/series/price.json', []);
const dates = price.map(x => x[0]).filter(d => d >= '2022-11-01'); const P = new Map(price);
const di = new Map(dates.map((d, i) => [d, i]));
const ser = async (name, L = 0) => { const m = new Map(); for (const r of await J(`data/series/${name}.json`, [])) m.set(add(r[0], L), r[1]); const o = new Map(); let last = null, li = -99; dates.forEach((d, i) => { if (m.has(d)) { last = m.get(d); li = i; } if (last != null && i - li <= 10) o.set(d, last); }); return o; };
const [fng, fund, oi, sth, prof, mvrv, dvol] = await Promise.all([ser('fng'), ser('funding', lag.funding || 8), ser('oi', lag.oi || 3), ser('sthrp', lag.sthrp || 7), ser('profit', lag.profit || 2), ser('mvrv', lag.mvrv || 7), ser('dvol')]);
const bt = await J('data/backtest.json', { fields: [], rows: [] });
const col = k => new Map(bt.rows.map(r => [r[0], r[bt.fields.indexOf(k)]]));
const idx = col('idx'), e30p = col('etf30p');
const pctRank = (arr, x) => arr.filter(v => v < x).length / arr.length * 100;

const F = {};
for (const d of dates) {
  const i = di.get(d), p = P.get(d); if (i < 90) continue;
  const f = fund.get(d), o = oi.get(d), win = dates.slice(i - 89, i + 1).map(x => oi.get(x)).filter(x => x != null);
  const dv = dvol.get(d), dvw = dates.slice(Math.max(0, i - 364), i + 1).map(x => dvol.get(x)).filter(x => x != null);
  F[d] = { r14: (p / P.get(dates[i - 14]) - 1) * 100, r30: (p / P.get(dates[i - 30]) - 1) * 100, fng: fng.get(d), fapr: f != null ? f * 3 * 365 * 100 : null,
    oiDD: o && win.length ? (1 - o / Math.max(...win)) * 100 : null, sthM: sth.get(d) ? p / sth.get(d) : null, prof: prof.get(d), mvrv: mvrv.get(d),
    dvP: dv != null && dvw.length > 200 ? pctRank(dvw, dv) : null, idx: idx.get(d), e30p: e30p.get(d) };
}
// 今天：換成最新的即時數值
const today = dates.at(-1), I = latest.indicators || {}, live = { ...(F[today] || {}) };
if (I.fng?.value != null) live.fng = +I.fng.value;
if (I.fundapr?.value != null) live.fapr = +I.fundapr.value;
if (I.sth_mvrv?.value != null) live.sthM = +I.sth_mvrv.value;
if (I.profit_supply?.value != null) live.prof = +I.profit_supply.value;
if (I.mvrv?.value != null) live.mvrv = +I.mvrv.value;
if (latest.index != null) live.idx = +latest.index;
if (I.etf_flow?.fields?.p30 != null) live.e30p = +I.etf_flow.fields.p30;
F[today] = live;

const f1 = v => v == null ? '—' : (+v).toFixed(1);
const COMBOS = [
  { id: 'deleverage', name: '槓桿出清', side: 'bottom', idea: '衍生品槓桿被大量平倉、價格已明顯下跌，賣壓的燃料用盡，常是中期低點的前兆。',
    conds: [['資金費率年化 ≤ 1%', x => x.fapr != null && x.fapr <= 1, x => `${f1(x.fapr)}%`], ['未平倉量比 90 日高點少 20% 以上', x => x.oiDD >= 20, x => `−${f1(x.oiDD)}%`], ['30 天跌幅超過 10%', x => x.r30 <= -10, x => `${f1(x.r30)}%`]] },
  { id: 'capitulation', name: '投降共振', side: 'bottom', idea: '短期持有者普遍虧損、過半籌碼被套、情緒極度恐懼同時出現，代表弱手正在認賠。',
    conds: [['短期持有者成本線 < 0.85', x => x.sthM < 0.85, x => x.sthM == null ? '—' : x.sthM.toFixed(2)], ['獲利籌碼 < 55%', x => x.prof < 55, x => `${f1(x.prof)}%`], ['恐懼貪婪 ≤ 20', x => x.fng <= 20, x => `${x.fng ?? '—'}`]] },
  { id: 'fearvalue', name: '情緒＋估值', side: 'bottom', idea: '極度恐懼發生在估值已偏低的位置，比單看恐懼貪婪更少假信號。',
    conds: [['恐懼貪婪 ≤ 15', x => x.fng <= 15, x => `${x.fng ?? '—'}`], ['MVRV Z-Score ≤ 1', x => x.mvrv <= 1, x => (x.mvrv ?? 0).toFixed(2)]] },
  { id: 'optpanic', name: '期權恐慌', side: 'bottom', idea: '隱含波動率急升到一年高位、價格兩週內急跌，期權市場在恐慌買保護，常出現短線反彈。',
    conds: [['DVOL 在一年 80% 百分位以上', x => x.dvP >= 80, x => `${f1(x.dvP)}%`], ['14 天跌幅超過 10%', x => x.r14 <= -10, x => `${f1(x.r14)}%`]] },
  { id: 'instcap', name: '機構投降＋低估', side: 'bottom', idea: 'ETF 大量贖回發生在週期低估區，機構賣壓接近尾聲；歷史上之後 30 天常再探底，90 天表現較好。',
    conds: [['ETF 30 日淨流量百分位 ≤ 10', x => x.e30p != null && x.e30p <= 10, x => `${f1(x.e30p)}%`], ['週期指數 < 20', x => x.idx < 20, x => f1(x.idx)]] },
];
const fwd = (d, n) => { const i = di.get(d); return i + n < dates.length ? (P.get(dates[i + n]) / P.get(d) - 1) * 100 : null; };
const mae = (d, n) => { const i = di.get(d); if (i + n >= dates.length) return null; let m = 0; for (let k = 1; k <= n; k++) m = Math.min(m, P.get(dates[i + k]) / P.get(d) - 1); return m * 100; };
const avg = a => { const v = a.filter(x => x != null); return v.length ? +(v.reduce((s, x) => s + x, 0) / v.length).toFixed(1) : null; };
const upR = a => { const v = a.filter(x => x != null); return v.length ? Math.round(v.filter(x => x > 0).length / v.length * 100) : null; };
const all = Object.keys(F).sort();
const base = { avg30: avg(all.map(d => fwd(d, 30))), avg90: avg(all.map(d => fwd(d, 90))), up90: upR(all.map(d => fwd(d, 90))) };
const out = [];
for (const c of COMBOS) {
  const ok = d => { try { return c.conds.every(([, f]) => !!f(F[d])); } catch { return false; } };
  const days = all.filter(ok);
  const ev = []; let li = -99; for (const d of days) { const i = di.get(d); if (i - li > 14) ev.push(d); li = i; }
  const x = F[today] || {};
  const conds = c.conds.map(([label, f, v]) => { let met = false; try { met = !!f(x); } catch {} return { label, met, value: v(x) }; });
  let since = null; if (conds.every(k => k.met)) { since = today; for (let i = dates.length - 2; i >= 0 && ok(dates[i]); i--) since = dates[i]; }
  const past = ev.filter(d => fwd(d, 30) != null);
  out.push({ id: c.id, name: c.name, side: c.side, idea: c.idea, conds, met: conds.filter(k => k.met).length, total: conds.length, active: conds.every(k => k.met), since,
    stats: { events: past.length, avg7: avg(past.map(d => fwd(d, 7))), avg30: avg(past.map(d => fwd(d, 30))), avg90: avg(past.map(d => fwd(d, 90))), up90: upR(past.map(d => fwd(d, 90))), mae30: avg(past.map(d => mae(d, 30))) },
    events: ev.map(d => ({ date: d, price: Math.round(P.get(d)), r30: fwd(d, 30) == null ? null : +fwd(d, 30).toFixed(1), r90: fwd(d, 90) == null ? null : +fwd(d, 90).toFixed(1) })) });
}
await writeFile(new URL('data/combos.json', ROOT), JSON.stringify({ generatedAt: new Date().toISOString(), date: today, from: all[0], base, combos: out,
  note: '過熱類組合（恐懼貪婪高＋資金費率高等）在 2022-11 以來的數據中，出現後價格多半繼續上漲，判斷頂部無效，暫不列入。' }, null, 1) + '\n');
console.log(`組合信號：${out.map(c => `${c.name} ${c.met}/${c.total}${c.active ? '（成立）' : ''}`).join('、')}`);
