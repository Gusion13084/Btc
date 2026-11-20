const UA = { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36', Accept: '*/*' };
const show = async (u, opt = {}) => { try { const r = await fetch(u, { headers: UA, signal: AbortSignal.timeout(40000), ...opt }); const t = await r.text(); console.log(`\n### ${r.status} ${u} (${t.length}B)\n${t.slice(0, 300).replace(/\s+/g, ' ')}\n…${t.slice(-200).replace(/\s+/g, ' ')}`); return t; } catch (e) { console.log(`\n### ERR ${u} ${e.message}`); } };
for (const id of ['WALCL', 'WTREGEN', 'RRPONTSYD', 'DFII10', 'DTWEXBGS', 'M2SL', 'NASDAQCOM', 'SP500', 'VIXCLS'])
  await show(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=2026-10-01`);
await show('https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/dts/operating_cash_balance?sort=-record_date&page[size]=3');
for (const s of ['^ndq', 'dx.f', '^spx', 'qqq.us']) await show(`https://stooq.com/q/d/l/?s=${encodeURIComponent(s)}&i=d&d1=20261101`);
const cm = await show('https://community-api.coinmetrics.io/v4/catalog-v2/asset-metrics?assets=btc&page_size=1000');
if (cm) { try { const j = JSON.parse(cm); const ms = j.data[0].metrics.map(m => m.metric); console.log('\nCM METRICS', ms.length, ms.filter(m => /Flow|Sply|Rev|Fee|Act|Adr|Ex|Hash|CDD|Out/i.test(m)).join(' ')); } catch (e) { console.log('cm parse', e.message); } }
for (const u of ['https://bitbo.io/treasuries/', 'https://bitbo.io/treasuries/countries/', 'https://bitbo.io/treasuries/strategy/', 'https://bitcointreasuries.net/']) {
  const t = await show(u);
  if (t) { const s = t.replace(/<[^>]+>/g, '|').replace(/\s+/g, ' ').replace(/(\| ?)+/g, '|'); for (const k of ['Public Companies', 'Countries', 'Governments', 'ETFs', 'Total', 'Strategy']) { const i = s.indexOf(k); if (i >= 0) console.log(`  [${k}] ${s.slice(i, i + 220)}`); } }
}
for (const u of ['https://bitcoin-data.com/v1/exchange-reserve-btc/last', 'https://bitcoin-data.com/v1/exchange-netflow-btc/last', 'https://bitcoin-data.com/v1/lth-supply/last', 'https://bitcoin-data.com/v1/miner-reserve/last']) await show(u);
