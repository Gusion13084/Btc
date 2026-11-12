// 檢視 bitbo ETF 流量頁的結構
const UA = { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36', Accept: '*/*' };
const t = await (await fetch('https://bitbo.io/treasuries/etf-flows/', { headers: UA })).text();
console.log('tables', (t.match(/<table/g) || []).length, 'scripts', (t.match(/<script/g) || []).length);
const strip = s => s.replace(/<[^>]+>/g, '|').replace(/\s+/g, ' ').replace(/(\| ?)+/g, '|');
let i = 0, k = 0;
while ((i = t.indexOf('<table', i)) >= 0 && k < 4) { const j = t.indexOf('</table>', i); const s = strip(t.slice(i, j)); console.log(`\nTABLE ${k} len ${j - i}\nHEAD: ${s.slice(0, 900)}\nTAIL: ${s.slice(-500)}`); i = j; k++; }
for (const m of t.matchAll(/(Nov|Oct) \d{1,2},? 2026/g)) { console.log('DATE@', m.index, t.slice(m.index - 80, m.index + 200).replace(/\s+/g, ' ')); if (++k > 8) break; }
const m = t.match(/(data|flows|series)\s*[:=]\s*\[\s*[\[{]/);
if (m) console.log('JSON-ish@', m.index, t.slice(m.index, m.index + 600));
