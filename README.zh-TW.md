<div align="center">

<img src="docs/assets/tutti-logo.png" alt="Tutti logo" width="120" />

# Tutti

**人與 Agent「同步協作」的工作空間。**

[官網](https://tutti.sh) · [文件](docs/README.md) · [參與貢獻](CONTRIBUTING.zh-TW.md)

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md)

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Website](https://img.shields.io/badge/website-tutti.sh-black.svg)](https://tutti.sh)

<!-- TODO: banner 圖 / 產品截圖 -->

</div>

---

## Tutti 是什麼？

Agent 預設各做各的。Tutti 提供了一個共用的即時工作空間：脈絡、檔案、應用程式、任務，全部串在一起。

Codex 能看到 Claude 的成果。一個 Agent 呼叫完應用程式，輸出的結果下一個 Agent 就能接著用，不用重複交代。

無需命令列工具 / 終端機，上手簡單。

## 功能

### 即時工作空間

Agent 不再只是交接摘要，而是共用同一個即時工作空間。你的 Codex 能看到 Claude 改了什麼、什麼正在執行、專案現在是什麼狀態。

共用：脈絡 · 檔案與成果 · 執行狀態 · 應用程式

<!-- TODO: workspace 截圖 -->

### 原生應用程式

Tutti 裡的應用程式，你和你的 Agent 都可以使用。你可以自己操作，也可以讓任何 Agent 呼叫。支援圖片、影片等內容生成，來源可以是官方、社群共建，或你自己建立的應用程式。

<!-- TODO: 應用程式截圖 -->

### 任務編排

不用手動拆分每一步。你只需要描述目標。Tutti 會把它拆解成清楚的任務。你只需要審核，再分配給合適的 Agent。

<!-- TODO: 任務截圖 -->

### 統一管理

不用再在多個分頁之間來回切換。一個畫面掌握全局：所有 Agent 對話、待你審核的操作、正在執行的任務。需要你確認的地方，可以快速定位並一鍵核准。

<!-- TODO: 控制中心截圖 -->

## 你可以用 Tutti 做什麼

- 讓 Codex 繼續 Claude 的工作，不用重新交代背景
- 讓 Claude 寫 PRD，然後在同一個工作空間裡呼叫設計應用程式
- 在雲端工作空間裡打開隊友的本機網站，不需要先部署
- 直接引用隊友的 Agent 對話串，不用再讓對方總結一遍
- 把任務分配給隊友的 Agent，讓工作不再只圍繞一個人流轉

## Tutti · 本機版 vs Tutti · 雲端版

|              | Tutti · 本機版                                                  | Tutti · 雲端版                                                      |
| ------------ | --------------------------------------------------------------- | ------------------------------------------------------------------- |
| **適合場景** | 單人 + 多 Agent                                                 | 多人 + 多 Agent                                                     |
| **執行環境** | 本機電腦                                                        | 雲端工作空間（跨裝置）                                              |
| **共用能力** | 脈絡、檔案、輸出、任務、執行狀態，在你自己的多個 Agent 之間共用 | 脈絡、檔案、輸出、任務、執行狀態，在團隊所有人及所有 Agent 之間共用 |
| **訂閱**     | 使用你自己的 Claude、Codex、Gemini 等訂閱                       | 同左                                                                |
| **價格**     | 免費                                                            | 早期體驗免費；後續按席位訂閱                                        |

Tutti 相容你已有的 Claude、Codex、Gemini 或其他 Agent 訂閱。無論本機版還是雲端版，都不需要額外購買模型方案。

本儲存庫包含的是 **Tutti · 本機版**：桌面應用程式與本機常駐服務，基於 Apache-2.0 授權免費開放原始碼。Tutti · 雲端版是獨立的託管服務，其程式碼不在本儲存庫中。

## FAQ

### 我需要重複購買 Agent 訂閱嗎？

不用。Tutti 直接使用你已有的 Claude、Codex、Gemini 或其他訂閱 / API 存取。

### 如果我現在沒有任何 Agent 訂閱怎麼辦？

你之後可以在 Tutti 內直接使用 Tutti Agent。Tutti Agent 早期體驗期免費，後續可能按量計費。

### Tutti · 本機版和 Tutti · 雲端版有什麼差別？

本機版適合你自己一個人和多個 Agent 協作。雲端版適合團隊成員、多個裝置、共用雲端成果都需要進入同一個工作空間的場景。

### 隊友能看到我的未公開內容嗎？

只有你主動分享到雲端工作空間的內容，隊友才能看到。本機工作都會保留在你自己的電腦上。

### Tutti 會取代我現有的 coding agent 嗎？

不會。Tutti 是以 Agent 為中心的工作空間。你可以繼續使用你信任的 Claude Code、Codex、Gemini 等 Agent。

### Tutti 只適合寫程式嗎？

不只。程式開發、設計、內容、應用流程，以及任何需要多人或多 Agent 共用脈絡和成果的工作，都可以用 Tutti。

## 快速開始

### 下載

<!-- TODO: Tutti · 本機版下載連結 -->

下載 Tutti · 本機版 —— 即將開放。

<!-- TODO: Tutti · 雲端版等候名單連結 -->

加入 Tutti · 雲端版等候名單 —— 即將開放。

### 從原始碼建置

環境需求：

- Node.js `24` 或更高（`.node-version` 固定了基線版本）
- pnpm `10.11.0`
- Go `1.24`

```sh
pnpm install
pnpm setup:dev
make dev-gui
```

完整開發指南見 [CONTRIBUTING.zh-TW.md](CONTRIBUTING.zh-TW.md)。

## 社群與貢獻

歡迎參與貢獻——請先閱讀[貢獻指南](CONTRIBUTING.zh-TW.md)，並了解我們的[行為準則](CODE_OF_CONDUCT.md)。

回報安全漏洞請參見 [SECURITY.md](SECURITY.md)。

<!-- TODO: 社群管道（Discord / X / 微信群） -->

## 授權

Tutti 基於 [Apache License 2.0](LICENSE) 開放原始碼。

> 註：本程式碼庫使用內部代號 `tutti`，你會在目錄與二進位檔命名中看到它（如 `services/tuttid`）。

> 翻譯說明：本文件與英文版內容同步，如有出入，以[英文版](README.md)為準。
