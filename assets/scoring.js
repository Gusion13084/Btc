// 評分引擎：網站與每日抓取程式共用同一份邏輯
// 規則格式：
//   單段  { dir, tiers:[{t, pts, range, state}], zero:[range, state] }
//   多段  { max, combine:"max", parts:[{ field?, dir, tiers, zero }] }  — 各段取最高分，不超過 max
//   狀態  { states:{ key:{pts, range, state} } }

export const parts = rule => !rule ? [] : rule.parts ? rule.parts : [rule];

export function partValue(part, ind) {
  if (!ind) return null;
  const v = part.field ? ind.fields?.[part.field] : ind.value;
  return v === undefined ? null : v;
}

export function evalPart(part, ind) {
  const v = partValue(part, ind);
  if (v === null) return { pts: 0, missing: true, tier: null };
  if (part.states) { const s = part.states[v]; return { pts: s?.pts ?? 0, tier: v }; }
  const n = Number(v);
  if (!Number.isFinite(n)) return { pts: 0, missing: true, tier: null };
  let best = null;
  for (const t of part.tiers) if (part.dir === 'below' ? n < t.t : n > t.t) { if (!best || t.pts > best.pts) best = t; }
  return { pts: best?.pts ?? 0, tier: best };
}

export function ruleMax(rule) {
  if (!rule) return 0;
  if (rule.max != null) return rule.max;
  return Math.max(0, ...parts(rule).flatMap(p => p.states ? Object.values(p.states).map(s => s.pts) : p.tiers.map(t => t.pts)));
}

export function scoreRule(rule, ind) {
  const max = ruleMax(rule);
  const res = parts(rule).map(p => evalPart(p, ind));
  const missing = res.length ? !!res[0].missing : true;
  const pts = Math.min(max, Math.max(0, ...res.map(r => r.pts)));
  return { pts, max, missing, parts: res };
}

export function levelFor(levels, score) {
  let idx = 0;
  levels.forEach((l, i) => { if (score >= l.min) idx = i; });
  return { ...levels[idx], index: idx };
}

export function scoreAll(config, indicators) {
  const out = {};
  for (const side of ['cbs', 'cts']) {
    let score = 0, max = 0, aPts = 0, aMax = 0, aAll = 0;
    const items = {};
    for (const def of config.indicators) {
      if (!def[side]) continue;
      const r = scoreRule(def[side], indicators?.[def.id]);
      items[def.id] = r;
      if ((def.tier || 'core') === 'core') { score += r.pts; max += r.max; }
      else if (def.tier === 'aux') { aAll += r.max; if (!r.missing) { aPts += r.pts; aMax += r.max; } }
    }
    const extremes = (config.extremes?.[side] || []).filter(x => {
      const v = Number(indicators?.[x.id]?.value);
      if (!Number.isFinite(v)) return false;
      return x.dir === 'below' ? v < x.t : x.dir === 'atleast' ? v >= x.t : v > x.t;
    });
    // 輔助確認：只以「有數值」的輔助指標計算比例
    const pct = aMax ? Math.round((aPts / aMax) * 100) : null;
    const bands = config.confirm?.bands || [];
    const band = pct == null ? null : levelFor(bands, pct);
    out[side] = { score, max, items, extremes, level: levelFor(config.levels[side], score), confirm: { pts: aPts, max: aMax, full: aAll, pct, band } };
  }
  return out;
}

// 歷史中「目前等級（或更高）」已連續幾天
export function streak(history, side, minScore) {
  let n = 0;
  for (let i = history.length - 1; i >= 0; i--) { if ((history[i][side] ?? -1) >= minScore) n++; else break; }
  return n;
}

export function indexZone(config, v) {
  if (v == null) return null;
  return levelFor(config.index?.zones || [{ min: 0, name: '' }], v);
}

// ---------- 操作計畫：逐日重播，有記憶的分批執行 ----------
// rows：每日 [{date, price, cbs, cts, idx, ma50w, cbsConfirm, ctsConfirm}]，由舊到新
// 規則：等級需持續 3 天才算數；已執行的批次會被記住；下一批距上一批至少 7 天；
//       買入批次執行後 CBS 跌回 8 分以下 → 暫停；指數連續 30 天 ≥ 50 視為抄底週期結束（重置）；
//       減倉批次在指數連續 30 天 < 40 後重置。
const minLast = (rows, i, k, n) => { let m = Infinity; for (let j = Math.max(0, i - n + 1); j <= i; j++) m = Math.min(m, rows[j][k] ?? 0); return m; };
const medLast = (rows, i, k, n) => { const a = []; for (let j = Math.max(0, i - n + 1); j <= i; j++) a.push(rows[j][k] ?? 0); a.sort((x, y) => x - y); return a[a.length >> 1]; };

