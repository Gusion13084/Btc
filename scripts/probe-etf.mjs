// 測試各個 ETF 流量來源能不能從 GitHub 主機取得
const UA = { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36', Accept: '*/*' };
const urls = [
  'https://farside.co.uk/bitcoin-etf-flow-all-data/',
  'https://farside.co.uk/btc/',
  'https://etfs.llama.fi/flows',
  'https://etfs.llama.fi/snapshot',
  'https://defillama.com/api/etfs',
  'https://www.theblock.co/api/charts/chart/crypto-markets/bitcoin-etf/spot-bitcoin-etf-flows/daily',
  'https://bitbo.io/treasuries/etf-flows/',
  'https://www.ishares.com/us/products/333011/fund/1467271812596.ajax?fileType=csv&fileName=IBIT_holdings&dataType=fund',
  'https://query1.finance.yahoo.com/v8/finance/chart/IBIT?range=10d&interval=1d',
  'https://capi.coinglass.com/api/etf/flow',
  'https://open-api.coinglass.com/public/v2/indicator/bitcoin_etf',
  'https://api.sosovalue.xyz/data/etf/us-btc-spot/flows',
  'https://bitcoin-data.com/v1/etf-flow-btc/last',
];
for (const u of urls) {
  try {
    const r = await fetch(u, { headers: UA, signal: AbortSignal.timeout(30000) });
    const t = await r.text();
    console.log(`\n### ${r.status} ${u} (${t.length} bytes, ${r.headers.get('content-type')})`);
    const i = t.search(/IBIT|Total|flow/i);
    console.log(t.slice(0, 250).replace(/\s+/g, ' '));
    if (i > 250) console.log('…' + t.slice(i, i + 400).replace(/\s+/g, ' '));
  } catch (e) { console.log(`\n### ERR ${u} ${e.message}`); }
}
