// BTC 週期雷達：靜態網站＋Telegram 推播
// - 網頁與數據檔由 assets 直接提供（不經過這支程式）
// - 每 15 分鐘的排程：讀網站自己的數據檔（不算外部 API），只呼叫一次 Coinbase 取現價
// - 推播條件：每日快照（指標變化摘要）、價格急漲急跌、穿越 50 週均線、打到最大清算區、快照逾時未更新
// - 狀態（上次快照、近 26 小時價格、冷卻時間）存在 Durable Object
// 需要在 Cloudflare 設定兩個 Secret：TG_BOT_TOKEN、TG_CHAT_ID
const SITE = 'https://btc-radar.btcradar69.workers.dev/';
const H = 36e5;

export class AlertState {
  constructor(ctx) { this.ctx = ctx; }
  async fetch(req) {
    if (req.method === 'POST') { await this.ctx.storage.put('s', await req.json()); return new Response('ok'); }
    return Response.json((await this.ctx.storage.get('s')) || {});
  }
}

const usd = v => '$' + Math.round(v).toLocaleString('en-US');
const mUsd = v => v >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : `$${Math.round(v / 1e6)}M`;
const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const bandOf = (def, ind) => {
  if (!def?.bands || !ind) return null;
  const v = def.bandField ? ind.fields?.[def.bandField] : ind.value;
  if (v == null || !Number.isFinite(+v)) return null;
  return def.bands.find(b => b.to == null || +v < b.to) || null;
};
const bandOfValue = (def, v) => def?.bands && !def.bandField && v != null && Number.isFinite(+v) ? def.bands.find(b => b.to == null || +v < b.to) : null;

async function asset(env, path) {
  const r = await env.ASSETS.fetch(new Request(SITE + path));
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return r.json();
}
async function tg(env, text) {
  const r = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: env.TG_CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  if (!r.ok) throw new Error(`Telegram ${r.status} ${(await r.text()).slice(0, 200)}`);
}
async function spot() {
  try { const j = await (await fetch('https://api.coinbase.com/v2/prices/BTC-USD/spot')).json(); const v = +j.data.amount; if (v > 0) return v; } catch {}
  const j = await (await fetch('https://api.kraken.com/0/public/Ticker?pair=XBTUSD')).json();
  return +Object.values(j.result)[0].c[0];
}