export function runPlan(config, rows, todayExtra = {}) {
  const LB = config.levels.cbs, LS = config.levels.cts, T = config.trend;
  const st = { buy: { done: 0, last: -1e9, firstPrice: null, paused: false, hi: 0 }, sell: { done: 0, last: -1e9, cum: 0 }, idxHi: 0, idxLo: 0 };
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i], isLast = i === rows.length - 1;
    const b3 = minLast(rows, i, 'cbs', 3), s3 = minLast(rows, i, 'cts', 3);
    const bLv = levelFor(LB, b3), sLv = levelFor(LS, s3);
    // 提示類等級用 7 天中位數，避免在門檻附近天天跳動
    const bMed = levelFor(LB, medLast(rows, i, 'cbs', 7)), sMed = levelFor(LS, medLast(rows, i, 'cts', 7));
    // 週期結束重置
    st.idxHi = (r.idx ?? 0) >= 50 ? st.idxHi + 1 : 0;
    st.idxLo = r.idx != null && r.idx < 40 ? st.idxLo + 1 : 0;
    if (st.buy.done && st.idxHi >= 30) st.buy = { done: 0, last: -1e9, firstPrice: null, paused: false, hi: 0 };
    if (st.sell.done && st.idxLo >= 30) st.sell = { done: 0, last: -1e9, cum: 0 };
    const tr = trendState(config, rows.slice(Math.max(0, i - 500), i + 1));
    const ext = isLast ? (todayExtra.cbsExtremes || []) : [];
    let d = null;

    // --- 買入批次 ---
    const nextB = st.buy.done + 1, batchB = LB.filter(l => l.batch)[nextB - 1];
    if (batchB) {
      const lvOk = bLv.index >= LB.indexOf(batchB);
      const drop = st.buy.firstPrice && ((nextB === 2 && r.price <= st.buy.firstPrice * 0.8) || (nextB === 3 && r.price <= st.buy.firstPrice * 0.7));
      const extremeOk = nextB === 4 && ext.length && st.buy.done >= 1;
      const gapOk = i - st.buy.last >= 7;
      if (!st.buy.paused && (lvOk || drop || extremeOk) && (st.buy.done === 0 || gapOk)) {
        st.buy.done = nextB; st.buy.last = i; if (nextB === 1) st.buy.firstPrice = r.price;
      }
    }
    if (st.buy.done && !st.buy.paused && (r.cbs ?? 0) <= 8) { st.buy.paused = true; st.buy.pausedAt = i; }
    if (st.buy.paused && b3 >= 12) st.buy.paused = false;
    // --- 減倉批次 ---
    const nextS = st.sell.done + 1, batchS = LS.filter(l => l.batch)[nextS - 1];
    if (batchS && sLv.index >= LS.indexOf(batchS) && (st.sell.done === 0 || i - st.sell.last >= 7)) {
      st.sell.done = nextS; st.sell.last = i; st.sell.cum += batchS.batch.pct;
    }
    const sellCum = Math.max(st.sell.cum, tr.cum || 0);
    const buyCum = (config.allocation?.cbs || [])[LB.indexOf(LB.filter(l => l.batch)[st.buy.done - 1]) ] ?? 0;

    // --- 決定今天要說什麼（優先順序：正在執行 > 暫停 > 趨勢保護 > 已完成待命 > 預警/觀察 > 持有） ---
    const execB = st.buy.done && i - st.buy.last < LB.filter(l => l.batch)[st.buy.done - 1].batch.days;
    const execS = st.sell.done && i - st.sell.last < LS.filter(l => l.batch)[st.sell.done - 1].batch.days;
    if (execB) {
      const bb = LB.filter(l => l.batch)[st.buy.done - 1].batch, day = i - st.buy.last + 1;
      d = { tone: 'buy', title: `執行${bb.label}（第 ${day}/${bb.days} 天）`, action: `投入抄底資金 ${bb.pct}%${bb.btc ? `（BTC ${bb.btc}% / ETH ${bb.eth}%）` : ''}，分 ${bb.days} 天平均買入${bb.limit ? `，限價 ${bb.limit}` : ''}。` };
    } else if (execS) {
      const sb = LS.filter(l => l.batch)[st.sell.done - 1].batch, day = i - st.sell.last + 1;
      d = { tone: 'sell', title: `執行${sb.label}（第 ${day}/${sb.days} 天）`, action: `減倉現貨約 ${sb.pct}%，分 ${sb.days} 天賣出，換回的穩定幣投入套利。` };
    } else if (st.buy.paused && i - st.buy.pausedAt <= 60) {
      d = { tone: 'wait', title: '暫停後續買入', action: `已執行到${LB.filter(l => l.batch)[st.buy.done - 1].batch.label}，CBS 跌回 ${r.cbs} 分，可能是假底部。已買部位續抱，CBS 重回 12 分且持續 3 天再繼續。` };
    } else if (tr.stage) {
      const fresh = tr.below - tr.stage.days <= 7;
      d = fresh
        ? { tone: 'sell', title: tr.stage.label, action: tr.stage.text + '。換回的穩定幣投入套利，保留 30–50% 核心倉位。' }
        : { tone: 'hold', title: `${tr.stage.label}已完成`, action: `已依規則累計減倉約 ${tr.cum}%，剩餘核心倉位續抱；價格重新站上 50 週均線前不加碼，等待 CBS 抄底信號。` };
    } else if (st.buy.done) {
      const nb = LB.filter(l => l.batch)[st.buy.done];
      d = { tone: 'hold', title: `已完成${LB.filter(l => l.batch)[st.buy.done - 1].batch.label}`, action: nb ? `持有並等待：${nb.batch.trigger}，即啟動${nb.batch.label}。` : '四批已全部完成，現貨進入長期持有。' };
    } else if (st.sell.done) {
      const ns = LS.filter(l => l.batch)[st.sell.done];
      d = { tone: 'hold', title: `已完成${LS.filter(l => l.batch)[st.sell.done - 1].batch.label}`, action: ns ? `剩餘現貨續抱：${ns.batch.trigger}，即啟動${ns.batch.label}。` : '減倉計畫已完成，保留核心倉位。' };
    } else if (bLv.index >= 3 || sLv.index >= 3) {
      d = { tone: 'wait', title: '等待批次間隔', action: '等級已達標，但距離上一批不足 7 天，明天起再評估。' };
    } else if (bMed.index >= 3 || sMed.index >= 3) {
      const side = bMed.index >= 3 ? ['cbs', '抄底', 'buy'] : ['cts', '止盈', 'sell'];
      let n = 0; for (let j = i; j >= 0 && (rows[j][side[0]] ?? 0) >= 12; j--) n++;
      d = { tone: 'wait', title: `${side[1]}等級確認中（第 ${Math.min(n, 3)}/3 天）`, action: `${side[0].toUpperCase()} 達 12 分以上需持續 3 天，確認後啟動第一批。` };
    } else if (sMed.index === 2) {
      d = { tone: 'sell', title: '準備減倉', action: '停止新增現貨：列好減倉價位與批次，等 CTS 達 12 分並持續 3 天。' };
    } else if (bMed.index === 2) {
      d = { tone: 'buy', title: '保留現金，準備抄底', action: '停止新增套利倉位，CBS 達 12 分並持續 3 天即啟動第一批。' };
    } else if (bMed.index === 1 || sMed.index === 1) {
      d = bMed.index === 1
        ? { tone: 'hold', title: '開始關注，準備資金', action: '市場轉弱但未達抄底區，確認套利資金可在 24–48 小時內提取。' }
        : { tone: 'hold', title: '檢查止盈計畫', action: '市場升溫但未達止盈區，先規劃減倉價位。' };
    } else {
      d = { tone: 'hold', title: '持有，不加不減', action: '抄底與止盈都未達觀察門檻，套利資金照常運作、現貨續抱。' };
    }
    d.notes = [];
    if (tr.stage && !d.title.startsWith('趨勢')) d.notes.push(`趨勢保護：跌破 50 週均線 ${tr.below} 天，累計減倉目標 ${tr.cum}%。`);
    else if (tr.stage) {
      d.notes.push(`前 120 天內市場曾過熱（${tr.armedBy}），之後跌破 50 週均線 $${Math.round(tr.ma).toLocaleString('en-US')} 已 ${tr.below} 天。`);
      if (tr.next) d.notes.push(`若再維持到第 ${tr.next.days} 天，執行${tr.next.label}。`);
    } else if (tr.armed && tr.ma && r.price > tr.ma && r.price / tr.ma < 1.1) d.notes.push(`市場近期曾過熱，價格距離 50 週均線只剩 ${((r.price / tr.ma - 1) * 100).toFixed(1)}%，跌破 3 天將啟動趨勢保護減倉。`);
    d.alloc = { buy: buyCum, sell: sellCum };
    d.trend = tr;
    out.push(d);
  }
  return out;
}

