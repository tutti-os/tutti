# 模型接入與 Tutti Mode：實測回饋與修復 Goal

- 日期：2026-07-17
- 分支：`feat/unified-model-access-plans`（已含 7 個提交，最新 `e2ceb88cc`）
- 上游需求：[《统一模型接入、任务编排与预算控制 PRD》rev 294](https://ccn53rwonxso.feishu.cn/docx/R81AdPRwZow50MxwOFfcKQCNnZb)
- 狀態：**定稿（2026-07-17）** —— 四個開放問題已由需求方拍板，本文件為本輪修復的驗收基準
- 來源：需求方在 dev 環境的完整實測回饋（含截圖：Workspace Agent 首頁 composer 卡在「正在加载」）

## 背景

第一期已交付：Model Plan CRUD 與四階段偵測、Workspace Agent 配置、AutomationRule
（consult/fork/delegate/handoff）、`TuttiModeActivation` + `/tutti` badge、
Tutti Mode Plan 兩段式 checkpoint（configuration → task graph）、Issue 物化。
本輪實測發現大量交互與語義偏差，需要一輪系統性收斂。

**工作樹現存未提交改動（in-flight，屬第①簇的一部分）**：
模型編輯器由自由文字輸入改為 Combobox 候選目錄選型
（新增 `packages/ui/system/src/components/combobox/`、
`workspaceModelPlanCandidates.ts`、`workspaceModelPlanDraftModels.ts`），
且 daemon 偵測在草稿未選模型時自動以第一個發現的候選做連通性測試
（`services/tuttid/service/modelplan/detection.go`）。此批改動應先驗收收編為基線。

---

## 回饋清單

### ① 模型方案配置流程（順序與交互重排）

目標流程：**憑證 → 拉取模型 → 模型列表（行內添加/行內設預設）→ 檢測（最後一步）**

| #   | 回饋                                         | 目標行為                                                     |
| --- | -------------------------------------------- | ------------------------------------------------------------ |
| 1-1 | 配完 Base URL + API Key 後缺「拉取模型」按鈕 | 憑證欄位下方提供顯式「拉取模型」動作，成功後展示可選模型目錄 |
| 1-2 | 「添加模型」在左下方，位置錯                 | 添加入口放在模型列表內（列表尾部行內添加），移除左下方按鈕   |
| 1-3 | 不應單獨選「預設模型」                       | 每個模型行內提供「選為預設」，移除獨立的預設模型選擇器       |
| 1-4 | 檔位/幣種/輸入/輸出/快取讀寫定價拿不到       | 全部隱藏，模型行只顯示名稱（後端欄位保留與否見 Q1）          |
| 1-5 | 「檢測連接」應是最後一步                     | 檢測動作移到編輯器底部，作為保存前的最終驗證步驟             |

主要落點：`apps/desktop/.../ui/WorkspaceModelPlanEditor.tsx`、
`workspaceModelPlansController.ts`、`services/tuttid/service/modelplan/`。

### ② Agent 配置簡化（Workspace Agent 編輯器）

保留：**名稱、Agent Runtime（原 Harness 改名）、模型方案 + 預設模型、描述**。

| #   | 回饋                                | 處理                                               |
| --- | ----------------------------------- | -------------------------------------------------- |
| 2-1 | 智能生成配置沒用                    | 移除（UI 入口 + 生成鏈路，範圍見 Q1）              |
| 2-2 | 名稱                                | 保留                                               |
| 2-3 | 「Harness」命名太抽象               | 改為「Agent Runtime」（i18n 雙語）                 |
| 2-4 | 模型方案 OK，但應可用訂閱等其他方案 | 確認方案選擇器覆蓋 subscription/coding plan 類方案 |
| 2-5 | 模型故障轉移鏈不完善                | 先移除                                             |
| 2-6 | 「用途」欄位                        | 移除，只留一個基礎「描述」欄位                     |
| 2-7 | 兼容能力（Skills/插件/連接器選擇）  | 完全移除，回到自動同步全部                         |
| 2-8 | 「允許用於新對話」開關看不懂        | 移除                                               |
| 2-9 | 高級能力與 ID 與權限                | 移除                                               |

主要落點：`apps/desktop/.../ui/WorkspaceAgentEditor.tsx`、
`workspaceAgentsController.ts`、`services/tuttid/service/workspaceagent/`。

### ③ 自動化規則重構（觸發 + 單一動作語義）

- 觸發條件保留兩個：**任務完成時**、**任務中斷/失敗時**。
- 動作徹底簡化：移除「諮詢 / 模型分叉 / 委派 / 移交」四選一。
  **唯一行為 = 自動創建一個新會話，把事件來源會話 @ 進去，
  目標 Agent 依據給定提示詞直接執行。**

| #   | 回饋                                    | 目標行為                                                                        |
| --- | --------------------------------------- | ------------------------------------------------------------------------------- |
| 3-1 | 沒配 Workspace Agent 就選不了目標 Agent | 目標 Agent 必須始終可選內建預設 Agent（Codex / Claude Code 等 harness targets） |
| 3-2 | 權限模式選不了                          | 修復；權限模式可選                                                              |
| 3-3 | 權限模式與允許的工具應跟隨目標 Agent    | 兩者的選項目錄由所選目標 Agent 的能力目錄動態決定                               |

主要落點：`WorkspaceAutomationRuleEditor.tsx`、
`services/tuttid/service/automationrule/`（daemon_executor、四動作分支）、
`services/tuttid/service/collabrun/`（處置見 Q2）。

### ④ Tutti Mode 交互

| #   | 回饋                                                                      | 目標行為                                                                                                                               |
| --- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 4-1 | Budget 特殊優化                                                           | 點擊 Tutti Budget → Popup：內含**編排強度滑桿（最低→最高）** + **取消按鈕**（點外部不關閉）。強度值持久化，後續規劃 Agent 執行時可讀取 |
| 4-2 | 計畫預算 Token 上限永遠是 0                                               | 直接移除該功能                                                                                                                         |
| 4-3 | 首次 Trigger 不應出現編排強度；現在分兩次（先計畫、再任務），修改也不生效 | **單次流程**：Agent 一次產出「計畫敘述 + 拆解好的任務列表」，一個 review 面板；修改請求真實生效                                        |
| 4-4 | 最終 Graph Plan 的任務拆分列表沒接右側面板                                | 任務列表與右側面板打通：每個任務可手動選 **Agent、推理強度、權限、模型**（對齊 PRD 任務級指派）                                        |

主要落點：`services/tuttid/service/tuttimodeplan/`（兩段 checkpoint 狀態機）、
`packages/agent/gui/workspaceWorkflow/tuttiModePlan/`、
`TuttiModeActivation`（強度掛載點，見 Q3）、Issue Manager 右側面板整合。

### ⑤ Bugs（阻塞測試，最高優先）

| #   | 現象                                                                                                                    | 初步判斷                                                                                                                |
| --- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 5-1 | 配置了 Workspace Agent（自定義模型方案 Agent）後，composer 的權限名單與模型名單永遠「正在加载」（見截圖），但消息可發出 | composer options 對 workspace-agent target 的投影/載入鏈路卡死；待定位（可能與 model plan binding 或 options 事件有關） |
| 5-2 | 配置 Workspace Agent 後，原本內建的正常 Agent 不再展示                                                                  | Agent 目錄聚合把兩類 target 做成互斥；應共存                                                                            |

---

## 已拍板決策（2026-07-17）

- **D1 — 移除深度：分級處理。**
  「先去掉／還不完善」類 → 僅拆 UI 與入口，後端契約保留 dormant：
  故障轉移鏈（2-5）、兼容能力（2-7）、計畫預算 Token 上限（4-2）、定價/檔位欄位（1-4）。
  「根本沒用」類 → 全鏈路刪除（OpenAPI、daemon、存儲、測試一併清）：
  智能生成（2-1）、用途欄位（2-6）、允許用於新對話（2-8）、高級能力/ID/權限（2-9）。
- **D2 — 自動化動作退役（範圍限自動化）。**
  自動化規則中不再出現 consult/fork/delegate/handoff 四動作選項與其執行分支；
  自動化唯一行為 = 新建目標會話 + @ 事件來源會話 + 規則提示詞。
  **保留**：CollaborationRun 底層基礎設施與 `@模型` 諮詢功能——所有透過其他管道
  調用模型的能力技術上都保留，只是不在自動化設定中暴露。
- **D3 — Tutti Mode：單一 checkpoint。**
  configuration checkpoint 取消；編排強度由 Budget popup（4-1）在觸發前設定並持久化；
  Agent 一次產出「計畫敘述 + 任務圖」單一 revision；只留一個可編輯 review 面板
  （含 4-4 的任務級 Agent/模型/權限/推理強度指派），「請求修改」產生新 revision。
- **D4 — DoD：GUI 實測必須。**
  每簇修完須在 dev 環境以 CDP 驅動真實走查並留截圖證據，
  34 條驗收腳本逐條通過；自動化測試與對抗式 review 是第二道防線，不是完成定義。

## Goal（定稿）

> 以本文件為驗收基準，修復 ⑤ 兩個阻塞 bug，並完成 ①–④ 四簇交互/語義收斂，
> 使模型接入 → Agent 配置 → 自動化 → Tutti Mode 全鏈路可被真實用戶操作走通；
> 每簇交付需通過對抗式 code review 與 GUI 實測驗證，全量門禁（check:changed）綠。

執行結構（波次按共享熱點隔離：desktop locale 重的簇不並行）：

- **Wave 1（並行）**：A = review 收編 in-flight 模型編輯器改動；B = 診斷 ⑤ 兩個 bug（只讀定位根因）。
- **Wave 2（並行）**：⑤ bug 修復落地；① 模型配置流程重排收尾（同在 desktop settings，若檔案重疊則串行）。
- **Wave 3（並行）**：② Agent 配置簡化（desktop locale 熱點）＋ ④ Tutti Mode（agent-gui locale 熱點，互不重疊）。
- **Wave 4**：③ 自動化重構（與 ② 共享 desktop locale、與 ④ 共享 agent-gui，故單獨一波；含 D2 退役）。
- **每簇 DoD**：實現 → 對抗式 review agent → CDP GUI 實測 + 截圖 → 主線彙總。
- **收尾**：`check:changed`（必要時 `check:full`）、架構文檔同步（model-access-plans /
  workspace-agents-and-automation / workspace-workflows）、驗收腳本全過。
- **提交策略**：每個 Wave 驗收通過即可 commit 並 push 到本功能分支；**不合入 main**，
  最終等人工驗收。