// 每日快照摘要：與前一筆快照比較
// 推播狀態的摘要：決策、分數、各指標判讀區間
function signature(latest, hist, config) {
  const cur = hist.at(-1) || {};
  const bands = {};
  for (const def of config.indicators) { const b = bandOf(def, latest.indicators?.[def.id]); if (b) bands[def.name] = b.label; }
  return { date: cur.date, decision: cur.decision?.title || '', floor: cur.decision?.target?.floor ?? null, cap: cur.decision?.target?.cap ?? null, cbs: cur.cbs, cts: cur.cts, cbsLevel: cur.cbsLevel, ctsLevel: cur.ctsLevel, bands, items: cur.items || {}, signals: (cur.signals || []).map(x => x.label) };
}
function sameDayUpdate(a, b) {
  const L = [], names = {};
  if (a.decision !== b.decision) L.push(`⚠️ <b>操作建議改變</b>：${esc(a.decision)} → <b>${esc(b.decision)}</b>`);
  if (a.floor !== b.floor || a.cap !== b.cap) L.push(`建議現貨：${b.floor != null ? `至少 ${b.floor}%` : ''}${b.cap != null ? `${b.floor != null ? '、' : ''}最多 ${b.cap}%` : ''}`);
  for (const x of b.signals || []) if (!(a.signals || []).includes(x)) L.push(`🟢 <b>進出場訊號成立</b>：${esc(x)}`);
  for (const x of a.signals || []) if (!(b.signals || []).includes(x)) L.push(`⚪ 訊號結束：${esc(x)}`);
  if (a.cbs !== b.cbs) L.push(`抄底 CBS ${a.cbs} → <b>${b.cbs}</b> 分（${esc(b.cbsLevel)}）`);
  if (a.cts !== b.cts) L.push(`止盈 CTS ${a.cts} → <b>${b.cts}</b> 分（${esc(b.ctsLevel)}）`);
  for (const [id, lb] of Object.entries(b.bands)) if (a.bands?.[id] && a.bands[id] !== lb) L.push(`・${esc(id)}：${esc(a.bands[id])} → <b>${esc(lb)}</b>`);
  return L.length ? `🔄 <b>BTC 週期雷達・${b.date} 快照更新</b>\n與今天稍早的推播相比：\n${L.join('\n')}\n\n<a href="${SITE}">開啟網站</a>` : null;
}
// 全部指標狀態篩選：各面向偏多／偏空數量、需要留意的極端狀態、成立中的組合信號
const TIER_NAMES = [['core', '估值核心'], ['aux', '輔助確認'], ['short', '短線盤勢'], ['macro', '總體流動性'], ['supply', '供給與大戶']];
function overview(latest, cur, config, combos) {
  const rows = [], hot = [];
  for (const [tier, nm] of TIER_NAMES) {
    let up = 0, dn = 0, mid = 0;
    for (const def of config.indicators.filter(d => (d.tier || 'core') === tier)) {
      const ind = latest.indicators?.[def.id]; if (!ind || ind.value == null || ind.ok === false) continue;
      const b = bandOf(def, ind), it = cur.items?.[def.id] || [], pct = ind.fields?.p;
      let tone = 'mid';
      if (tier === 'core' || tier === 'aux') tone = it[0] > 0 ? 'up' : it[1] > 0 ? 'dn' : b ? (b.tone === 'buy' ? 'up' : b.tone === 'sell' || b.tone === 'warn' ? 'dn' : 'mid') : 'mid';
      else if (b) tone = b.tone === 'buy' ? 'up' : b.tone === 'sell' || b.tone === 'warn' ? 'dn' : 'mid';
      tone === 'up' ? up++ : tone === 'dn' ? dn++ : mid++;
      // 需要留意：強烈的判讀區間，或近 4 年最低／最高 5%
      const strong = b && b.tone !== 'neutral' && /極|恐慌|大幅|過熱|擁擠|急|快速|大量/.test(b.label);
      if (strong || (pct != null && (pct <= 5 || pct >= 95))) hot.push({ s: (strong ? 2 : 0) + (pct != null && (pct <= 5 || pct >= 95) ? 1 : 0), t: `・${esc(def.name)}：${b ? esc(b.label) : ''}${pct != null && (pct <= 5 || pct >= 95) ? `${b ? '・' : ''}近 4 年${pct <= 5 ? '最低' : '最高'} ${Math.max(1, Math.round(pct <= 5 ? pct : 100 - pct))}%` : ''}` });
    }
    if (up + dn + mid) rows.push(`・${nm}：偏多 ${up}・偏空 ${dn}・中性 ${mid}`);
  }
  const on = (combos?.combos || []).filter(c => c.active).map(c => c.name);
  const near = (combos?.combos || []).filter(c => !c.active && c.met >= c.total - 1 && c.met > 0).map(c => `${c.name}（${c.met}/${c.total}）`);
  let t = `\n<b>指標狀態總覽</b>（偏多＝低估或順風，偏空＝過熱或逆風）\n${rows.join('\n')}`;
  if (on.length || near.length) t += `\n\n<b>組合信號</b>\n${on.length ? `・成立：${on.map(esc).join('、')}` : ''}${on.length && near.length ? '\n' : ''}${near.length ? `・接近成立：${near.map(esc).join('、')}` : ''}`;
  if (hot.length) t += `\n\n<b>需要留意</b>\n${hot.sort((a, b) => b.s - a.s).slice(0, 6).map(x => x.t).join('\n')}`;
  return t;
}
// 進出場訊號（不分進場時間）：新成立放最上面，成立中與本輪週期列在下方
const SG = { buy: '現貨至少', sell: '現貨降到', trend: '現貨上限' };
function signalBlock(latest, cur, prev) {
  const on = cur.signals || [], was = new Set((prev?.signals || []).map(x => x.label));
  const fresh = on.filter(x => !was.has(x.label)), ended = (prev?.signals || []).filter(x => !on.some(y => y.label === x.label));
  const head = fresh.map(x => `🟢 <b>新訊號成立：${esc(x.label)}</b> → ${SG[x.side]} ${x.target}%${x.via === 'index' ? '（機構資金路線）' : ''}`);
  const g = latest.signals || {}, L = [];
  if (on.length) L.push(...on.filter(x => was.has(x.label)).map(x => `・${esc(x.label)} 成立中（${x.since} 起）→ ${SG[x.side]} ${x.target}%`));
  if (ended.length) L.push(`・已結束：${ended.map(x => esc(x.label)).join('、')}`);
  if (!on.length) L.push('・目前沒有成立中的訊號');
  if (g.cycleBuy) L.push(`・本輪抄底最高到${esc(g.cycleBuy.label)}（${g.cycleBuy.start} 起，${usd(g.cycleBuy.price)}）→ 現貨參考至少 ${g.cycleBuy.target}%`);
  if (g.cycleSell) L.push(`・本輪減倉最高到${esc(g.cycleSell.label)}（${g.cycleSell.start} 起）→ 現貨參考不超過 ${g.cycleSell.target}%`);
  const near = (g.progress || []).filter(x => !x.active).slice(0, 1).concat((g.progress || []).filter(x => !x.active && x.side === 'sell').slice(0, 1));
  if (!on.length && near.length) L.push(...near.map(x => `・${esc(x.label)}進度：${x.progress.map(esc).join('；')}`));
  return { head, body: `\n<b>進出場訊號</b>（不分進場時間，對照自己的倉位）\n${L.join('\n')}` };
}
function digest(latest, hist, config, combos) {
  const cur = hist.at(-1), prev = hist.filter(h => h.date < cur.date && !h.legacy).at(-1);
  const defs = config.indicators, L = [];
  const d = cur.decision || {}, pd = prev?.decision || {};
  const changed = prev && pd.title && pd.title !== d.title;
  const sg = signalBlock(latest, cur, prev);
  L.push(...sg.head);
  L.push(`${changed ? '⚠️ <b>操作建議改變</b>：' + esc(pd.title) + ' → ' : '📌 '}<b>${esc(d.title)}</b>`);
  if (d.target) L.push(`建議現貨：${d.target.floor != null ? `至少 ${d.target.floor}%` : ''}${d.target.cap != null ? `${d.target.floor != null ? '、' : ''}最多 ${d.target.cap}%` : ''}`);
  L.push(`BTC ${usd(latest.btcPrice)}${prev?.btcPrice ? `（${latest.btcPrice >= prev.btcPrice ? '+' : ''}${((latest.btcPrice / prev.btcPrice - 1) * 100).toFixed(1)}%）` : ''}・週期指數 ${Math.round(latest.index)}（${esc(latest.indexZone)}）`);
  L.push(`抄底 CBS ${cur.cbs} 分（${esc(cur.cbsLevel)}）${prev && prev.cbs !== cur.cbs ? ` ← ${prev.cbs}` : ''}・止盈 CTS ${cur.cts} 分（${esc(cur.ctsLevel)}）${prev && prev.cts !== cur.cts ? ` ← ${prev.cts}` : ''}`);
  const ch = [];
  if (prev) for (const def of defs) {
    const ind = latest.indicators?.[def.id]; if (!ind || ind.value == null) continue;
    const b = bandOf(def, ind), pb = bandOfValue(def, prev.values?.[def.id]);
    if (b && pb && b.label !== pb.label) ch.push(`・${esc(def.name)}：${esc(pb.label)} → <b>${esc(b.label)}</b>`);
    const it = prev.items?.[def.id];
    if (it && cur.items?.[def.id]) for (const [k, nm] of [[0, '抄底'], [1, '止盈']]) if (it[k] != null && cur.items[def.id][k] != null && it[k] !== cur.items[def.id][k]) ch.push(`・${esc(def.name)}：${nm}分 ${it[k]} → <b>${cur.items[def.id][k]}</b>`);
  }
  L.push(ch.length ? `\n<b>指標變化</b>\n${ch.slice(0, 12).join('\n')}${ch.length > 12 ? `\n…另有 ${ch.length - 12} 項` : ''}` : '\n指標判讀區間與前一日相同。');
  L.push(sg.body);
  L.push(overview(latest, cur, config, combos));
  const ev = (latest.events || []).filter(e => Date.parse(e.at) - Date.now() < 3 * 864e5 && Date.parse(e.at) > Date.now());
  if (ev.length) L.push(`\n🗓 <b>3 天內事件</b>\n${ev.map(e => `・${new Date(e.at).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })} ${esc(e.name)}`).join('\n')}`);
  return `📊 <b>BTC 週期雷達・${cur.date} 快照</b>\n${L.join('\n')}\n\n<a href="${SITE}">開啟網站</a>`;
}