export function decide(config, sc, rows, index) {
  const plan = runPlan(config, rows, { cbsExtremes: sc.cbs.extremes || [] });
  const out = { ...plan[plan.length - 1] };
  out.notes = [...out.notes];
  const confB = sc.cbs.confirm?.band?.name, confS = sc.cts.confirm?.band?.name;
  if (out.tone === 'buy' && /執行/.test(out.title)) out.notes.push(confB === '弱' ? '輔助確認偏弱，建議把分批天數加倍、放慢節奏。' : confB === '強' ? '輔助確認強，可照計畫執行。' : '');
  if (out.tone === 'sell' && /執行|趨勢/.test(out.title) && confS === '弱') out.notes.push('輔助確認偏弱，可先減一半，其餘等確認轉強。');
  if (sc.cbs.extremes?.length) out.notes.push(`極端底部信號：${sc.cbs.extremes.map(x => x.label).join('、')}（可提前啟動第四批）。`);
  if (sc.cts.extremes?.length) out.notes.push(`極端頂部信號：${sc.cts.extremes.map(x => x.label).join('、')}。`);
  const at = n => rows[rows.length - 1 - n];
  const delta = (k, n) => { const a = at(0)?.[k], b = at(n)?.[k]; return a != null && b != null ? a - b : null; };
  const d30i = delta('idx', 30);
  if (index != null && d30i != null) {
    if (d30i <= -10) out.notes.unshift(`週期指數 30 天下降 ${Math.abs(d30i).toFixed(0)} 點，市場明顯轉弱。`);
    else if (d30i >= 10) out.notes.unshift(`週期指數 30 天上升 ${d30i.toFixed(0)} 點，市場明顯升溫。`);
  }
  out.notes = out.notes.filter(Boolean);
  out.deltas = { idx7: delta('idx', 7), idx30: d30i, cbs7: delta('cbs', 7), cts7: delta('cts', 7), cbs30: delta('cbs', 30), cts30: delta('cts', 30) };
  out.plan = plan;
  return out;
}

