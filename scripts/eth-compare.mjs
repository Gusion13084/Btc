// 比較：同一套 BTC 信號下，只買 BTC／照手冊比例買 ETH／ETH/BTC 濾網 三種配置的表現
import { readFile, writeFile } from 'node:fs/promises';
import { runPlan } from '../assets/scoring.js';
const ROOT = new URL('../', import.meta.url);
const J = async p => JSON.parse(await readFile(new URL(p, ROOT), 'utf8'));
const UA = { 'User-Agent': 'btc-cycle-radar/2.0', Accept: 'application/json' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function daily(inst, since) {
  const out = new Map(); let after = '';
  for (let k = 0; k < 40; k++) {
    const r = await fetch(`https://www.okx.com/api/v5/market/history-candles?instId=${inst}&bar=1Dutc&limit=100${after ? `&after=${after}` : ''}`, { headers: UA });
    const j = await r.json(); const d = j.data || [];
    if (!d.length) break;
    for (const c of d) out.set(new Date(+c[0]).toISOString().slice(0, 10), +c[4]);
    after = d[d.length - 1][0];
    if (new Date(+after).toISOString().slice(0, 10) < since) break;
    await sleep(150);
  }
  return out;
}
const config = await J('config/indicators.json');
const bt = await J('data/backtest.json');
const rows = bt.rows.map(r => Object.fromEntries(bt.fields.map((f, i) => [f, r[i]])));
const plan = runPlan(config, rows);
const ledger = plan.ledger;
const BTC = await daily('BTC-USDT', '2018-06-01'), ETH = await daily('ETH-USDT', '2018-06-01');
console.log(`OKX 日線：BTC ${BTC.size} 天、ETH ${ETH.size} 天`);
const dates = rows.map(r => r.date).filter(d => BTC.has(d) && ETH.has(d));
// ETH/BTC 近 4 年百分位
const allD = [...ETH.keys()].filter(d => BTC.has(d)).sort();
const ratio = new Map(allD.map(d => [d, ETH.get(d) / BTC.get(d)]));
const pctOf = d => { const i = allD.indexOf(d); const w = allD.slice(Math.max(0, i - 1459), i + 1).map(x => ratio.get(x)); const v = ratio.get(d); return w.filter(x => x < v).length / w.length * 100; };
const batches = config.levels.cbs.filter(l => l.batch).map(l => l.batch);
const splitFor = (label, mode, d) => {
  const b = batches.find(x => x.label === label) || { btc: 65 };
  if (mode === 'btc') return 1;
  if (mode === 'fixed') return b.btc / 100;
  return pctOf(d) <= 30 ? b.btc / 100 : 1;
};
const apy = Math.pow(1 + (config.position?.poolApy ?? 0) / 100, 1 / 365);
function sim(mode) {
  const d0 = dates[0], start = (config.position?.start ?? 30);
  const s0 = mode === 'btc' ? 1 : mode === 'fixed' ? 0.65 : (pctOf(d0) <= 30 ? 0.65 : 1);
  let b = start * s0 / BTC.get(d0), e = start * (1 - s0) / ETH.get(d0), cash = 100 - start;
  let peak = 0, mdd = 0; const ev = new Map(ledger.map(l => [l.date, l])); const curve = [];
  let ethBuys = 0;
  for (const d of dates) {
    cash *= apy;
    const pb = BTC.get(d), pe = ETH.get(d);
    const l = ev.get(d);
    if (l) {
      const spot = b * pb + e * pe, total = spot + cash, want = total * l.target / 100;
      if (l.type === 'buy' && spot < want) { const amt = Math.min(cash, want - spot), sb = splitFor(l.label, mode, d); b += amt * sb / pb; e += amt * (1 - sb) / pe; cash -= amt; if (sb < 1) ethBuys++; }
      if (l.type === 'sell' && spot > want) { const amt = spot - want, k = amt / spot; b *= 1 - k; e *= 1 - k; cash += amt; }
    }
    const v = b * pb + e * pe + cash; peak = Math.max(peak, v); mdd = Math.max(mdd, 1 - v / peak);
    curve.push([d, +v.toFixed(2)]);
  }
  const v = curve.at(-1)[1], yrs = (Date.parse(dates.at(-1)) - Date.parse(d0)) / 3.156e10;
  return { final: +v.toFixed(1), cagr: +((Math.pow(v / 100, 1 / yrs) - 1) * 100).toFixed(1), mdd: +(mdd * 100).toFixed(1), ethBuys, curve };
}
const hold = (() => { const d0 = dates[0]; let peak = 0, mdd = 0; const u = 100 / BTC.get(d0); for (const d of dates) { const v = u * BTC.get(d); peak = Math.max(peak, v); mdd = Math.max(mdd, 1 - v / peak); } const v = u * BTC.get(dates.at(-1)); const yrs = (Date.parse(dates.at(-1)) - Date.parse(d0)) / 3.156e10; return { final: +v.toFixed(1), cagr: +((Math.pow(v / 100, 1 / yrs) - 1) * 100).toFixed(1), mdd: +(mdd * 100).toFixed(1) }; })();
const res = { from: dates[0], to: dates.at(-1), A_btcOnly: sim('btc'), B_fixed: sim('fixed'), C_filter: sim('filter'), hold100btc: hold,
  ethbtc: { start: +ratio.get(dates[0]).toFixed(4), end: +ratio.get(dates.at(-1)).toFixed(4) },
  buys: ledger.filter(l => l.type === 'buy').map(l => ({ date: l.date, label: l.label, ethbtcPct: allD.includes(l.date) ? +pctOf(l.date).toFixed(1) : null })) };
for (const k of ['A_btcOnly', 'B_fixed', 'C_filter']) { const r = res[k]; console.log(`${k}: 期末 ${r.final}（起始 100）年化 ${r.cagr}% 最大回撤 ${r.mdd}% ETH 買入次數 ${r.ethBuys}`); }
console.log(`參考 100% 持有 BTC：期末 ${hold.final} 年化 ${hold.cagr}% 最大回撤 ${hold.mdd}%`);
console.log(`期間 ${res.from} → ${res.to}，ETH/BTC ${res.ethbtc.start} → ${res.ethbtc.end}`);
console.log('買入信號時的 ETH/BTC 4 年百分位：' + JSON.stringify(res.buys));
for (const k of ['A_btcOnly', 'B_fixed', 'C_filter']) { const c = res[k].curve; console.log(k + ' 年末值：' + c.filter((x, i) => x[0].endsWith('-12-31') || i === c.length - 1).map(x => `${x[0].slice(0, 4)}:${x[1]}`).join(' ')); }
await writeFile(new URL('data/eth-compare.json', ROOT), JSON.stringify({ ...res, A_btcOnly: { ...res.A_btcOnly, curve: undefined }, B_fixed: { ...res.B_fixed, curve: undefined }, C_filter: { ...res.C_filter, curve: undefined } }, null, 1));
