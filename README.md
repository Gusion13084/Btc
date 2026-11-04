# BTC 週期雷達

比特幣週期抄底（CBS）與止盈（CTS）綜合評分儀表板。全部跑在 GitHub 免費方案上：

- **GitHub Actions** 每天台灣 09:00 抓取數據，10:00 補齊剩餘指標後計分並寫入當日快照，12:00 補抓失敗項目
- **GitHub Pages** 放網站，網址是 `https://你的帳號.github.io/儲存庫名稱/`
- 不需要伺服器、資料庫或信用卡

## 部署步驟（約 10 分鐘）

1. **建立儲存庫**：登入 GitHub → 右上角「+」→ New repository → 名稱例如 `btc-radar` → 選 **Public**（免費帳號的 Pages 需要公開儲存庫）→ Create repository。
2. **上傳檔案**：在新儲存庫頁面點「uploading an existing file」，把解壓縮後的**整個資料夾內容**拖進去（包含 `.github` 資料夾）→ Commit changes。
   - 用電腦拖曳最方便。若 `.github` 資料夾沒上傳成功，可點 Add file → Create new file，檔名輸入 `.github/workflows/daily.yml`，再貼上該檔內容。
3. **開啟 Pages**：Settings → Pages → Build and deployment → Source 選 **GitHub Actions**。
4. **給排程寫入權限**：Settings → Actions → General → 最下方 Workflow permissions 選 **Read and write permissions** → Save。
5. **第一次執行**：Actions 分頁 → 左側「每日快照與部署」→ Run workflow。約 1–2 分鐘後網站就會上線並換成即時數據。
6. **填上儲存庫名稱**（選做）：編輯 `config/indicators.json`，把 `"repo": ""` 改成 `"repo": "你的帳號/btc-radar"`，「評分規則」頁就會出現直接編輯設定檔的連結。

## 系統怎麼判斷

1. **核心評分 CBS / CTS**：依抄底策略手冊的固定門檻，加上「近 4 年相對位置」兩者取高分。固定門檻抓歷史級大底與大頂；相對位置讓週期變淺時（例如 2025 年頂部多數經典指標沒觸發）系統仍然有反應。
2. **輔助確認**：ETF 流量、清算、籌碼結構等，不改變等級，只衡量其他指標是否同步。
3. **週期位置指數（0–100）**：12 項指標在近 4 年的平均百分位，分數為 0 時也能看出市場往哪個方向走。
4. **今日操作建議**：依等級、持續天數（第一批需維持 3 天）、假底部規則（CBS 曾達 12 又跌回 8 以下就暫停）、確認度，給出單一明確動作與累計倉位目標。
5. **回測**：每次執行都用快取的歷史序列，從 2022 年起逐日重算一次（每天只用當時已知的資料），結果在「歷史紀錄」頁。改了門檻，下次執行回測就會更新。

歷史序列快取在 `data/series/`。BGeometrics 第一次會抓近 4 年資料，之後每天只補最新幾天。

## 資料來源

| 指標 | 來源 | 說明 |
|---|---|---|
| MVRV Z-Score、NUPL、Puell、資金費率、OI | BGeometrics（bitcoin-data.com） | 核心 5 次 |
| ETF 淨流量、多空清算、短期持有者成本、獲利籌碼比例、巨鯨持倉 | BGeometrics | 輔助 5 次；免費方案每小時 10 次、每天 15 次，程式每輪最多用 8 次，其餘在 10:00 補抓後才寫入快照 |
| 多空帳戶比 | OKX 公開合約數據 | 若 GitHub 主機所在地區被限制，數據狀態頁會顯示異常，不影響其他指標 |
| BTC 市佔率 | CoinGecko | 僅供參考 |
| 週線 RSI、200 週均線、Pi Cycle Top / Bottom、Mayer Multiple | Kraken 日線與週線 K 線 | 由程式自行計算 |
| Hash Ribbons | Blockchain.com 算力 | 30／60 日均線自行計算 |
| SSR / USDT.D | DefiLlama 穩定幣供應與歷史 + CoinGecko 市值 | SSR 以近 4 年週資料算百分位 |
| 恐懼貪婪指數 | Alternative.me | |

## 調整評分

所有指標、門檻、等級都在 `config/indicators.json`：

- CBS 依《BTC / ETH 抄底指標系統 v1.0》：10 個指標、滿分 28、四批抄底
- 每個門檻 `{ "t": 界線, "pts": 得分, "range": 顯示文字, "state": 市場狀態 }`；`"dir": "below"` 低於界線得分，`"above"` 高於界線得分
- 多項組合的指標（SSR/USDT.D、資金費率+OI）用 `parts`，各項取最高分、不超過 `max`
- `levels`：綜合分數達到 `min` 即進入該等級，`batch` 是該批次的執行細節
- `principle`、`howto`、`history`、`links`：點指標時說明視窗顯示的內容
- `tier`：`core` 核心（計入 CBS/CTS 等級）、`aux` 輔助確認（只算確認度）、`info` 僅供參考
- 新增指標：在 `indicators` 加一筆，並在 `scripts/fetch.mjs` 的對應來源裡回傳同一個 `id` 的數值

改完存檔後網站會自動重新部署，儀表板立刻用新規則計分；歷史快照保留當天的分數。

## 常見問題

- **想立刻更新數據**：Actions → 每日快照與部署 → Run workflow（勾選 force 會全部重抓）。
- **某個來源異常**：網站「數據狀態」頁會顯示錯誤訊息，Actions 的執行紀錄有完整 log。
- **GitHub 排程有時會延遲** 5–30 分鐘，屬正常現象。

## 檔案結構

```
index.html               網站頁面
assets/app.js            前端邏輯（儀表板、歷史、數據狀態、評分規則）
assets/scoring.js        評分引擎（網站與排程共用）
config/indicators.json   指標與門檻設定
data/latest.json         最新數值（排程自動更新）
data/history.json        每日快照（排程自動累積，含從舊網站匯入的 9/27–11/3 紀錄）
scripts/fetch.mjs        每日抓取程式（Node 20，無需安裝套件）
.github/workflows/daily.yml  排程與部署設定
```
