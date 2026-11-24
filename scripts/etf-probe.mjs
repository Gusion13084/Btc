// 一次性：測試 ETF 流量各資料來源在 GitHub 主機上能不能抓、格式為何
import { writeFile, mkdir } from 'node:fs/promises';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const T = [
  ['tftc_data', 'https://www.tftc.io/bitcoin-etf-flows/data.json'],
  ['tftc_latest', 'https://www.tftc.io/bitcoin-etf-flows/latest.json'],
  ['tftc_method', 'https://www.tftc.io/bitcoin-etf-flows/methodology'],
  ['tftc_jun26', 'https://www.tftc.io/bitcoin-etf-flows/june-2026'],
  ['cmc_all', 'https://api.coinmarketcap.com/data-api/v3/etf/overview/netflow/chart?category=btc&range=all'],
  ['cmc_1y', 'https://api.coinmarketcap.com/data-api/v3/etf/overview/netflow/chart?category=btc&range=1y'],
  ['cg_flow', 'https://capi.coinglass.com/api/etf/bitcoin/flow-history'],
  ['cg_list', 'https://capi.coinglass.com/api/etf/flow/history?symbol=BTC'],
  ['bg_usd', 'https://bitcoin-data.com/v1/etf-flow-usd/last'],
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
