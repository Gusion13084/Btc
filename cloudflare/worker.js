// Cloudflare Worker：每天準時觸發 GitHub「每日快照與部署」
// 需要在 Worker 的設定加入一個 Secret：GH_TOKEN（GitHub 細粒度權杖，只給 Btc 儲存庫 Actions 讀寫權限）
// 排程（Cron Trigger）設定為：7 2 * * *（UTC，等於台灣時間 10:07）
const URL = 'https://api.github.com/repos/Gusion13084/Btc/actions/workflows/daily.yml/dispatches';

async function trigger(env) {
  for (let i = 0; i < 2; i++) {
    const r = await fetch(URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GH_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'btc-cycle-radar-cron',
      },
      body: JSON.stringify({ ref: 'main' }),
    });
    if (r.status === 204) return 'ok';
    console.log('觸發失敗', r.status, await r.text());
    await new Promise(res => setTimeout(res, 10000));
  }
  return 'failed';
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(trigger(env));
  },
  async fetch() {
    return new Response('BTC 週期雷達排程器運作中', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
  },
};
