// 每日數據庫：把每天快照裡「所有」指標與市場數據逐日存成序列（只增不刪），方便未來新指標、組合與研究直接調用。
// 很多即時數據（期權偏斜、PCR、基差、Coinbase 溢價、多空比、市佔率、清算地圖、套利年化…）來源不提供免費歷史，
// 只能靠每天自己記錄；這支程式就是那份紀錄。只寫入 data/db，不影響網站任何計算。
//
// data/db/indicators/<id>.json：[[快照日, 數值, 數據日期 asOf, 附加欄位 fields]]
// data/db/daily/<name>.json：[[快照日, {...}]]（系統狀態、組合信號、清算地圖、套利池、ETH）
// 第一次執行會從 data/history.json 與 data/archive/ 回補已有的每日快照。
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';

const ROOT = new URL('../', import.meta.url);
const read = async (p, fb) => { try { return JSON.parse(await readFile(new URL(p, ROOT), 'utf8')); } catch { return fb; } };
const write = (p, v) => writeFile(new URL(p, ROOT), JSON.stringify(v) + '\n');
await mkdir(new URL('data/db/indicators/', ROOT), { recursive: true });
await mkdir(new URL('data/db/daily/', ROOT), { recursive: true });

const IND = {}, DAY = {};
const put = (store, key, date, row) => { if (row == null) return; ((store[key] ||= new Map())).set(date, row); };
const slim = f => { if (!f || typeof f !== 'object') return null; const o = {}; for (const [k, v] of Object.entries(f)) if (v != null && (typeof v !== 'object' || Array.isArray(v) && v.length <= 20)) o[k] = v; return Object.keys(o).length ? o : null; };

// 舊快照（history.json）：只有數值
for (const h of await read('data/history.json', [])) {
  if (!h.date) continue;
  for (const [id, v] of Object.entries(h.values || {})) if (v != null) put(IND, id, h.date, [h.date, v, null, null]);
  put(DAY, 'system', h.date, [h.date, { price: h.btcPrice ?? null, cbs: h.cbs ?? null, cts: h.cts ?? null, cbsConfirm: h.cbsConfirm ?? null, ctsConfirm: h.ctsConfirm ?? null, idx: h.idx ?? null, cbsLevel: h.cbsLevel ?? null, ctsLevel: h.ctsLevel ?? null, action: h.action ?? null }]);
}
// 完整快照：每日封存（data/archive/YYYY/*.json）與今天的 latest.json
const snaps = [];
try { for (const y of await readdir(new URL('data/archive/', ROOT))) for (const f of (await readdir(new URL(`data/archive/${y}/`, ROOT))).filter(f => f.endsWith('.json')).sort()) snaps.push(await read(`data/archive/${y}/${f}`, null)); } catch {}
const latest = await read('data/latest.json', null), liqNow = await read('data/liqmap.json', null), combos = await read('data/combos.json', null);
if (latest?.date) snaps.push({ date: latest.date, latest, liqmap: liqNow, combos });
for (const s of snaps.filter(Boolean)) {
  const L = s.latest, d = s.date || L?.date; if (!L || !d) continue;
  for (const [id, x] of Object.entries(L.indicators || {})) if (x && x.value != null) put(IND, id, d, [d, x.value, x.asOf ?? null, slim(x.fields)]);
  const prev = DAY.system?.get(d)?.[1] || {};
  put(DAY, 'system', d, [d, { ...prev, price: L.btcPrice ?? prev.price ?? null, idx: L.index ?? prev.idx ?? null, zone: L.indexZone ?? null, signals: L.signals?.active?.map(a => a.label) ?? null, cycleBuy: L.signals?.cycleBuy?.label ?? null }]);
  if (L.ethPrice != null) put(DAY, 'eth', d, [d, { price: L.ethPrice }]);
  if (L.arb) put(DAY, 'arb', d, [d, { funding: L.arb.funding ?? null, fundingMedian: L.arb.fundingMedian ?? null, basis: L.arb.basis ?? null, basisDays: L.arb.basisDays ?? null, best: L.arb.best ?? null, venues: (L.arb.venues || []).map(v => ({ ...v })).slice(0, 30) }]);
  const lm = s.liqmap;
  if (lm) put(DAY, 'liqmap', d, [d, { method: lm.method ?? null, hours: lm.hours ?? null, price: lm.price ?? null, topShort: lm.topShort?.slice(0, 5) ?? null, topLong: lm.topLong?.slice(0, 5) ?? null, exchanges: lm.exchanges ?? null, near5: lm.near5 ?? null, near10: lm.near10 ?? null, realized: lm.realized ? { h24: lm.realized.h24 ?? null, d7: lm.realized.d7 ?? null } : null, buckets: lm.buckets?.filter(b => b.long || b.short) ?? null }]);
  const cb = s.combos;
  if (cb?.combos) put(DAY, 'combos', d, [d, Object.fromEntries(cb.combos.map(c => [c.id, { met: c.met, total: c.total, active: !!c.active, since: c.since ?? null }]))]);
}

// 寫入：與既有檔案合併（同一天以最新快照為準，其他日子永不刪除）
let nInd = 0, nRows = 0;
for (const [store, dir] of [[IND, 'indicators'], [DAY, 'daily']]) for (const [key, m] of Object.entries(store)) {
  const path = `data/db/${dir}/${key}.json`, cur = new Map((await read(path, [])).map(r => [r[0], r]));
  for (const [d, r] of m) cur.set(d, r);
  const out = [...cur.values()].sort((a, b) => a[0].localeCompare(b[0]));
  await write(path, out); nInd++; nRows += out.length;
}
console.log(`每日數據庫：${Object.keys(IND).length} 項指標、${Object.keys(DAY).length} 類每日狀態，共 ${nRows} 筆`);
