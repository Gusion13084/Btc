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
  return { date: cur.date, decision: cur.decision?.title || '', floor: cur.decision?.target?.floor ?? null, cap: cur.decision?.target?.cap ?? null, cbs: cur.cbs, cts: cur.cts, cbsLevel: cur.cbsLevel, ctsLevel: cur.ctsLevel, bands, items: cur.items || {} };
}
function sameDayUpdate(a, b) {
  const L = [], names = {};
  if (a.decision !== b.decision) L.push(`⚠️ <b>操作建議改變</b>：${esc(a.decision)} → <b>${esc(b.decision)}</b>`);
  if (a.floor !== b.floor || a.cap !== b.cap) L.push(`建議現貨：${b.floor != null ? `至少 ${b.floor}%` : ''}${b.cap != null ? `${b.floor != null ? '、' : ''}最多 ${b.cap}%` : ''}`);
  if (a.cbs !== b.cbs) L.push(`抄底 CBS ${a.cbs} → <b>${b.cbs}</b> 分（${esc(b.cbsLevel)}）`);
  if (a.cts !== b.cts) L.push(`止盈 CTS ${a.cts} → <b>${b.cts}</b> 分（${esc(b.ctsLevel)}）`);
  for (const [id, lb] of Object.entries(b.bands)) if (a.bands?.[id] && a.bands[id] !== lb) L.push(`・${esc(id)}：${esc(a.bands[id])} → <b>${esc(lb)}</b>`);
  return L.length ? `🔄 <b>BTC 週期雷達・${b.date} 快照更新</b>\n與今天稍早的推播相比：\n${L.join('\n')}\n\n<a href="${SITE}">開啟網站</a>` : null;
}
function digest(latest, hist, config) {
  const cur = hist.at(-1), prev = hist.filter(h => h.date < cur.date && !h.legacy).at(-1);
  const defs = config.indicators, L = [];
  const d = cur.decision || {}, pd = prev?.decision || {};
  const changed = prev && pd.title && pd.title !== d.title;
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
  if (!st.welcomed) { await tg(env, `✅ <b>BTC 週期雷達推播已啟用</b>\n每天快照後推送指標變化；盤中每 15 分鐘檢查急漲急跌、50 週均線與最大清算區。\n<a href="${SITE}">開啟網站</a>`); st.welcomed = true; sent.push('welcome'); }

  const [latest, lm, hist, config, bt] = await Promise.all([asset(env, 'data/latest.json'), asset(env, 'data/liqmap.json').catch(() => null), asset(env, 'data/history.json'), asset(env, 'config/indicators.json'), asset(env, 'data/backtest.json').catch(() => null)]);

  // 1) 每日快照摘要：每天第一份快照推完整摘要；同一天重跑只推和上次推播相比真正改變的部分
  if (latest.snapshotAt && latest.snapshotAt !== st.lastSnap && !latest.pending) {
    const sig = signature(latest, hist, config);
    if (st.lastSnap) {
      if (st.dg?.date !== sig.date) await tg(env, digest(latest, hist, config));
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
  const p1 = ago(1), p24 = ago(24);
  if (p1) { const c = (p / p1 - 1) * 100; if (Math.abs(c) >= 4) await fire(c > 0 ? 'up1h' : 'dn1h', 3, `${c > 0 ? '🚀' : '🔻'} <b>BTC 1 小時${c > 0 ? '急漲' : '急跌'} ${Math.abs(c).toFixed(1)}%</b>\n${usd(p1)} → <b>${usd(p)}</b>`); }
  if (p24) { const c = (p / p24 - 1) * 100; if (Math.abs(c) >= 8) await fire(c > 0 ? 'up24' : 'dn24', 12, `${c > 0 ? '📈' : '📉'} <b>BTC 24 小時${c > 0 ? '上漲' : '下跌'} ${Math.abs(c).toFixed(1)}%</b>\n${usd(p24)} → <b>${usd(p)}</b>`); }

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
