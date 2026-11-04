import { scoreAll, scoreRule, ruleMax, parts, streak, decide, indexZone, levelFor } from './scoring.js';

const app = document.getElementById('app');
const S = { config: null, latest: null, history: [], charts: [], sc: null, bt: [], rows: [] };
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const usd = n => n == null ? '—' : '$' + Math.round(n).toLocaleString('en-US');
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const CHEV = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';
const SIDE = { cbs: { name: '抄底', cls: 'buy' }, cts: { name: '止盈', cls: 'sell' } };

function ago(iso) {
  if (!iso) return '—';
  const m = Math.round((Date.now() - new Date(iso)) / 60000);
  if (m < 1) return '剛剛';
  if (m < 60) return `${m} 分鐘前`;
  if (m < 60 * 48) return `${Math.round(m / 60)} 小時前`;
  return `${Math.round(m / 1440)} 天前`;
}
const twTime = iso => iso ? new Date(iso).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false, year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
const shortDate = d => { const [, m, dd] = d.split('-'); return `${+m}/${+dd}`; };

function fmtVal(def, ind) {
  if (!ind || ind.value == null) return '—';
  if (def.type === 'state') return def.states[ind.value] ?? ind.value;
  if (ind.display) return ind.display;
  return Number(ind.value).toFixed(def.decimals ?? 2) + (def.unit || '');
}
// 規則摘要（評分規則頁表格用）
function ruleText(rule, def) {
  if (!rule) return '<span class="sub">不計分</span>';
  const lines = parts(rule).map(p => {
    const head = rule.parts ? `<span class="sub">${esc(p.label)}</span><br>` : '';
    if (p.states) return head + Object.values(p.states).filter(s => s.pts > 0).map(s => `${esc(s.range)} → ${s.pts} 分`).join('<br>');
    return head + [...p.tiers].sort((a, b) => a.pts - b.pts).map(t => `${esc(t.range)} → ${t.pts} 分`).join('<br>');
  });
  return lines.join('<br>') + (rule.parts ? `<br><span class="sub">取最高，上限 ${ruleMax(rule)} 分</span>` : '');
}

async function load() {
  const get = p => fetch(p, { cache: 'no-store' }).then(r => { if (!r.ok) throw new Error(p + ' ' + r.status); return r.json(); });
  [S.config, S.latest, S.history] = await Promise.all([get('config/indicators.json'), get('data/latest.json'), get('data/history.json')]);
  document.getElementById('siteName').textContent = S.config.siteName || 'BTC 週期雷達';
  S.sc = scoreAll(S.config, S.latest.indicators);
  try { const b = await get('data/backtest.json'); S.bt = b.rows.map(r => Object.fromEntries(b.fields.map((f, i) => [f, r[i]]))); } catch { S.bt = []; }
  // 每日序列（用於變化量、持續天數）：優先用回測，沒有就用歷史快照；最後一天換成今天的即時分數
  const base = S.bt.length ? S.bt : S.history.filter(h => !h.legacy).map(h => ({ date: h.date, price: h.btcPrice, cbs: h.cbs, cts: h.cts, idx: h.idx ?? null }));
  S.rows = base.filter(r => r.date < S.latest.date).concat([{ date: S.latest.date, price: S.latest.btcPrice, cbs: S.sc.cbs.score, cts: S.sc.cts.score, idx: S.latest.index ?? null }]);
  S.dec = decide(S.config, S.sc, S.rows, S.latest.index);
}

// ---------- 指標說明視窗 ----------
const modal = document.getElementById('modal');
const modalBody = document.getElementById('modalBody');
let lastFocus = null;

function tierRows(side, def, rule, res) {
  const color = SIDE[side].cls;
  const max = ruleMax(rule);
  return parts(rule).map((p, i) => {
    const r = res.parts[i];
    let rows;
    if (p.states) {
      rows = Object.entries(p.states).sort((a, b) => b[1].pts - a[1].pts).map(([k, s]) => ({ pts: s.pts, range: s.range, state: s.state, cur: !r.missing && r.tier === k }));
    } else {
      rows = [...p.tiers].sort((a, b) => b.pts - a.pts).map(t => ({ pts: t.pts, range: t.range, state: t.state, cur: !r.missing && r.tier === t }));
      if (p.zero) rows.push({ pts: 0, range: p.zero[0], state: p.zero[1], cur: !r.missing && !r.tier });
    }
    const v = r.missing ? null : (p.field ? (S.latest.indicators[def.id]?.fields?.[p.field]) : null);
    return `${rule.parts ? `<div class="part-lab">${esc(p.label)}${v != null ? `<span class="mono">目前 ${esc(v)}${esc(p.unit || '')}</span>` : ''}</div>` : ''}
      <ul class="tiers">${rows.map(x => `<li class="tier ${color} ${x.cur ? 'cur' : ''}" style="--a:${x.pts / max}">
        <b class="mono">${x.pts} 分</b><span class="rng">${esc(x.range)}</span><span class="st">${esc(x.state)}</span>${x.cur ? '<em>目前</em>' : ''}</li>`).join('')}</ul>`;
  }).join('') + (rule.parts ? `<p class="sub">各項取最高分，最高 ${max} 分。</p>` : '');
}

function verdict(def, side, rule, res) {
  if (!rule) return '';
  if (res.missing) return `${SIDE[side].name}：尚無數值。`;
  const hit = res.parts.map((r, i) => {
    const p = parts(rule)[i];
    if (!r.tier) return null;
    return p.states ? p.states[r.tier] : r.tier;
  }).filter(Boolean).sort((a, b) => b.pts - a.pts)[0];
  if (!res.pts) return `${SIDE[side].name}：未進入計分區間。`;
  const top = res.pts === res.max ? '，已是此指標最強信號' : '';
  return `${SIDE[side].name}：${hit?.state || ''}（${res.pts}/${res.max} 分${top}）。`;
}

