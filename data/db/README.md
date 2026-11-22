# 每日數據庫

所有能取得的數據都逐日保存在這裡與 `data/series/`，只增不刪，方便未來新指標、組合信號與研究直接調用。寫入這些檔案不會改變網站任何指標或評分的計算。

## data/db（每天快照後由 scripts/store.mjs 寫入）
- `indicators/<id>.json`：網站每一項指標的每日數值，格式 `[快照日, 數值, 數據日期 asOf, 附加欄位]`。很多即時數據（期權偏斜、PCR、基差、資金費率年化、Coinbase 溢價、多空比、BTC 市佔率、總經面板等）來源不給免費歷史，只能靠這裡每天累積。2026-11-05 前只有數值、沒有 asOf 與附加欄位。
- `daily/system.json`：價格、CBS／CTS、週期指數、等級、操作建議、成立中的進出場訊號。
- `daily/combos.json`：各組合信號每天成立幾個條件、是否成立。
- `daily/liqmap.json`：清算地圖（上下方最大清算區、±5%／±10% 合計、實際清算、各價位分布）。
- `daily/arb.json`：套利池各平台年化與資金費率、基差。
- `daily/eth.json`：ETH 價格。

## data/series（來源本身的歷史序列）
- 鏈上與衍生品：`mvrv`、`nupl`、`puell`、`sthrp`、`profit`、`whale`、`funding`、`oi`、`etf`、`liq`（BGeometrics，2022-11 起；免費方案只給約 4 年，所以要自己保存）。
- 價格：`price`（2017 起收盤）、`ohlc`（Kraken 日 K 高低收）、`eth`、`dvol`、`fng`、`hash`、`stable`。
- 總經：`m_walcl`、`m_tga`、`m_rrp`、`m_real10`、`m_dxy`、`m_ndq`、`m_exSply`、`m_exNet`（由 scripts/backfill.mjs 回補到 2015 起）。
- Coin Metrics 社群版：`cm_btc.json`（長週期回測用的 8 項）與 `cm_btc_all.json`（BTC 全部免費日線指標，2010 起：活躍地址、交易數、手續費、供給、交易所流量、ROI 等）。
- `treasury.json`：ETF、企業、國家持倉每日快照（bitbo，2026-11-20 起自行累積）。

每日完整快照另外封存在 `data/archive/YYYY/`。