async function run(env) {
  if (!env.TG_BOT_TOKEN || !env.TG_CHAT_ID) return { skipped: '未設定 TG_BOT_TOKEN / TG_CHAT_ID' };
  const stub = env.STATE.get(env.STATE.idFromName('main'));
  const st = await (await stub.fetch('https://state/')).json();
  st.cool ||= {}; st.px ||= [];
  const now = Date.now(), sent = [];
  const fire = async (key, hours, text) => {
    if (st.cool[key] && now - st.cool[key] < hours * H) return;
    await tg(env, text); st.cool[key] = now; sent.push(key);
  };
  if (!st.welcomed) { await tg(env, `✅ <b>BTC 週期雷達推播已啟用</b>\n每天快照後推送指標變化；盤中每 15 分鐘檢查不自然漲跌（依波動率調整）、劇烈震盪、30 日高低點、50 週均線與清算區。\n<a href="${SITE}">開啟網站</a>`); st.welcomed = true; sent.push('welcome'); }

  const [latest, lm, hist, config, bt, combos] = await Promise.all([asset(env, 'data/latest.json'), asset(env, 'data/liqmap.json').catch(() => null), asset(env, 'data/history.json'), asset(env, 'config/indicators.json'), asset(env, 'data/backtest.json').catch(() => null), asset(env, 'data/combos.json').catch(() => null)]);

  // 1) 每日快照摘要：每天第一份快照推完整摘要；同一天重跑只推和上次推播相比真正改變的部分
  if (latest.snapshotAt && latest.snapshotAt !== st.lastSnap && !latest.pending) {
    const sig = signature(latest, hist, config);
    if (st.lastSnap) {
      if (st.dg?.date !== sig.date) await tg(env, digest(latest, hist, config, combos));
      else { const t = sameDayUpdate(st.dg, sig); if (t) await tg(env, t); }
    }
    st.dg = sig; st.lastSnap = latest.snapshotAt; sent.push('digest');
  }
  // 快照逾時：超過 30 小時沒有新快照
  if (latest.snapshotAt && now - Date.parse(latest.snapshotAt) > 30 * H) await fire('stale', 12, `⏰ 網站快照已超過 30 小時沒有更新（最後 ${esc(latest.date)}），請檢查每日排程。`);

  // 2) 盤中價格
  const p = await spot();
  st.px = [...st.px.filter(x => now - x[0] < 26 * H), [now, p]];
  const ago = h => { let best = null; for (const x of st.px) if (now - x[0] >= h * H - 10 * 6e4) best = x; return best?.[1] ?? null; };
  // 依目前隱含波動率（DVOL）判斷是否「不自然」：漲跌超過該時間長度的 3 倍標準差，且不低於固定下限
  const dv = +latest.indicators?.dvol?.value || 50;
  const sd = h => dv * Math.sqrt(h / 8760);             // 該時間長度 1 個標準差（%）
  // 15 分鐘／1 小時／4 小時合併成一則（同方向 2 小時內不重複），24 小時另計
  const hits = [];
  for (const [h, nm, floor] of [[0.25, '15 分鐘', 2], [1, '1 小時', 3], [4, '4 小時', 5]]) {
    const q = ago(h); if (!q) continue;
    const c = (p / q - 1) * 100, th = Math.max(floor, 3 * sd(h));
    if (Math.abs(c) >= th) hits.push({ nm, q, c, m: Math.abs(c) / sd(h), s: sd(h) });
  }
  for (const dir of [1, -1]) {
    const hs = hits.filter(x => Math.sign(x.c) === dir); if (!hs.length) continue;
    const top = hs.reduce((a, b) => b.m > a.m ? b : a);
    await fire(dir > 0 ? 'mvUp' : 'mvDn', 2, `${dir > 0 ? '🚀' : '🔻'} <b>BTC ${top.nm}${dir > 0 ? '急漲' : '急跌'} ${Math.abs(top.c).toFixed(1)}%</b>（不自然波動）\n${usd(top.q)} → <b>${usd(p)}</b>\n${hs.map(x => `・${x.nm} ${x.c > 0 ? '+' : ''}${x.c.toFixed(1)}%（正常約 ±${x.s.toFixed(1)}%，${x.m.toFixed(1)} 倍）`).join('\n')}\n依目前 DVOL ${dv.toFixed(0)} 推算正常波動範圍`);
  }
  { const q = ago(24); if (q) { const c = (p / q - 1) * 100; if (Math.abs(c) >= Math.max(8, 3 * sd(24))) await fire(c > 0 ? 'up24' : 'dn24', 12, `${c > 0 ? '📈' : '📉'} <b>BTC 24 小時${c > 0 ? '上漲' : '下跌'} ${Math.abs(c).toFixed(1)}%</b>\n${usd(q)} → <b>${usd(p)}</b>`); } }
  // 劇烈震盪：1 小時內高低差很大、但收在原地附近（插針、急拉急殺）
  { const w = st.px.filter(x => now - x[0] <= H + 10 * 6e4).map(x => x[1]);
    if (w.length >= 4) { const hi = Math.max(...w), lo = Math.min(...w), range = (hi / lo - 1) * 100, net = Math.abs((p / w[0] - 1) * 100);
      if (range >= Math.max(3, 4 * sd(1)) && net < range / 3) await fire('whip', 3, `⚡ <b>BTC 1 小時劇烈震盪</b>\n高 ${usd(hi)}・低 ${usd(lo)}（區間 ${range.toFixed(1)}%），現價 ${usd(p)}\n急拉急殺通常伴隨大量清算，留意方向是否確立。`); } }
  // 跌破／突破 30 日收盤低點與高點
  { const cl = (bt?.rows || []).slice(-31, -1).map(r => r[bt.fields.indexOf('price')]).filter(Boolean);
    if (cl.length >= 20) { const lo = Math.min(...cl), hi = Math.max(...cl);
      if (p < lo * 0.995) await fire('lo30', 24, `📉 <b>BTC 跌破 30 日低點</b>\n現價 ${usd(p)}・前低 ${usd(lo)}`);
      if (p > hi * 1.005) await fire('hi30', 24, `📈 <b>BTC 突破 30 日高點</b>\n現價 ${usd(p)}・前高 ${usd(hi)}`); } }

  // 50 週均線（加 0.5% 緩衝避免來回洗）
  const ma = bt?.rows?.at(-1)?.[bt.fields.indexOf('ma50w')];
  if (ma) {
    const side = p > ma * 1.005 ? 'above' : p < ma * 0.995 ? 'below' : st.maSide;
    if (st.maSide && side && side !== st.maSide) await fire('ma-' + side, 6, side === 'above' ? `🟢 <b>BTC 站回 50 週均線</b>\n現價 ${usd(p)}・均線 ${usd(ma)}` : `🔴 <b>BTC 跌破 50 週均線</b>\n現價 ${usd(p)}・均線 ${usd(ma)}\n均線是重要支撐，也是趨勢保護的判斷線。`);
    st.maSide = side || st.maSide;
  }
  // 最大清算區（以快照當時的地圖為準）
  if (lm?.buckets?.length) {
    const tS = lm.topShort?.[0], tL = lm.topLong?.[0];
    const cum = (side, to) => lm.buckets.filter(b => side === 'up' ? b.price >= lm.price && b.price <= to : b.price < lm.price && b.price >= to).reduce((s, b) => s + (side === 'up' ? b.short : b.long), 0);
    if (tS && p >= tS.price) await fire('liqS-' + tS.price, 24, `💥 <b>打到上方最大空單清算區 ${usd(tS.price)}</b>\n此區約 ${mUsd(tS.usd)}，從快照價 ${usd(lm.price)} 打上來沿途累計約 ${mUsd(cum('up', tS.price))}。\n空單被大量清算後，常出現短線高點或加速上漲，留意後續量能。`);
    if (tL && p <= tL.price) await fire('liqL-' + tL.price, 24, `💥 <b>打到下方最大多單清算區 ${usd(tL.price)}</b>\n此區約 ${mUsd(tL.usd)}，從快照價 ${usd(lm.price)} 跌下來沿途累計約 ${mUsd(cum('dn', tL.price))}。\n多單被大量清算後，常出現短線低點或加速下跌，留意後續量能。`);
  }
  st.lastRun = now; st.lastPrice = p;
  await stub.fetch('https://state/', { method: 'POST', body: JSON.stringify(st) });
  return { sent, price: p };
}

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(run(env).catch(e => console.error('推播失敗', e.message))); },
  async fetch(req, env) {
    const u = new URL(req.url);
    if (u.pathname === '/__alert/status') {
      const st = await (await env.STATE.get(env.STATE.idFromName('main')).fetch('https://state/')).json();
      return Response.json({ configured: !!(env.TG_BOT_TOKEN && env.TG_CHAT_ID), lastRun: st.lastRun ? new Date(st.lastRun).toISOString() : null, lastPrice: st.lastPrice ?? null, lastSnap: st.lastSnap ?? null, maSide: st.maSide ?? null, cooldowns: Object.keys(st.cool || {}) });
    }
    return env.ASSETS.fetch(req);
  },
};
