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

// 今日操作建議：依核心等級、持續天數、假底部規則、確認度與指數變化，給出單一明確動作
// rows：每日序列 [{date, cbs, cts, idx}]（含今天），由舊到新
export function decide(config, sc, rows, index) {
  const lb = sc.cbs.level, ls = sc.cts.level;
  const allocB = config.allocation?.cbs || [], allocS = config.allocation?.cts || [];
  const at = n => rows[rows.length - 1 - n];
  const delta = (k, n) => { const a = at(0)?.[k], b = at(n)?.[k]; return a != null && b != null ? a - b : null; };
  const recent = rows.slice(-60);
  const maxCbs60 = Math.max(0, ...recent.map(r => r.cbs ?? 0));
  const daysB = streak(rows, 'cbs', lb.min), daysS = streak(rows, 'cts', ls.min);
  const confB = sc.cbs.confirm.band?.name, confS = sc.cts.confirm.band?.name;
  const out = { tone: 'hold', title: '', action: '', notes: [], alloc: { buy: allocB[lb.index] ?? 0, sell: allocS[ls.index] ?? 0 } };
  const batchText = b => `投入抄底資金 ${b.pct}%${b.btc ? `（BTC ${b.btc}% / ETH ${b.eth}%）` : ''}，分 ${b.days} 天執行${b.limit ? `，限價 ${b.limit}` : ''}`;

  if (lb.index >= 3) {
    const need = lb.index === 3 ? 3 : 1;
    out.tone = 'buy';
    if (daysB < need) { out.title = `${lb.name}：觀察第 ${daysB}/${need} 天`; out.action = `維持 ${need} 天以上再啟動${lb.batch.label}。`; out.tone = 'wait'; }
    else { out.title = `執行${lb.batch.label}`; out.action = batchText(lb.batch) + '。'; }
    if (lb.index >= 4) out.notes.push(lb.batch.trigger + '。');
    if (sc.cbs.extremes.length && lb.index < 6) out.notes.push(`出現極端信號（${sc.cbs.extremes.map(x => x.label).join('、')}），第四批可提前啟動。`);
    if (confB === '弱') out.notes.push('輔助確認偏弱，建議把分批天數加倍、放慢節奏。');
    if (confB === '強') out.notes.push('輔助確認強，可照計畫執行。');
  } else if (ls.index >= 3) {
    const need = ls.index === 3 ? 3 : 1;
    out.tone = 'sell';
    if (daysS < need) { out.title = `${ls.name}：觀察第 ${daysS}/${need} 天`; out.action = `維持 ${need} 天以上再啟動${ls.batch.label}。`; out.tone = 'wait'; }
    else { out.title = `執行${ls.batch.label}`; out.action = `減倉現貨約 ${ls.batch.pct}%，分 ${ls.batch.days} 天賣出，換回的穩定幣投入套利。`; }
    if (sc.cts.extremes.length) out.notes.push(`極端頂部信號：${sc.cts.extremes.map(x => x.label).join('、')}。`);
    if (confS === '弱') out.notes.push('輔助確認偏弱，可先減一半，其餘等確認轉強。');
  } else if (maxCbs60 >= 12 && sc.cbs.score <= 8) {
    out.tone = 'wait';
    out.title = '暫停後續買入';
    out.action = `CBS 60 天內曾達 ${maxCbs60} 分，現在回落到 ${sc.cbs.score} 分，可能是假底部。已買部位續抱，等 CBS 重回 12 分再繼續。`;
  } else if (ls.index === 2) {
    out.tone = 'sell'; out.title = '準備減倉'; out.action = ls.action + '：列好減倉價位與批次，等 CTS 達 12 分。';
  } else if (lb.index === 2) {
    out.tone = 'buy'; out.title = '保留現金，準備抄底'; out.action = lb.action + '，CBS 達 12 分且持續 3 天即啟動第一批。';
  } else if (lb.index === 1 || ls.index === 1) {
    out.tone = 'hold';
    out.title = lb.index === 1 ? '開始關注，準備資金' : '檢查止盈計畫';
    out.action = lb.index === 1 ? '市場轉弱但未達抄底區，確認套利資金可在 24–48 小時內提取。' : '市場升溫但未達止盈區，先規劃減倉價位。';
  } else {
    out.title = '持有，不加不減';
    out.action = '抄底與止盈都未達觀察門檻，套利資金照常運作、現貨續抱。';
  }

  const d7i = delta('idx', 7), d30i = delta('idx', 30);
  if (index != null && d30i != null) {
    if (d30i <= -10) out.notes.unshift(`週期指數 30 天下降 ${Math.abs(d30i).toFixed(0)} 點，市場明顯轉弱，留意 CBS 是否接近 6 分。`);
    else if (d30i >= 10) out.notes.unshift(`週期指數 30 天上升 ${d30i.toFixed(0)} 點，市場明顯升溫，留意 CTS 是否接近 6 分。`);
  }
  out.deltas = { idx7: d7i, idx30: d30i, cbs7: delta('cbs', 7), cts7: delta('cts', 7), cbs30: delta('cbs', 30), cts30: delta('cts', 30) };
  return out;
}
