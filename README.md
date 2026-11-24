# 雙語讀 · Parallel Read

免費的 Chrome 雙語網頁翻譯擴充功能：英文原文保留在上方，每段下方顯示台灣繁體中文，可一鍵還原。

## 特色

- **逐段對照**：每段只插入一個譯文，連結、格式與網頁操作不變；「還原網頁」會全部移除。
- **免費**：預設使用 Google 翻譯（免金鑰）；也可選用 Gemini 免費方案，自行在設定頁填入 API 金鑰，翻譯時參考標題與前後文。
- **保留原文**：行內程式碼與數學公式（MathJax、KaTeX、MathML）不會被拆開或遺失數字。
- **台灣用語**：偵測簡體輸出，並修正 34 個確定安全的中國電腦用語（如緩存→快取）。
- **不亂重試**：遇到限流或額度用完會停下並說明原因，不會自動改用付費服務。

## 安裝

1. 在這個頁面按「Code → Download ZIP」，下載後解壓縮。
2. 在 Chrome 開啟 `chrome://extensions`，打開右上角「開發人員模式」。
3. 按「載入未封裝項目」，選擇解壓後的 **`extension` 資料夾**（裡面直接有 `manifest.json`）。

這個擴充功能沒有上架 Chrome 線上應用程式商店。使用方式、翻譯服務比較、資料與金鑰的處理方式見 [extension/README.md](extension/README.md)。

## 專案結構

| 路徑 | 內容 |
| --- | --- |
| `extension/` | 擴充功能本體（Manifest V3），不需要建置 |
| `tests/` | 自動測試、瀏覽器測試頁、實際呼叫 Google 的對照腳本與結果 |
| `改善報告.md` | 診斷、翻譯服務比較、新舊譯文對照與限制 |

## 測試

```sh
node --test tests/engine.test.cjs tests/background.test.cjs tests/extension-lifecycle.test.cjs
# 沒有 Node.js 時：deno test --allow-read tests/
python -m http.server 8765
# 再開 http://localhost:8765/tests/browser/content-harness.html
# 與 http://localhost:8765/tests/browser/math-harness.html?renderer=katex
```

自動測試使用模擬回應，驗證的是程式邏輯，不代表譯文品質。

## 注意

- Google 翻譯模式使用 `translate.googleapis.com` 的非正式介面，沒有服務保證，Google 可能隨時限制或變更。
- Gemini 模式依官方文件實作，尚未用真實金鑰測試。
- 免費不等於無限制，也不保證永久免費。

## 授權

[MIT](LICENSE)