function openModal(id) {
  const def = S.config.indicators.find(d => d.id === id);
  if (!def) return;
  const ind = S.latest.indicators[def.id];
  const rb = def.cbs ? S.sc.cbs.items[def.id] : null, rt = def.cts ? S.sc.cts.items[def.id] : null;
  const sides = def.cbs && def.cts ? '抄底 & 止盈' : def.cbs ? '抄底' : def.cts ? '止盈' : '';
  const badge = def.tier === 'info' ? '市場資訊・不計分' : def.tier === 'aux' ? `輔助確認・${sides}` : `核心・${sides}`;
  const src = S.latest.sources?.[def.source]?.name || def.source;
  let summary;
  if (def.tier === 'info') summary = '此項僅供參考，不計入任何分數。';
  else if (!rb?.pts && !rt?.pts) summary = '目前不在抄底或止盈的計分區間，屬中性，繼續觀察。';
  else if (rb?.pts) summary = rb.pts === rb.max ? '已觸發此指標的最強抄底信號。' : '已進入抄底計分區間，尚未達到此指標最強信號。';
  else summary = rt.pts === rt.max ? '已觸發此指標的最強止盈信號。' : '已進入止盈計分區間，尚未達到此指標最強信號。';
  modalBody.innerHTML = `
    <div class="m-head">
      <span class="badge">${badge}</span>
      <span class="sub">數據來源：${esc(src)}</span>
      <button class="m-close" id="mClose" aria-label="關閉">✕</button>
    </div>
    <h2 id="mTitle">${esc(def.name)}</h2>
    <p>${esc(def.principle)}</p>
    <h4>如何解讀</h4>
    <p>${esc(def.howto)}</p>
    ${def.cbs ? `<h4>抄底評分區間</h4>${tierRows('cbs', def, def.cbs, rb)}` : ''}
    ${def.cts ? `<h4>止盈評分區間</h4>${tierRows('cts', def, def.cts, rt)}` : ''}
    <section class="judge">
      <h4>當前數值判斷</h4>
      <div class="judge-v"><span class="mono">${fmtVal(def, ind)}</span>${ind?.fields?.p != null ? `<span class="pct">近 4 年百分位 ${ind.fields.p}%</span>` : ''}${ind?.detail ? `<span class="sub">${esc(ind.detail)}</span>` : ''}</div>
      <div class="judge-s">
        ${rb ? `<span class="chip buy ${rb.pts ? 'on' : ''}">抄底 <b>${rb.pts}</b>/${rb.max}</span>` : ''}
        ${rt ? `<span class="chip sell ${rt.pts ? 'on' : ''}">止盈 <b>${rt.pts}</b>/${rt.max}</span>` : ''}
      </div>
      <p>${summary}</p>
      <p class="sub">${verdict(def, 'cbs', def.cbs, rb)} ${verdict(def, 'cts', def.cts, rt)}</p>
      <div class="sub mono">數據日期：${esc(ind?.asOf || '—')}${ind?.age >= 2 ? `（來源延遲 ${ind.age} 天）` : ''}・抓取於 ${twTime(ind?.fetchedAt)}${ind?.ok === false ? '・數據過舊' : ''}</div>
    </section>
    ${def.history?.length ? `<h4>歷史驗證</h4><ul class="hist">${def.history.map(h => `<li>${esc(h)}</li>`).join('')}</ul>` : ''}
    ${def.links?.length ? `<div class="m-links">查看圖表：${def.links.map(([n, u]) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(n)}</a>`).join('・')}</div>` : ''}
  `;
  lastFocus = document.activeElement;
  modal.hidden = false;
  document.body.style.overflow = 'hidden';
  modal.querySelector('.modal').scrollTop = 0;
  document.getElementById('mClose').addEventListener('click', closeModal);
  document.getElementById('mClose').focus();
}
function closeModal() {
  modal.hidden = true;
  document.body.style.overflow = '';
  lastFocus?.focus?.();
}
modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !modal.hidden) closeModal(); });
document.addEventListener('click', e => {
  const t = e.target.closest('[data-ind]');
  if (t && !e.target.closest('a')) openModal(t.dataset.ind);
});

// ---------- 儀表板 ----------
function scorePanel(side, s, label) {
  const levels = S.config.levels[side];
  const n = levels.length;
  const next = levels[s.level.index + 1];
  const days = s.level.index > 0 ? streak(S.rows, side, s.level.min) : 0;
  const d7 = S.dec?.deltas?.[side + '7'];
  const b = s.level.batch;
  return `<section class="score ${SIDE[side].cls}" aria-label="${label}">
    <div class="score-top">
      <div><div class="eyebrow">${label}</div><div class="big">${s.score}<small>/ ${s.max}</small></div>${d7 != null ? `<div class="delta mono">${d7 > 0 ? '▲' : d7 < 0 ? '▼' : '—'} ${Math.abs(d7)} 分・7 天</div>` : ''}</div>
      <span class="lvl">${esc(s.level.name)}</span>
    </div>
    <div class="action">${esc(s.level.action)}</div>
    <div>
      <div class="ladder">${levels.map((l, i) => `<div class="${i <= s.level.index && i > 0 ? 'on' : ''}" style="--o:${0.35 + 0.65 * (i / (n - 1))}"></div>`).join('')}</div>
      <div class="ladder-lab">${levels.map((l, i) => `<span class="${i === s.level.index ? 'cur' : ''}" title="${esc(l.name)}">${l.min}+</span>`).join('')}</div>
    </div>
    <div class="meta">
      ${next ? `<span>距離「${esc(next.name)}」還差 <b class="mono">${next.min - s.score}</b> 分</span>` : '<span>已達最高等級</span>'}
      ${days ? `<span>此等級以上已持續 <b class="mono">${days}</b> 天</span>` : ''}
    </div>
    ${b ? `<div class="batch"><b>${esc(b.label)}</b>・資金 ${b.pct}%${b.btc ? `（BTC ${b.btc}% / ETH ${b.eth}%）` : ''}・分 ${b.days} 天${b.limit ? `・限價 ${esc(b.limit)}` : ''}<br><span class="sub">${esc(b.trigger)}。${esc(b.note)}</span></div>` : ''}
    ${confirmRow(side, s)}
    ${s.extremes.length ? `<div class="extreme">極端${side === 'cbs' ? '底部' : '頂部'}信號：${s.extremes.map(x => esc(x.label)).join('、')}</div>` : ''}
  </section>`;
}

function confirmRow(side, s) {
  const c = s.confirm;
  if (!c.full) return '';
  if (c.pct == null) return `<div class="confirm"><div class="confirm-top"><span>輔助確認</span><span class="sub">尚無數據</span></div></div>`;
  return `<div class="confirm" title="${esc(c.band.note)}">
    <div class="confirm-top"><span>輔助確認 <b>${esc(c.band.name)}</b></span><span class="mono">${c.pts}/${c.max}・${c.pct}%</span></div>
    <div class="confirm-bar"><i style="width:${c.pct}%"></i></div>
    <div class="sub">${s.level.index >= 3 ? esc(c.band.note) : `${c.max < c.full ? `${(c.full - c.max) / 2 | 0} 項輔助指標暫無數據。` : ''}核心分數決定等級，輔助確認衡量其他指標是否同步。`}</div>
  </div>`;
}

function strip(def, ind) {
  if (def.type === 'state') {
    const v = ind?.value;
    return `<div class="state ${esc(v)}"><i></i>${esc(def.states[v] ?? '尚無數據')}</div>`;
  }
  const [mn, mx] = def.scale;
  const f = def.scaleField;
  const pos = x => Math.max(0, Math.min(100, ((x - mn) / (mx - mn)) * 100));
  let z = '', ticks = '';
  for (const side of ['cbs', 'cts']) for (const p of parts(def[side])) {
    if ((p.field || null) !== (f || null) || !p.tiers) continue;
    p.tiers.forEach(t => {
      z += p.dir === 'below' ? `<div class="zb" style="width:${pos(t.t)}%"></div>` : `<div class="zs" style="width:${100 - pos(t.t)}%"></div>`;
      ticks += `<div class="tick" style="left:${pos(t.t)}%"></div>`;
    });
  }
  const v = f ? ind?.fields?.[f] : ind?.value;
  const has = v != null && Number.isFinite(+v);
  const out = has && (+v < mn || +v > mx);
  return `<div class="strip" role="img" aria-label="${esc(def.scaleLabel || def.name)} 位置">
      <div class="track">${z}</div>${ticks}
      ${has ? `<div class="dot ${out ? 'out' : ''}" style="left:${pos(+v)}%"></div>` : ''}
    </div>
    <div class="strip-lab"><span>${mn}</span><span>${def.scaleLabel ? esc(def.scaleLabel) + '　' : ''}${def.cbs ? '← 底部' : ''}${def.cbs && def.cts ? '　' : ''}${def.cts ? '頂部 →' : ''}</span><span>${mx}</span></div>`;
}

function indCard(def) {
  const ind = S.latest.indicators[def.id];
  const b = def.cbs ? S.sc.cbs.items[def.id] : null, t = def.cts ? S.sc.cts.items[def.id] : null;
  const chip = (r, cls, lab) => r ? `<span class="chip ${cls} ${r.pts > 0 ? 'on' : ''} ${r.missing ? 'miss' : ''}">${lab} <b>${r.pts}</b>/${r.max}</span>` : '';
  const hot = b?.pts ? 'hot-buy' : t?.pts ? 'hot-sell' : '';
  const stale = ind && ind.ok === false;
  return `<article class="ind ${hot} ${def.tier || 'core'}" data-ind="${def.id}">
    <div class="ind-row1">
      <button class="ind-name" data-ind="${def.id}" aria-haspopup="dialog">${esc(def.name)}${CHEV}</button>
      <div class="chips">${def.tier === 'info' ? '<span class="chip">參考</span>' : chip(b, 'buy', '抄底') + chip(t, 'sell', '止盈')}</div>
    </div>
    ${def.type === 'state' ? '' : `<div class="ind-val"><span class="v">${fmtVal(def, ind)}</span>${ind?.fields?.p != null ? `<span class="pct" title="近 4 年百分位">4 年 ${Math.round(ind.fields.p)}%</span>` : ''}${ind?.age >= 2 && ind?.asOf ? `<span class="pct lag" title="來源數據延遲，這是 ${esc(ind.asOf)} 的數值">至 ${shortDate(ind.asOf)}</span>` : ''}<span class="d">${esc(ind?.detail || '')}</span></div>`}
    ${strip(def, ind)}
    ${def.type === 'state' && ind?.detail ? `<div class="sub mono">${esc(ind.detail)}</div>` : ''}
    ${!ind ? '<div class="sub">新指標，第一次每日排程後取得數值</div>' : ''}
    ${stale && ind.value != null ? `<div class="stale">數據過舊（${esc(ind.asOf || '')}），暫以最後數值計分</div>` : stale ? '<div class="stale">暫無數據</div>' : ''}
  </article>`;
}

function tierBlock(tier, title, sub) {
  const defs = S.config.indicators.filter(d => (d.tier || 'core') === tier);
  if (!defs.length) return '';
  const groups = [...new Set(defs.map(d => d.group))];
  return `<section class="tier-block">
    <div class="tier-head"><h2>${esc(title)}</h2><span class="sub">${esc(sub)}</span></div>
    ${groups.map(g => `<section class="ind-group"><h3>${esc(g)}</h3><div class="inds">${defs.filter(d => d.group === g).map(indCard).join('')}</div></section>`).join('')}
  </section>`;
}

function decisionCard() {
  const d = S.dec; if (!d) return '';
  const tone = { buy: 'buy', sell: 'sell', wait: 'wait', hold: 'hold' }[d.tone];
  const bar = (lab, v, cls) => `<div class="alloc"><div class="alloc-top"><span>${lab}</span><b class="mono">${v}%</b></div><div class="alloc-bar ${cls}"><i style="width:${v}%"></i></div></div>`;
  return `<section class="decision ${tone}" aria-label="今日操作建議">
    <div class="eyebrow">今日操作建議</div>
    <h2>${esc(d.title)}</h2>
    <p class="dec-action">${esc(d.action)}</p>
    ${d.notes.length ? `<ul class="dec-notes">${d.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
    <div class="allocs">
      ${bar('抄底資金累計投入目標', d.alloc.buy, 'buy')}
      ${bar('現貨累計減倉目標', d.alloc.sell, 'sell')}
    </div>
    <p class="sub">依手冊分批規則自動判斷，僅供參考，不構成投資建議。</p>
  </section>`;
}

function sparkline(vals, w = 300, h = 56) {
  const pts = vals.map((v, i) => [i, v]).filter(p => p[1] != null);
  if (pts.length < 2) return '';
  const x = i => (i / (vals.length - 1)) * w, y = v => h - 4 - (v / 100) * (h - 8);
  const d = pts.map((p, k) => `${k ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join('');
  const last = pts.at(-1);
  const zones = (S.config.index?.zones || []).slice(1).map(z => `<line x1="0" x2="${w}" y1="${y(z.min)}" y2="${y(z.min)}" class="sp-grid"/>`).join('');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">${zones}<path d="${d}" class="sp-line"/><circle cx="${x(last[0])}" cy="${y(last[1])}" r="3.5" class="sp-dot"/></svg>`;
}

function indexCard() {
  const v = S.latest.index;
  const z = indexZone(S.config, v);
  const d7 = S.dec?.deltas?.idx7, d30 = S.dec?.deltas?.idx30;
  const ser = S.rows.slice(-180).map(r => r.idx);
  const fmtD = x => x == null ? '—' : `${x > 0 ? '+' : ''}${x.toFixed(0)}`;
  const zones = S.config.index?.zones || [];
  return `<section class="cindex" aria-label="週期位置指數">
    <div class="ci-main">
      <div><div class="eyebrow">週期位置指數</div><div class="ci-num">${v == null ? '—' : Math.round(v)}<small>/ 100</small></div><b class="ci-zone">${esc(z?.name || '等待數據')}</b></div>
      <div class="ci-deltas mono"><span>7 天 <b>${fmtD(d7)}</b></span><span>30 天 <b>${fmtD(d30)}</b></span></div>
    </div>
    <div class="ci-bar">${zones.map((zz, i) => `<span style="flex:${(zones[i + 1]?.min ?? 100) - zz.min}">${esc(zz.name)}</span>`).join('')}${v != null ? `<i style="left:${v}%"></i>` : ''}</div>
    ${sparkline(ser)}
    <p class="sub">${v == null ? '第一次每日排程後，會用近 4 年歷史計算各指標的相對位置。' : '12 項指標在近 4 年中的平均相對位置：0 代表 4 年最低、100 代表 4 年最高。線圖為近 180 天走勢。'}</p>
  </section>`;
}

function viewOverview() {
  const sc = S.sc;
  const prev = S.history.filter(h => h.date < S.latest.date).at(-1);
  const chg = prev ? (S.latest.btcPrice / prev.btcPrice - 1) * 100 : null;
  app.innerHTML = `
    ${S.latest.legacy ? `<div class="notice">目前顯示的是從舊網站匯入的 ${esc(S.latest.date)} 數據，並已套用新評分規則。第一次每日排程執行後會換成即時抓取的數值，SSR 百分位、OI 萎縮、ETF 流量、清算與籌碼等新指標也會補齊。</div>` : ''}
    <section class="pricebar">
      <div class="p">${usd(S.latest.btcPrice)}<small>BTC</small></div>
      ${chg != null ? `<span class="mono" style="color:${chg >= 0 ? 'var(--buy)' : 'var(--sell)'}">${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%</span>` : ''}
      <span class="sub">${S.latest.pending ? `今日數據抓取中，10:00 補齊後寫入快照・更新於 ${twTime(S.latest.updatedAt)}` : `快照 ${esc(S.latest.date)}・定稿於 ${twTime(S.latest.snapshotAt || S.latest.updatedAt)}`}</span>
    </section>
    ${decisionCard()}
    ${indexCard()}
    <div class="scores">${scorePanel('cbs', sc.cbs, '抄底綜合評分 CBS')}${scorePanel('cts', sc.cts, '止盈綜合評分 CTS')}</div>
    <p class="sub hint">點任一指標可查看原理、評分區間與目前判斷。</p>
    ${tierBlock('core', '核心指標', '依抄底策略手冊計分，決定 CBS / CTS 等級')}
    ${tierBlock('aux', '輔助確認指標', '資金流向、清算與籌碼結構，不改變等級，用來確認信號強弱')}
    ${tierBlock('info', '市場資訊', '僅供參考，不計分')}
  `;
}

// ---------- 歷史 ----------
function chartTheme() {
  return { muted: css('--muted'), line: css('--line'), buy: css('--buy'), sell: css('--sell'), accent: css('--accent'), font: css('--f-mono') };
}
function killCharts() { S.charts.forEach(c => c.destroy()); S.charts = []; }

function viewHistory() {
  const H = S.history;
  const numeric = S.config.indicators.filter(d => d.type !== 'state');
  let sel = 'mvrv';
  try { sel = localStorage.getItem('radar.ind') || sel; } catch {}
  if (!numeric.find(d => d.id === sel)) sel = numeric[0].id;
  app.innerHTML = `
    <div class="panel-head"><h2>歷史紀錄</h2><span class="sub mono">${H.length} 筆快照・${esc(H[0]?.date)} 起</span></div>
    ${S.bt.length ? `<section class="panel">
      <div class="panel-head"><h3 style="font-size:16px">回測：近 4 年評分與價格</h3><span class="sub">每天只用當時已知的資料計分</span></div>
      <div class="chart-box tall"><canvas id="c0" aria-label="近 4 年回測：BTC 價格、CBS、CTS 與週期指數"></canvas></div>
      <p class="sub">綠區為 CBS ≥ 12（啟動抄底批次），紅區為 CTS ≥ 12（啟動減倉批次）。用來檢查歷史底部與頂部時，系統是否給出正確方向的信號；改了門檻，下次排程後回測會跟著更新。</p>
    </section>` : ''}
    <section class="panel">
      <div class="panel-head"><h3 style="font-size:16px">每日快照評分</h3><span class="sub">左軸：分數　右軸：BTC 價格</span></div>
      <div class="chart-box"><canvas id="c1" aria-label="CBS 與 CTS 評分及 BTC 價格走勢"></canvas></div>
    </section>
    <section class="panel">
      <div class="panel-head"><h3 style="font-size:16px">單一指標走勢</h3>
        <label class="sub">指標 <select id="indSel">${numeric.map(d => `<option value="${d.id}" ${d.id === sel ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select></label></div>
      <div class="chart-box"><canvas id="c2" aria-label="單一指標數值走勢與門檻線"></canvas></div>
      <div class="sub" id="indNote"></div>
    </section>
    <section class="panel" id="logPanel"></section>`;
  renderLog();
  drawHistory(sel);
  document.getElementById('indSel').addEventListener('change', e => {
    try { localStorage.setItem('radar.ind', e.target.value); } catch {}
    drawHistory(e.target.value);
  });
}

// ---------- 每日紀錄（分頁） ----------
const LOG = { src: 'snap', page: 0, size: 20, open: null };
const lvClass = (lv, side) => !lv || /無信號/.test(lv) ? '' : side;

// 回測紀錄沒有存操作建議，依當天分數用同一套邏輯推算
function btDecision(i) {
  const B = S.bt, r = B[i];
  const mk = (side, score, conf) => {
    const bands = S.config.confirm?.bands || [];
    return { score, level: levelFor(S.config.levels[side], score ?? 0), extremes: [], confirm: { pct: conf, band: conf == null ? null : levelFor(bands, conf) } };
  };
  const sc = { cbs: mk('cbs', r.cbs, r.cbsConfirm), cts: mk('cts', r.cts, r.ctsConfirm) };
  const d = decide(S.config, sc, B.slice(Math.max(0, i - 60), i + 1), r.idx);
  return { ...d, cbsLevel: sc.cbs.level.name, ctsLevel: sc.cts.level.name };
}

function logRows() {
  if (LOG.src === 'bt' && S.bt.length) {
    return S.bt.map((r, i) => ({ i, date: r.date, btcPrice: r.price, cbs: r.cbs, cts: r.cts, idx: r.idx, cbsConfirm: r.cbsConfirm, ctsConfirm: r.ctsConfirm, bt: true })).reverse();
  }
  return [...S.history].reverse();
}

function logDetail(r) {
  const dec = r.bt ? btDecision(r.i) : r.decision;
  const head = dec
    ? `<div class="ld-dec ${esc(dec.tone)}"><b>${esc(dec.title)}</b><span>${esc(dec.action)}</span>${dec.notes?.length ? `<ul>${dec.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}${dec.alloc ? `<span class="sub">抄底資金累計目標 ${dec.alloc.buy}%・現貨累計減倉目標 ${dec.alloc.sell}%</span>` : ''}</div>`
    : `<div class="ld-dec"><b>${esc(r.action || '—')}</b><span class="sub">舊網站匯入紀錄，沒有逐項判斷。</span></div>`;
  if (!r.values) return head + (r.bt ? '<p class="sub">回測紀錄只保存分數；各指標數值從每日快照開始保存。</p>' : '');
  const defs = S.config.indicators.filter(d => r.values[d.id] != null);
  return head + `<div class="ld-grid">${defs.map(d => {
    const it = r.items?.[d.id] || [], p = r.pct?.[d.id];
    const chip = (v, cls, lab) => v == null ? '' : `<span class="chip ${cls} ${v ? 'on' : ''}">${lab} <b>${v}</b></span>`;
    return `<div class="ld-item"><span class="ld-name">${esc(d.name)}</span><span class="mono">${fmtVal(d, { value: r.values[d.id] })}${p != null ? ` <span class="pct">4 年 ${Math.round(p)}%</span>` : ''}</span><span class="ld-chips">${chip(it[0], 'buy', '抄')}${chip(it[1], 'sell', '止')}</span></div>`;
  }).join('')}</div>`;
}

function renderLog() {
  const el = document.getElementById('logPanel'); if (!el) return;
  const all = logRows();
  const pages = Math.max(1, Math.ceil(all.length / LOG.size));
  LOG.page = Math.min(LOG.page, pages - 1);
  const rows = all.slice(LOG.page * LOG.size, (LOG.page + 1) * LOG.size);
  const key = r => (r.bt ? 'b' : 's') + r.date;
  el.innerHTML = `
    <div class="panel-head"><h3 style="font-size:16px">每日紀錄</h3>
      ${S.bt.length ? `<div class="seg" role="tablist">
        <button role="tab" aria-selected="${LOG.src === 'snap'}" data-src="snap">每日快照</button>
        <button role="tab" aria-selected="${LOG.src === 'bt'}" data-src="bt">回測紀錄</button></div>` : ''}</div>
    <p class="sub">${LOG.src === 'bt' ? '回測紀錄：用現在的規則重算過去每一天，操作建議依當天分數推算。' : '每日快照：每天 10:00 定稿時的數據、各指標得分與操作建議。點任一天展開。'}</p>
    <div class="tbl-wrap"><table class="log">
      <thead><tr><th>日期</th><th>BTC</th><th>CBS</th><th>CTS</th><th>指數</th><th>操作建議</th></tr></thead>
      <tbody>${rows.map(r => {
        const dec = r.bt ? btDecision(r.i) : r.decision;
        const cl = r.bt ? dec.cbsLevel : r.cbsLevel, tl = r.bt ? dec.ctsLevel : r.ctsLevel;
        const k = key(r), open = LOG.open === k;
        return `<tr class="click ${open ? 'open' : ''}" data-log="${k}" tabindex="0" aria-expanded="${open}">
          <td class="mono c-date">${esc(r.date)}${r.legacy ? '<span class="legacy-tag" title="從舊網站匯入，當時的評分規則與現在不同">舊</span>' : ''}</td>
          <td class="mono c-price">${usd(r.btcPrice)}</td>
          <td class="c-cbs" data-l="抄底"><span class="mono">${r.cbs ?? '—'}</span> <span class="pill ${lvClass(cl, 'b')}">${esc(cl || '')}</span>${r.cbsConfirm != null ? `<div class="sub mono">確認 ${r.cbsConfirm}%</div>` : ''}</td>
          <td class="c-cts" data-l="止盈"><span class="mono">${r.cts ?? '—'}</span> <span class="pill ${lvClass(tl, 's')}">${esc(tl || '')}</span>${r.ctsConfirm != null ? `<div class="sub mono">確認 ${r.ctsConfirm}%</div>` : ''}</td>
          <td class="mono c-idx" data-l="指數">${r.idx != null ? Math.round(r.idx) : '—'}</td>
          <td class="wrap c-dec"><span class="dec-tag ${esc(dec?.tone || '')}">${esc(dec?.title || r.action || '—')}</span></td>
        </tr>${open ? `<tr class="ld-row"><td colspan="6">${logDetail(r)}</td></tr>` : ''}`;
      }).join('')}</tbody>
    </table></div>
    <nav class="pager" aria-label="分頁">
      <button data-pg="first" ${LOG.page === 0 ? 'disabled' : ''}>最新</button>
      <button data-pg="prev" ${LOG.page === 0 ? 'disabled' : ''}>‹ 較新</button>
      <span class="mono">第 ${LOG.page + 1} / ${pages} 頁・共 ${all.length} 天</span>
      <button data-pg="next" ${LOG.page >= pages - 1 ? 'disabled' : ''}>較舊 ›</button>
      <button data-pg="last" ${LOG.page >= pages - 1 ? 'disabled' : ''}>最舊</button>
    </nav>
    ${LOG.src === 'snap' && S.history.some(h => h.legacy) ? '<p class="sub">標「舊」的是從舊網站匯入的紀錄，分數依當時的規則計算。</p>' : ''}`;
  el.querySelectorAll('[data-src]').forEach(b => b.addEventListener('click', () => { LOG.src = b.dataset.src; LOG.page = 0; LOG.open = null; renderLog(); }));
  el.querySelectorAll('[data-pg]').forEach(b => b.addEventListener('click', () => {
    const m = { first: 0, prev: LOG.page - 1, next: LOG.page + 1, last: pages - 1 };
    LOG.page = Math.max(0, Math.min(pages - 1, m[b.dataset.pg])); LOG.open = null; renderLog();
    el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }));
  const toggle = tr => { LOG.open = LOG.open === tr.dataset.log ? null : tr.dataset.log; renderLog(); };
  el.querySelectorAll('tr[data-log]').forEach(tr => {
    tr.addEventListener('click', () => toggle(tr));
    tr.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(tr); } });
  });
}

function drawBacktest() {
  if (!S.bt.length || !window.Chart || !document.getElementById('c0')) return;
  const t = chartTheme(), B = S.bt;
  const step = Math.max(1, Math.floor(B.length / 400));
  const R = B.filter((_, i) => i % step === 0 || i === B.length - 1);
  const zone = (k, min) => R.map(r => (r[k] ?? 0) >= min ? 1 : null);
  S.charts.push(new Chart(document.getElementById('c0'), {
    type: 'line',
    data: { labels: R.map(r => r.date), datasets: [
      { label: 'BTC', data: R.map(r => r.price), borderColor: t.accent, borderWidth: 1.6, pointRadius: 0, yAxisID: 'yp' },
      { label: 'CBS', data: R.map(r => r.cbs), borderColor: t.buy, borderWidth: 1.2, pointRadius: 0, yAxisID: 'ys', stepped: true },
      { label: 'CTS', data: R.map(r => r.cts), borderColor: t.sell, borderWidth: 1.2, pointRadius: 0, yAxisID: 'ys', stepped: true },
      { label: '週期指數', data: R.map(r => r.idx), borderColor: t.muted, borderWidth: 1, borderDash: [3, 3], pointRadius: 0, yAxisID: 'yi' },
      { label: '抄底區', data: zone('cbs', 12), backgroundColor: t.buy + '33', borderWidth: 0, pointRadius: 0, fill: 'origin', yAxisID: 'yz' },
      { label: '止盈區', data: zone('cts', 12), backgroundColor: t.sell + '33', borderWidth: 0, pointRadius: 0, fill: 'origin', yAxisID: 'yz' },
    ] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: 'index', intersect: false },
      plugins: { legend: { labels: { color: t.muted, boxWidth: 10, font: { family: t.font, size: 11 }, filter: i => !/區/.test(i.text) } },
        tooltip: { filter: i => !/區/.test(i.dataset.label), titleFont: { family: t.font }, bodyFont: { family: t.font } } },
      scales: {
        x: { grid: { display: false }, ticks: { color: t.muted, font: { family: t.font, size: 10 }, maxRotation: 0, autoSkipPadding: 24, callback: function (v) { return this.getLabelForValue(v).slice(0, 7); } } },
        yp: { type: 'logarithmic', position: 'left', grid: { color: t.line }, ticks: { color: t.muted, font: { family: t.font, size: 10 }, callback: v => [1e4, 2e4, 5e4, 1e5, 2e5, 5e5].includes(v) ? '$' + v / 1000 + 'k' : '' } },
        ys: { position: 'right', min: 0, max: 28, grid: { display: false }, ticks: { color: t.muted, font: { family: t.font, size: 10 }, stepSize: 4 } },
        yi: { display: false, min: 0, max: 100 },
        yz: { display: false, min: 0, max: 1 },
      },
    },
  }));
}

function drawHistory(sel) {
  killCharts();
  if (!window.Chart) return;
  drawBacktest();
  const t = chartTheme(), H = S.history, labels = H.map(h => shortDate(h.date));
  const cbsMax = S.config.indicators.filter(d => (d.tier || 'core') === 'core').reduce((a, d) => a + ruleMax(d.cbs), 0);
  const base = {
    responsive: true, maintainAspectRatio: false, animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: { legend: { labels: { color: t.muted, boxWidth: 12, font: { family: t.font, size: 11 } } }, tooltip: { titleFont: { family: t.font }, bodyFont: { family: t.font } } },
  };
  const ax = extra => ({ grid: { color: t.line }, ticks: { color: t.muted, font: { family: t.font, size: 10.5 }, maxRotation: 0, autoSkipPadding: 14 }, ...extra });
  const lvLine = (v, c, lab) => ({ label: lab, data: H.map(() => v), borderColor: c, borderWidth: 1, borderDash: [5, 4], pointRadius: 0, yAxisID: 'y' });
  S.charts.push(new Chart(document.getElementById('c1'), {
    type: 'line',
    data: { labels, datasets: [
      { label: 'CBS 抄底', data: H.map(h => h.cbs), borderColor: t.buy, backgroundColor: t.buy, pointRadius: 2, borderWidth: 2, stepped: 'middle', yAxisID: 'y' },
      { label: 'CTS 止盈', data: H.map(h => h.cts), borderColor: t.sell, backgroundColor: t.sell, pointRadius: 2, borderWidth: 2, stepped: 'middle', yAxisID: 'y' },
      { label: 'BTC', data: H.map(h => h.btcPrice), borderColor: t.muted, backgroundColor: t.muted, pointRadius: 0, borderWidth: 1.2, borderDash: [4, 3], yAxisID: 'y1' },
      lvLine(12, t.buy, '一級門檻 12'),
    ] },
    options: { ...base, plugins: { ...base.plugins, legend: { ...base.plugins.legend, labels: { ...base.plugins.legend.labels, filter: i => !/門檻/.test(i.text) } } }, scales: {
      x: ax({ grid: { display: false } }),
      y: ax({ min: 0, max: cbsMax, ticks: { color: t.muted, stepSize: 4, font: { family: t.font, size: 10.5 } } }),
      y1: ax({ position: 'right', grid: { display: false }, ticks: { color: t.muted, font: { family: t.font, size: 10.5 }, callback: v => '$' + Math.round(v / 1000) + 'k' } }),
    } },
  }));
  const def = S.config.indicators.find(d => d.id === sel);
  const vals = H.map(h => h.values?.[sel] ?? null);
  const n = vals.filter(v => v != null).length;
  document.getElementById('indNote').textContent = n < 2 ? `目前只有 ${n} 筆 ${def.name} 數值，每日排程累積後就會畫出走勢。` : '虛線為抄底（綠）與止盈（紅）門檻。';
  const th = [];
  for (const side of ['cbs', 'cts']) for (const p of parts(def[side])) {
    if (p.field || !p.tiers) continue;
    p.tiers.forEach(tr => th.push({ label: `${SIDE[side].name} ${tr.pts} 分`, data: H.map(() => tr.t), borderColor: side === 'cbs' ? t.buy : t.sell, borderWidth: 1, borderDash: [5, 4], pointRadius: 0, fill: false }));
  }
  S.charts.push(new Chart(document.getElementById('c2'), {
    type: 'line',
    data: { labels, datasets: [{ label: def.name, data: vals, borderColor: t.accent, backgroundColor: t.accent, pointRadius: 3, borderWidth: 2, spanGaps: true }, ...th] },
    options: { ...base, plugins: { ...base.plugins, legend: { display: false } }, scales: { x: ax({ grid: { display: false } }), y: ax({}) } },
  }));
}

// ---------- 數據狀態 ----------
function viewSources() {
  const src = S.latest.sources || {};
  const ids = Object.keys(src);
  const bad = ids.filter(k => !src[k].ok);
  app.innerHTML = `
    <div class="panel-head"><h2>數據狀態</h2><span class="sub">台灣時間 09:00 抓取數據，10:00 補齊並寫入當日快照，12:00 補抓失敗項目</span></div>
    <div class="notice" style="border-color:${bad.length ? 'var(--sell)' : 'var(--buy)'};background:${bad.length ? 'var(--sell-soft)' : 'var(--buy-soft)'}">
      ${bad.length ? `<b class="bad">${bad.length} 個來源異常</b>：${bad.map(k => esc(src[k].name)).join('、')}` : '<b class="ok">所有數據來源正常</b>'}　最近一次執行 ${twTime(S.latest.updatedAt)}
    </div>
    <div class="grid2">${ids.map(k => {
      const s = src[k];
      const defs = S.config.indicators.filter(d => (S.latest.indicators[d.id]?.source || d.source) === k);
      return `<section class="panel src">
        <div class="src-head"><h3 style="font-size:16px">${esc(s.name)}</h3><span class="${s.ok ? 'ok' : 'bad'}">${s.ok ? '正常' : '異常'}</span></div>
        <div class="sub">檢查於 ${twTime(s.checkedAt)}（${ago(s.checkedAt)}）</div>
        ${s.error ? `<div class="err">${esc(s.error)}</div>` : ''}
        <div class="tbl-wrap"><table><tbody>${defs.map(d => { const ind = S.latest.indicators[d.id]; return `<tr>
          <td>${esc(d.name)}</td><td class="mono">${fmtVal(d, ind)}</td>
          <td class="${ind?.ok ? 'ok' : 'bad'}" style="font-weight:400">${ind?.ok ? '✓' : '✕'}</td>
          <td class="sub mono">${esc(ind?.asOf || ind?.date || '—')}</td></tr>`; }).join('')}</tbody></table></div>
      </section>`; }).join('')}</div>`;
}

// ---------- 評分規則 ----------
function viewRules() {
  const C = S.config;
  const lv = (side, cls) => `<table><thead><tr><th>分數</th><th>等級</th><th>建議行動</th></tr></thead><tbody>${C.levels[side].map((l, i, a) =>
    `<tr><td class="mono">${l.min}${a[i + 1] ? '–' + (a[i + 1].min - 1) : '+'}</td><td><span class="pill ${i > 2 ? cls : ''}">${esc(l.name)}</span></td><td class="wrap">${esc(l.action)}</td></tr>`).join('')}</tbody></table>`;
  const batches = side => {
    const B = C.levels[side].filter(l => l.batch);
    const hasCoin = B.some(l => l.batch.btc);
    return `<table><thead><tr><th>批次</th><th>分數</th><th>資金</th>${hasCoin ? '<th>BTC / ETH</th>' : ''}<th>天數</th>${hasCoin ? '<th>限價單</th>' : ''}<th>觸發條件與備註</th></tr></thead><tbody>${B.map(l => {
      const b = l.batch; return `<tr><td><b>${esc(b.label)}</b></td><td class="mono">${l.min}+</td><td class="mono">${b.pct}%</td>${hasCoin ? `<td class="mono">${b.btc}% / ${b.eth}%</td>` : ''}<td class="mono">${b.days}</td>${hasCoin ? `<td>${esc(b.limit)}</td>` : ''}<td class="wrap">${esc(b.trigger)}。<span class="sub">${esc(b.note)}</span></td></tr>`; }).join('')}</tbody></table>`;
  };
  const ext = side => (C.extremes?.[side] || []).map(x => esc(x.label)).join('、');
  const core = C.indicators.filter(d => (d.tier || 'core') === 'core');
  const cbsMax = core.reduce((a, d) => a + ruleMax(d.cbs), 0), ctsMax = core.reduce((a, d) => a + ruleMax(d.cts), 0);
  const cfgLink = C.repo ? `<a href="https://github.com/${esc(C.repo)}/edit/main/config/indicators.json" target="_blank" rel="noopener">在 GitHub 編輯設定檔</a>` : '設定檔 <code>config/indicators.json</code>';
  app.innerHTML = `
    <div class="panel-head"><h2>評分規則</h2><span class="sub mono">CBS 滿分 ${cbsMax}・CTS 滿分 ${ctsMax}</span></div>
    <div class="grid2">
      <section class="panel"><h3 style="font-size:16px;color:var(--buy)">抄底等級 CBS</h3><div class="tbl-wrap">${lv('cbs', 'b')}</div></section>
      <section class="panel"><h3 style="font-size:16px;color:var(--sell)">止盈等級 CTS</h3><div class="tbl-wrap">${lv('cts', 's')}</div></section>
    </div>
    <section class="panel">
      <h3 style="font-size:16px">分批抄底計畫</h3>
      <div class="tbl-wrap">${batches('cbs')}</div>
      <p class="sub">極端信號（任一出現即可觸發第四批）：${ext('cbs')}。CBS 達 12 分後若跌回 8 分以下，可能是假底部，暫停後續批次。</p>
    </section>
    <section class="panel">
      <h3 style="font-size:16px">分批止盈計畫</h3>
      <div class="tbl-wrap">${batches('cts')}</div>
      <p class="sub">極端頂部信號：${ext('cts')}。牛市頂部分 3–4 批把現貨的 50–70% 換回穩定幣，保留 30–50% 核心倉位。</p>
    </section>
    <section class="panel">
      <h3 style="font-size:16px">核心指標門檻</h3>
      <div class="tbl-wrap"><table><thead><tr><th>指標</th><th>抄底得分</th><th>止盈得分</th></tr></thead>
      <tbody>${C.indicators.filter(d => (d.tier || 'core') === 'core').map(d => `<tr class="click" data-ind="${d.id}"><td><b>${esc(d.name)}</b><div class="sub">${esc(d.group)}・最高 ${ruleMax(d.cbs)} / ${ruleMax(d.cts)} 分</div></td><td class="mono small">${ruleText(d.cbs, d)}</td><td class="mono small">${ruleText(d.cts, d)}</td></tr>`).join('')}</tbody></table></div>
      <p class="sub">點任一列可查看完整說明。</p>
    </section>
    <section class="panel">
      <h3 style="font-size:16px">輔助確認指標</h3>
      <p class="sub prose">不改變 CBS / CTS 等級。各項分數加總後除以「有數值的項目」滿分，得到確認度：${(C.confirm?.bands || []).map((b, i, a) => `${b.min}%${a[i + 1] ? '–' + (a[i + 1].min - 1) + '%' : '+'} 為「${esc(b.name)}」`).join('、')}。進入抄底或止盈批次時，確認度弱建議延長分批天數，確認度強可照計畫執行。</p>
      <div class="tbl-wrap"><table><thead><tr><th>指標</th><th>底部確認</th><th>頂部確認</th></tr></thead>
      <tbody>${C.indicators.filter(d => d.tier === 'aux').map(d => `<tr class="click" data-ind="${d.id}"><td><b>${esc(d.name)}</b><div class="sub">${esc(d.group)}</div></td><td class="mono small">${ruleText(d.cbs, d)}</td><td class="mono small">${ruleText(d.cts, d)}</td></tr>`).join('')}</tbody></table></div>
    </section>
    <section class="panel prose">
      <h3 style="font-size:16px">如何調整</h3>
      <p>所有門檻、等級、分批計畫與指標說明都寫在${cfgLink}。改完存檔後網站會自動重新部署，儀表板立刻用新規則計分；歷史快照保留當天的分數。</p>
      <p>每個門檻的 <code>t</code> 是數值界線、<code>pts</code> 是得分；<code>"dir": "below"</code> 代表低於界線得分，<code>"above"</code> 代表高於界線得分。</p>
    </section>`;
}

// ---------- 路由 ----------
const views = { overview: viewOverview, history: viewHistory, sources: viewSources, rules: viewRules };
function route() {
  killCharts();
  if (!modal.hidden) closeModal();
  const v = views[location.hash.slice(1)] ? location.hash.slice(1) : 'overview';
  document.querySelectorAll('nav.tabs a').forEach(a => { if (a.getAttribute('href') === '#' + v) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  views[v]();
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if (location.hash === '#history') route(); });
new MutationObserver(() => { if (location.hash === '#history') route(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

load().then(route).catch(e => {
  app.innerHTML = `<div class="notice" style="border-color:var(--sell)">讀不到數據檔：${esc(e.message)}。請確認 data/latest.json 與 config/indicators.json 存在。</div>`;
});
