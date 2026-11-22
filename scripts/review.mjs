// 判斷檢討：每天快照後執行，輸出 data/review.json
// 1) 日報判斷紀錄（data/journal/*.json）：每天追蹤，依日 K 高低點判斷先碰到目標價或失效價
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
// 計分方式（2026-11-22 起，使用者核准）：
// - 有效天數由日報自行決定（horizonDays，1–14 天，預設 7）。
// - 用 UTC 日 K 的最高／最低價（data/series/ohlc.json）逐日檢查「先碰到哪一邊」：
//   偏多／偏空：先到目標價＝成功、先到失效價＝失誤；期限內都沒碰到＝未達（另記到期漲跌）。
//   中性：期限內沒有碰到上下失效價＝成功，碰到＝失誤。
//   同一天同時碰到目標與失效價，無法分辨先後＝同日觸及（不計入命中率）。
// - 沒有寫目標價的偏多／偏空（舊紀錄），到期時沿用舊規則：漲／跌超過 2% 算成功。
// - 另記最大有利幅度（MFE）與最大不利幅度（MAE），以及 1／3 天與到期時的方向。
const ohlc = new Map((await read('data/series/ohlc.json', [])).map(r => [r[0], r]));
const hlAt = d => { const o = ohlc.get(d); if (o) return { hi: o[1], lo: o[2], close: o[3], exact: true }; const v = price.get(d); return v ? { hi: v, lo: v, close: v, exact: false } : null; };
const num = v => v == null || v === '' || !Number.isFinite(+v) ? null : +v;
const judge = j => {
  const p0 = j.price || pAt(j.date);
  const h = Math.min(14, Math.max(1, Math.round(+j.horizonDays || H)));
  const end = addDays(j.date, h), last = end < today ? end : today;
  const inv = j.invalidation || {}, up = num(inv.above), dn = num(inv.below);
  const target = num(typeof j.target === 'object' && j.target ? j.target.price : j.target);
  const isUp = j.bias === '偏多', isDn = j.bias === '偏空';
  const base = { ...j, horizonDays: h, target, endDate: end };
  if (!p0) return { ...base, matured: false, status: '進行中' };
  let status = null, resolvedAt = null, hi = -Infinity, lo = Infinity, invalidated = false, exact = true, days = 0;
  for (let d = j.date; d <= last; d = addDays(d, 1)) {
    const x = hlAt(d); if (!x) continue; days++; if (!x.exact) exact = false;
    hi = Math.max(hi, x.hi); lo = Math.min(lo, x.lo);
    const invHit = isUp ? dn != null && x.lo <= dn : isDn ? up != null && x.hi >= up : (up != null && x.hi >= up) || (dn != null && x.lo <= dn);
    const tgtHit = target != null && (isUp ? x.hi >= target : isDn ? x.lo <= target : false);
    if (invHit) invalidated = true;
    if (!status) {
      if (invHit && tgtHit) status = '同日觸及';
      else if (tgtHit) status = '成功';
      else if (invHit) status = '失誤';
      if (status) resolvedAt = d;
    }
  }
  const pClose = d => (d <= today ? (hlAt(d)?.close ?? pAt(d)) : null);
  const retTo = d => { const p = pClose(d); return p ? r1((p / p0 - 1) * 100) : null; };
  const matured = end <= today;
  const ret = matured ? retTo(end) : retTo(today);
  if (!status && matured) {
    if (isUp || isDn) status = target != null ? '未達' : ((isUp ? ret > 2 : ret < -2) ? '成功' : '失誤');
    else status = '成功';
    resolvedAt = end;
  }
  if (!status) status = '進行中';
  const fav = !days ? null : isUp ? (hi / p0 - 1) * 100 : isDn ? (1 - lo / p0) * 100 : null;
  const adv = !days ? null : isUp ? (1 - lo / p0) * 100 : isDn ? (hi / p0 - 1) * 100 : null;
  const dir = r => r == null || !(isUp || isDn) ? null : isUp ? r > 0 : r < 0;
  const r1d = retTo(addDays(j.date, 1)), r3d = retTo(addDays(j.date, 3));
  return {
    ...base, matured: status !== '進行中', status, resolvedAt, daysToResolve: resolvedAt ? Math.round((Date.parse(resolvedAt) - Date.parse(j.date)) / D) : null,
    hit: status === '成功' ? true : status === '失誤' || status === '未達' ? false : null,
    ret7: ret, ret1: r1d, ret3: r3d, dir1: dir(r1d), dir3: dir(r3d), dirH: matured ? dir(ret) : null,
    hi: days ? hi : null, lo: days ? lo : null, mfe: r1(fav), mae: r1(adv), invalidated, intraday: exact,
  };
};
const JJ = J.map(judge), M = JJ.filter(j => j.matured), S2 = M.filter(j => j.hit != null);
const rate = a => { const b = a.filter(x => x.hit != null); return b.length ? r1(b.filter(x => x.hit).length / b.length * 100) : null; };
const group = (a, key) => Object.fromEntries([...new Set(a.map(key))].map(k => [k, { n: a.filter(x => key(x) === k && x.hit != null).length, hitRate: rate(a.filter(x => key(x) === k)) }]));
const dirRate = k => { const a = JJ.filter(x => x[k] != null); return { n: a.length, rate: a.length ? r1(a.filter(x => x[k]).length / a.length * 100) : null }; };
const avg = a => a.length ? r1(a.reduce((s, v) => s + v, 0) / a.length) : null;
const byInd = {};
for (const j of M) for (const rz of j.reasons || []) { if (!rz.id) continue; (byInd[rz.id] ||= []).push(j); }
const outcomes = Object.fromEntries(['成功', '失誤', '未達', '同日觸及', '進行中'].map(k => [k, JJ.filter(x => x.status === k).length]));
const journal = {
  method: 'first-touch',
  total: JJ.length, matured: M.length, scored: S2.length, hitRate: rate(M), outcomes,
  invalidatedRate: M.length ? r1(M.filter(x => x.invalidated).length / M.length * 100) : null,
  byBias: group(M, x => x.bias), byConfidence: group(M, x => x.confidence || '—'),
  byHorizon: group(M, x => x.horizonDays + ' 天'),
  direction: { d1: dirRate('dir1'), d3: dirRate('dir3'), horizon: dirRate('dirH') },
  avgMfe: avg(M.filter(x => x.mfe != null).map(x => x.mfe)), avgMae: avg(M.filter(x => x.mae != null).map(x => x.mae)),
  avgDaysToResolve: avg(M.filter(x => x.status === '成功' || x.status === '失誤').map(x => x.daysToResolve)),
  byIndicator: Object.entries(byInd).map(([id, a]) => ({ id, name: config.indicators.find(d => d.id === id)?.name || id, n: a.filter(x => x.hit != null).length, hitRate: rate(a) })).sort((a, b) => b.n - a.n),
  recent: JJ.slice(-21).reverse().map(j => ({ date: j.date, bias: j.bias, confidence: j.confidence, price: j.price, summary: j.summary || '', horizonDays: j.horizonDays, endDate: j.endDate, target: j.target, invalidation: j.invalidation || null,
    status: j.status, resolvedAt: j.resolvedAt ?? null, daysToResolve: j.daysToResolve ?? null, matured: j.matured, ret7: j.ret7 ?? null, ret1: j.ret1 ?? null, ret3: j.ret3 ?? null,
    mfe: j.mfe ?? null, mae: j.mae ?? null, hi: j.hi ?? null, lo: j.lo ?? null, hit: j.hit ?? null, invalidated: j.invalidated ?? null, intraday: j.intraday ?? null })),
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
console.log(`判斷檢討：日報判斷 ${journal.total} 筆（已結算 ${journal.matured}，成功 ${outcomes['成功']}・失誤 ${outcomes['失誤']}・未達 ${outcomes['未達']}・進行中 ${outcomes['進行中']}，命中率 ${journal.hitRate ?? '—'}%）・信號樣本 ${signals.length}・系統目前回撤 ${system?.drawdownNow}%、現貨 ${system?.spotWeight}%・操作點位變動 ${ledgerChanges.length} 筆`);
