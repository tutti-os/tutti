# 為 Tutti 做貢獻

[English](CONTRIBUTING.md) | [简体中文](CONTRIBUTING.zh-CN.md) | [繁體中文](CONTRIBUTING.zh-TW.md)

感謝你有興趣為 Tutti 做貢獻！本指南涵蓋開發環境設定、專案規範，以及讓你的變更順利合併所需的資訊。

參與本專案即表示你同意遵守我們的[行為準則](CODE_OF_CONDUCT.md)。

> 註：本程式碼庫使用內部代號 `tutti`，你會在目錄與二進位檔命名中看到它（如 `services/tuttid`）。

## 儲存庫結構

- `apps/desktop`：Electron 桌面外殼、renderer UI、preload 橋接層和原生桌面整合
- `services/tuttid`：長駐本機的常駐服務，核心業務邏輯所在
- `packages/clients/*`：共用的領域用戶端
- `packages/configs/*`：共用的工程設定
- `packages/ui/*`：共用的視覺系統邊界

## 開發環境

建議的本機環境：

- Node.js `24` 或更高；`.node-version` 固定了專案基線
- pnpm `10.11.0`
- Go `1.24`
- `golangci-lint` `v2.12.0`

安裝 workspace 相依套件：

```sh
pnpm install
```

安裝固定版本的 `golangci-lint`：

```sh
pnpm install:golangci-lint
```

檢查本機環境：

```sh
pnpm setup:dev
```

以包含前置檢查和預先建置 `tuttid` 的方式啟動桌面應用程式開發：

```sh
make dev-gui
```

如果你已有可用的 daemon 二進位檔，只想執行原本的 Electron/Vite 開發流程，`pnpm dev:desktop` 仍然可用。

## 常用指令

```sh
make dev-gui
pnpm build
pnpm typecheck
pnpm lint
pnpm lint:ts
pnpm lint:go
pnpm test:ts
pnpm test:go
pnpm check:golangci-version
pnpm install:golangci-lint
pnpm generate:defaults
pnpm check:defaults-generated
```

完整驗證入口：

```sh
pnpm check:full
```

## 儲存庫規則

- 業務邏輯歸屬 `services/tuttid`
- UI 與桌面整合歸屬 `apps/desktop`
- 只有存在真實共用邊界時，程式碼才應進入 `packages/`
- 業務程式碼檔案應保持在 `800` 行以內；超過即為重構訊號

深入參考：

- 架構總覽：[docs/architecture/README.md](docs/architecture/README.md)
- 專案結構：[docs/architecture/project-structure.md](docs/architecture/project-structure.md)
- 儲存庫約定：[docs/conventions/README.md](docs/conventions/README.md)
- 靜態分析與 lint 規則：[docs/conventions/static-analysis.md](docs/conventions/static-analysis.md)
- Agent 貢獻者說明：[AGENTS.md](AGENTS.md)

## 提交規範

我們遵循 [Conventional Commits](https://www.conventionalcommits.org/)：

```
<type>(<scope>): <subject>
```

本儲存庫中的範例：

```
fix(workspace-files): avoid protected directory prefetch
fix(agent): preserve provider permission defaults
```

常用類型：`feat`、`fix`、`docs`、`refactor`、`test`、`chore`。

## 開發者原創證書（DCO）

我們要求貢獻者簽署 [Developer Certificate of Origin](https://developercertificate.org/)。這是一份輕量聲明，表示你有權依照本專案的授權條款（Apache-2.0）提交貢獻。

用 `-s` 參數為每個 commit 加上簽署：

```sh
git commit -s -m "feat(scope): add something"
```

這會在 commit message 末尾加上一行 `Signed-off-by: Your Name <your@email>`。

## Pull Request 流程

1. Fork 儲存庫並從 `main` 建立分支。建議的分支命名：`feat/...`、`fix/...`、`docs/...`
2. 完成你的變更；每個 PR 只聚焦一件事
3. 送出 PR，清楚描述動機與變更內容
4. CI 會執行 TypeScript lint、Go lint、型別檢查、測試和工具一致性檢查；所有檢查必須通過
5. 維護者會 review 你的 PR；請回應回饋，並把討論保留在 PR 中

本機鉤子使用 `husky`：

- `pre-commit` 執行暫存區格式化和 UI 邊界檢查
- `pre-push` 執行 `pnpm check:full`

## Pull Request 評審門禁

Tutti 使用 `external-pr-review-gate` workflow 區分內部團隊變更和外部貢獻。官方作者由組織變數 `TUTTI_RD_MEMBERS` 定義；GitHub 團隊 `tutti-rd` 是外部 PR 的 review 請求目標。

- `tutti-rd` 成員發起的 PR 不會自動請求 reviewer，也不需要額外官方 approve 即可通過評審門禁
- 非 `tutti-rd` 作者發起的 PR 會自動請求 `@tutti-os/tutti-rd` review
- 外部 PR 只有在目前 head commit 獲得 `tutti-rd` 成員 approve 後才能合併
- 推送新提交會刷新門禁；新的 head commit 需要重新獲得通過評審
- 官方團隊成員變更時，維護者必須同時更新 `TUTTI_RD_MEMBERS` 和 `tutti-rd` 團隊

```mermaid
---
config:
  layout: dagre
  theme: redux
  look: neo
---
flowchart TB
    A["PR 開啟 / 重新開啟 / 標記為可評審 / 推送新提交"] --> B{"PR 作者是否在官方成員名單？"}
    B -- 是 --> C["不自動請求 Reviewer"]
    C --> P["✅ 通過"]
    P --> M["可以合併"]
    B -- 否 --> D["自動請求 @tutti-os/tutti-rd Review"]
    D --> E{"目前 head commit 是否有官方 Review？"}
    E -- 已 Approve --> P
    E -- 沒有通過評審 --> F["❌ 未通過"]
    F --> N["不能合併"]
    G["外部貢獻者推送新提交"] --> A

    G@{ shape: rounded}
```

## 文件語言策略

- `README.*` 和 `CONTRIBUTING.*` 以英文、簡體中文、繁體中文三種語言維護
- **英文版是唯一基準（source of truth）**——修改 `README.md` 或 `CONTRIBUTING.md` 時，須在同一個 PR 中同步更新 `*.zh-CN.md` 和 `*.zh-TW.md`
- 譯文與英文版衝突時，以英文版為準
- `LICENSE`、`NOTICE`、`CODE_OF_CONDUCT.md`、`SECURITY.md` 與 `docs/` 目錄只維護英文

## 回報問題

- Bug 回報與功能請求：使用 [issue 模板](.github/ISSUE_TEMPLATE)
- 安全漏洞：**請勿提交公開 issue**——參見 [SECURITY.md](SECURITY.md)

## 授權

向 Tutti 提交貢獻，即表示你同意你的貢獻以 [Apache License 2.0](LICENSE) 授權釋出。

> 翻譯說明：本文件與英文版內容同步，如有出入，以[英文版](CONTRIBUTING.md)為準。
