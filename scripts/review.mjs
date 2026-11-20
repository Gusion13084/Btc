// 判斷檢討：每天快照後執行，輸出 data/review.json
// 1) 日報判斷紀錄（data/journal/*.json）：7 天後對照實際走勢計分
// 2) 指標信號表現：每日快照中各指標的判讀區間，之後 7 天 BTC 的平均漲跌
// 3) 系統表現與回撤監控：依目前規則重算的倉位曲線、目前回撤、現貨比例
// 4) 歷史信號穩定性：和上一次相比，回測中的操作點位有沒有被改寫
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { runPlan } from '../assets/scoring.js';

const ROOT = new URL('../', import.meta.url);
const read = async (p, fb) => { try { return JSON.parse(await readFile(new URL(p, ROOT), 'utf8')); } catch { return fb; } };
const D = 864e5, addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * D).toISOString().slice(0, 10);
const r1 = v => v == null || !Number.isFinite(v) ? null : +v.toFixed(1);

const config = await read('config/indicators.json');
const price = new Map(await read('data/series/price.json', []));
const history = (await read('data/history.json', [])).filter(h => !h.legacy);
const bt = await read('data/backtest.json', { fields: [], rows: [] });
const prev = await read('data/review.json', {});
const today = [...price.keys()].sort().at(-1);
const pAt = d => { for (let k = 0; k < 4; k++) { const v = price.get(addDays(d, k)); if (v) return v; } return null; };
const H = 7;

// ---------- 1) 判斷紀錄 ----------
let files = []; try { files = (await readdir(new URL('data/journal/', ROOT))).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort(); } catch {}
const J = [];
for (const f of files) { const j = await read('data/journal/' + f, null); if (j?.date && j.bias) J.push(j); }
const judge = j => {
  const p0 = j.price || pAt(j.date), end = addDays(j.date, j.horizonDays || H);
  if (!p0 || end > today) return { ...j, matured: false };
  const p1 = pAt(end), path = []; for (let d = j.date; d <= end; d = addDays(d, 1)) { const v = price.get(d); if (v) path.push(v); }
  const ret = (p1 / p0 - 1) * 100, hi = Math.max(...path), lo = Math.min(...path);
  const ok = j.bias === '偏多' ? ret > 2 : j.bias === '偏空' ? ret < -2 : Math.abs(ret) <= 5;
  const inval = j.invalidation || {};
  const invalidated = (j.bias === '偏多' && inval.below && lo <= inval.below) || (j.bias === '偏空' && inval.above && hi >= inval.above) || (j.bias === '中性' && ((inval.below && lo <= inval.below) || (inval.above && hi >= inval.above)));
  return { ...j, matured: true, ret7: r1(ret), hi, lo, hit: ok, invalidated: !!invalidated };
};
const JJ = J.map(judge), M = JJ.filter(j => j.matured);
const rate = a => a.length ? r1(a.filter(x => x.hit).length / a.length * 100) : null;
const group = (a, key) => Object.fromEntries([...new Set(a.map(key))].map(k => [k, { n: a.filter(x => key(x) === k).length, hitRate: rate(a.filter(x => key(x) === k)) }]));
const byInd = {};
for (const j of M) for (const rz of j.reasons || []) { if (!rz.id) continue; (byInd[rz.id] ||= []).push(j); }
const journal = {
  total: JJ.length, matured: M.length, hitRate: rate(M), invalidatedRate: M.length ? r1(M.filter(x => x.invalidated).length / M.length * 100) : null,
  byBias: group(M, x => x.bias), byConfidence: group(M, x => x.confidence || '—'),
  byIndicator: Object.entries(byInd).map(([id, a]) => ({ id, name: config.indicators.find(d => d.id === id)?.name || id, n: a.length, hitRate: rate(a) })).sort((a, b) => b.n - a.n),
  recent: JJ.slice(-14).reverse().map(j => ({ date: j.date, bias: j.bias, confidence: j.confidence, price: j.price, summary: j.summary || '', matured: j.matured, ret7: j.ret7 ?? null, hit: j.hit ?? null, invalidated: j.invalidated ?? null })),
};

