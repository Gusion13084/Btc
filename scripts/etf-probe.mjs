// 一次性：測試 ETF 流量各資料來源在 GitHub 主機上能不能抓、格式為何
import { writeFile, mkdir } from 'node:fs/promises';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const T = [
  ['bitbo', 'https://bitbo.io/treasuries/etf-flows/'],
  ['farside_all', 'https://farside.co.uk/bitcoin-etf-flow-all-data/'],
  ['farside_btc', 'https://farside.co.uk/btc/'],
  ['tftc_month', 'https://www.tftc.io/bitcoin-etf-flows/november-2026'],
  ['tftc_today', 'https://www.tftc.io/bitcoin-etf-flows'],
  ['cmc', 'https://api.coinmarketcap.com/data-api/v3/etf/overview/netflow/chart?category=btc&range=30d'],
  ['cmc2', 'https://api.coinmarketcap.com/data-api/v3/etf/overview/netflow/chart?category=btc'],
  ['theblock', 'https://www.theblock.co/api/charts/chart/crypto-markets/spot/spot-bitcoin-etf-flows'],
  ['sosovalue', 'https://api.sosovalue.xyz/openapi/v2/etf/historicalInflowChart', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'us-btc-spot' }) }],
  ['coinglass', 'https://capi.coinglass.com/api/etf/flow'],
  ['bg_etf', 'https://bitcoin-data.com/v1/etf-flow-btc/last'],
];
await mkdir('probe', { recursive: true });
const sum = [];
for (const [k, u, o = {}] of T) {
  try {
    const r = await fetch(u, { ...o, headers: { 'User-Agent': UA, Accept: 'text/html,application/json', ...(o.headers || {}) }, signal: AbortSignal.timeout(30000) });
    const t = await r.text(); await writeFile(`probe/${k}.txt`, t);
    sum.push(`${k}\t${r.status}\t${t.length}\t${t.slice(0, 200).replace(/\s+/g, ' ')}`);
  } catch (e) { sum.push(`${k}\tERR\t${e.message}`); }
}
await writeFile('probe/summary.txt', sum.join('\n') + '\n'); console.log(sum.join('\n'));