// 趨勢保護：前 lookback 天內曾過熱，之後價格連續跌破長期均線 → 分段減倉
export function trendState(config, rows) {
  const T = config.trend; const last = rows[rows.length - 1];
  if (!T || !last || last.ma50w == null || last.price == null) return { ma: last?.ma50w ?? null, price: last?.price ?? null };
  let below = 0;
  for (let i = rows.length - 1; i >= 0 && rows[i].ma50w != null && rows[i].price < rows[i].ma50w; i--) below++;
  // 過熱必須發生在跌破之前的 lookback 天內
  const end = rows.length - 1 - below;
  let armedBy = null;
  for (let i = Math.max(0, end - T.lookback); i <= end; i++) {
    const r = rows[i];
    if ((r.idx ?? 0) >= T.armIndex) { armedBy = `週期指數 ${Math.round(r.idx)}，${r.date}`; }
    else if ((r.cts ?? 0) >= T.armCts) { armedBy = `CTS ${r.cts} 分，${r.date}`; }
  }
  const armed = !!armedBy;
  const done = armed ? T.stages.filter(s => below >= s.days) : [];
  const stage = done.at(-1) || null;
  return { ma: last.ma50w, price: last.price, below, armed, armedBy, stage, next: armed ? T.stages.find(s => below < s.days && below >= 1) || null : null,
    cum: done.reduce((a, s) => a + s.pct, 0) };
}