// ---------- 2) 指標信號表現（依每日快照的判讀區間） ----------
const signals = [];
const fwd = d => { const a = pAt(d), b = addDays(d, H) <= today ? pAt(addDays(d, H)) : null; return a && b ? (b / a - 1) * 100 : null; };
for (const def of config.indicators.filter(d => d.bands && !d.bandField)) {
  const by = {};
  for (const h of history) {
    const v = h.values?.[def.id]; if (v == null) continue;
    const b = def.bands.find(x => x.to == null || +v < x.to); const f = fwd(h.date); if (!b || f == null) continue;
    (by[b.label] ||= { tone: b.tone, rets: [] }).rets.push(f);
  }
  for (const [label, x] of Object.entries(by)) signals.push({ id: def.id, name: def.name, band: label, tone: x.tone, n: x.rets.length, avg7: r1(x.rets.reduce((s, v) => s + v, 0) / x.rets.length), up7: r1(x.rets.filter(v => v > 0).length / x.rets.length * 100) });
}
// 方向一致性：偏多色調的區間之後是否真的上漲、偏空色調之後是否下跌
const toned = signals.filter(s => s.tone === 'buy' || s.tone === 'sell' || s.tone === 'warn');
const agree = toned.filter(s => s.n >= 3).map(s => ({ ...s, agree: s.tone === 'buy' ? s.avg7 > 0 : s.avg7 < 0 }));

// ---------- 3) 系統表現與回撤監控 ----------
const rows = bt.rows.map(r => Object.fromEntries(bt.fields.map((f, i) => [f, r[i]])));
let system = null, ledger = [];
if (rows.length) {
  const plan = runPlan(config, rows); ledger = plan.ledger.map(l => ({ date: l.date, type: l.type, label: l.label, price: Math.round(l.price), target: l.target }));
  const ev = new Map(); for (const l of plan.ledger) (ev.get(l.date) || ev.set(l.date, []).get(l.date)).push(l);
  const apy = Math.pow(1 + (config.position?.poolApy ?? 8) / 100, 1 / 365), st = config.position?.start ?? 30;
  let u = st / 100 / rows[0].price, cash = 1 - st / 100, peak = 0, mdd = 0, mddAt = null;
  for (const r of rows) {
    cash *= apy;
    for (const l of ev.get(r.date) || []) { const sp = u * r.price, t = sp + cash, w = t * l.target / 100; let m = 0;
      if (l.type === 'buy' && sp < w) m = Math.min(cash, w - sp); if (l.type === 'sell' && sp > w) m = -(sp - w); u += m / r.price; cash -= m; }
    const v = u * r.price + cash; if (v > peak) peak = v; const dd = 1 - v / peak; if (dd > mdd) { mdd = dd; mddAt = r.date; }
  }
  const last = rows.at(-1), v = u * last.price + cash;
  system = { from: rows[0].date, multiple: +v.toFixed(3), maxDrawdown: r1(mdd * 100), maxDrawdownAt: mddAt, drawdownNow: r1((1 - v / peak) * 100), spotWeight: r1(u * last.price / v * 100), price: last.price };
}
// ---------- 4) 歷史信號穩定性 ----------
const key = l => `${l.date}|${l.type}|${l.target}`;
const was = new Map((prev.ledger || []).map(l => [key(l), l])), now = new Map(ledger.map(l => [key(l), l]));
const ledgerChanges = [
  ...[...now.values()].filter(l => !was.has(key(l)) && prev.ledger).map(l => ({ change: '新增', ...l })),
  ...[...was.values()].filter(l => !now.has(key(l))).map(l => ({ change: '消失', ...l })),
];
const changeLog = [...(ledgerChanges.length ? [{ date: today, changes: ledgerChanges }] : []), ...(prev.changeLog || [])].slice(0, 30);

const out = { generatedAt: new Date().toISOString(), date: today, horizonDays: H, journal, signals, agreement: { n: agree.length, agreeRate: agree.length ? r1(agree.filter(x => x.agree).length / agree.length * 100) : null, items: agree }, system, ledger, ledgerChanges, changeLog };
await writeFile(new URL('data/review.json', ROOT), JSON.stringify(out, null, 1) + '\n');
console.log(`判斷檢討：日報判斷 ${journal.total} 筆（已到期 ${journal.matured}，命中率 ${journal.hitRate ?? '—'}%）・信號樣本 ${signals.length}・系統目前回撤 ${system?.drawdownNow}%、現貨 ${system?.spotWeight}%・操作點位變動 ${ledgerChanges.length} 筆`);
