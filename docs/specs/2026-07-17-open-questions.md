# 開放疑問記錄：模型接入與 Tutti Mode 實測回饋修復

執行 Goal 期間遇到的 spec 未覆蓋語義分歧與假設決策，逐條記錄於此；
全部任務完成後由需求方回顧。格式：問題 → 所做假設 → 影響範圍 → 建議。

對應驗收基準：`docs/specs/2026-07-17-model-access-ux-feedback-and-goal.md`

---

（各 Wave 執行時追加）

## 主線 GUI 走查觀察（Wave 2，P3 級，未修）

### W2-GUI-1 Combobox 打開時按 Escape 會連設定彈窗一起關閉

- 問題：模型選型 combobox 的 popover 打開時按 Escape，預期只關 popover，實際整個設定
  彈窗一起關閉（Escape 事件未被 popover 攔截）。
- 影響：鍵盤用戶誤關設定頁，未保存的草稿被丟棄。
- 建議：combobox/popover 在打開態消費 Escape（stopPropagation），後續批次處理。

### W2-GUI-2 歷史殘留 target 顯示「即將上線 / coming soon」佔位

- 問題：主視圖恢復到一個已不存在的 `codex:standalone:<workspaceId>` target 時，
  顯示「即將上線，暫未開放」佔位——文案誤導（它不是未上線，而是殘留身份）。
- 影響：視覺誤導；不卡死、可切走，數據無損。
- 建議：對解析不到的殘留 target 給「該 Agent 已不存在」語義而非 coming soon。

### W2-GUI-3 同一方案重開編輯器時候選目錄與計數殘留

- 問題：編輯器關閉再重開同一方案，上次拉取的候選目錄與「已拉取 N 個」計數仍在
  （store 級 draft 狀態未隨編輯器關閉清空）。跨方案/新草稿已驗證不洩漏。
- 影響：同端點自身緩存，語義無害；計數文案「已拉取」略有歧義。
- 建議：可在 beginEditPlan/beginDraft 時一律清空 draftDiscoveredModels，或保持現狀。

## Wave 2-①（模型方案配置流程重排）

### W2①-1 「拉取模型」復用檢測鏈，但不寫入檢測結果

- 問題：spec 1-1 未規定「拉取模型」是否等同一次連接檢測。daemon 的檢測鏈
  （detect）會順帶執行 inference（草稿未選模型時以第一個發現的候選做臨時推理）。
- 假設：`fetchDraftModels` 復用 `detectModelPlan` 調用，但**只取
  `discoveredModels` 進候選目錄，不寫入 `draftDetection`**。保存門檻仍然只認
  底部「檢測連接」的結果，因為最終檢測應驗證用戶所選的預設模型，而非拉取時
  的臨時候選。
- 影響：拉取成功後仍需在最後點一次「檢測連接」才能保存（多一次顯式步驟）；
  每次拉取會多付出一次臨時推理調用。
- 建議：若需求方認為「拉取成功即可視作檢測通過」，只需讓 fetch 同步寫入
  draftDetection；若在意拉取的推理成本，可在 daemon 增加輕量 discovery-only
  入口（本輪按約束未動 Go/OpenAPI）。

### W2①-2 「模型行只顯示名稱」按字面執行，capabilities 提示行一併移除

- 問題：1-4 針對檔位/定價，但模型行原本還有一行 capabilities 展示。
- 假設：按「模型行只顯示名稱（含 combobox 選型）」字面理解，capabilities
  提示行一併移除；capabilities/pricing/tier 數據仍保留在草稿與保存 payload
  中（D1 dormant，discovery 帶回的元數據不丟）。
- 影響：UI 不再展示模型能力標籤。
- 建議：如需保留能力提示，可恢復為 combobox 選項的描述副行，不必回到行內展示。

### W2①-3 拉取失敗的判定啟發式

- 問題：spec 未定義「拉取失敗」的邊界（請求成功但認證失敗、或返回空目錄）。
- 假設：請求異常，或 `model_discovery` 階段未通過（passed/skipped 之外）且返回
  0 個模型時，顯示 `fetchModelsFailed`；discovery 通過但 0 模型視為成功的空結果。
- 影響：認證/網絡失敗會顯式報錯，而不是靜默給出空候選目錄。
- 建議：後續可把檢測鏈的具體失敗階段透出到拉取反饋文案（現為單一失敗文案）。
- 補充（review 回派後）：拉取成功但 0 模型現在顯示中性提示
  `fetchModelsEmpty`（「接口未返回可选模型，你仍可手动输入模型 ID。」），
  避免按鈕看似無響應。
- 修正（GUI 實測 P1 回派後）：分類規則收緊為**只有 discovery 階段明確
  `passed` 且 0 模型才算 empty**；`failed`/`skipped`/缺失一律 `fetchModelsFailed`。
  原規則把 skipped 當成功，導致 network 失敗（discovery 被跳過）誤顯示為
  「空成功」。已對照 daemon 兩條檢測鏈驗證：端點鏈（detection.go）與
  native-login 鏈（native_subscription_detection.go）在 runtime 不可用/未登錄/
  網絡失敗時 discovery 均為 skipped → 現在正確歸為失敗。已知的外緣情況：
  「端點確實沒有模型目錄（全部 404/405）且草稿已配置手動模型」時 discovery
  也是 skipped，會顯示失敗文案而非中性文案——語義上偏嚴但不誤導（該端點
  確實拉不到目錄）；如需區分可依賴 discovery.detail 或 daemon 增加顯式
  `no_catalog` 狀態，留待主線裁決。失敗階段透出到文案（网络不可达 vs 认证
  失败）因 feedback 結構為 kind-only，擴展會波及類型與測試面，按回派許可
  維持單一失敗文案。

### W2①-4 端點方案保存門檻要求 ≥1 個模型（review 回派決策）

- 問題：daemon 允許「草稿未選模型」時以第一個發現的候選做臨時推理驗證，
  導致檢測可通過但方案可被保存為 0 模型、無默認模型的狀態；spec 未明文
  規定保存時的最小模型數。
- 決策（對抗式 review 拍板）：**端點（endpoint-backed，需 Base URL + API
  Key）方案在保存時要求 ≥1 個 normalized model**；native-login（官方訂閱）
  方案維持現狀——新建仍要求選模型，已保存方案可在未動模型時直接重存
  （模型可來自 provider 目錄）。落點：`workspaceModelPlanDraftRules.ts`
  的 `hasRequiredWorkspaceModelPlanDraftFields`。
- 影響：`requiredFieldsMissing` 文案（「請填寫名稱和模型列表…」）與規則自洽；
  0 模型端點草稿即使檢測通過也無法保存（新增回歸測試覆蓋）。
- 建議：若未來允許「純目錄方案」（模型完全運行時發現），需同步放寬此門檻
  並定義無默認模型時的運行時語義。

### W2①-5 custom 輸入命中 sibling 已選 id 時為靜默 no-op（僅記錄）

- 現狀：候選目錄已排除 sibling 已選項，僅手動輸入完全相同 id 時觸發守衛，
  行為是不替換、無提示。review 裁定留給主線 GUI 走查決定是否需要顯式反饋。

## Wave 2-⑤（bug 5-1 / 5-2 修復）

### W2⑤-1 Workspace Agent 刪除語義選 (b)：允許刪除 + GUI 優雅降級

- 問題：spec ⑤ 第 3 層給出兩選一：(a) 比照 `modelplan ErrPlanReferenced`
  阻擋刪除仍被會話引用的 Agent；(b) 允許刪除並保證 stale 引用優雅降級。
- 決策：選 **(b)**。理由：會話記錄天然比 Agent 配置長壽，(a) 會讓「用過的
  Agent 永遠刪不掉」除非引入「活躍會話」子集判定與級聯提示——這需要新錯誤
  碼/OpenAPI 契約變更（本輪禁區）；且第 1/2 層修復後 stale 引用已從「永久
  正在加载」降級為「可重試的顯式錯誤態」（4xx 不自動重試）。
- 落點：daemon 為 workspace agent CRUD 補了 slog 審計事件
  （`workspace_agent.created/updated/deleted`，services/tuttid/service/
  workspaceagent/service.go），使後續 `agent_target_id.dropped` 攝入告警
  可回溯到具體刪除動作。
- 建議：若需求方仍希望阻擋刪除，建議只計「存在未完成 turn 的活躍會話」，
  並沿用 `model_plan_referenced` 的錯誤形狀新增 `workspace_agent_referenced`。

### W2⑤-2 composer options 重試策略下沉 engine（次數/退避的取值）

- 問題：spec 要求「非 4xx 失敗加有限退避重試」，未定次數與延遲，也未定
  重試邏輯的落點。
- 假設：重試作為 reducer 轉移下沉到 activity-core engine（效仿
  effectExecutor 註釋「Retrying…are reducer transitions」），而非在
  useAgentGUIComposerOptionsSync 增加 effect（degradation ratchet 禁增）。
  取值：最多 2 次自動重試，退避 2s / 8s；4xx（含 400/404 stale 引用）不
  重試；重試期間狀態保持 loading，預算用盡才落 error 態（帶手動重試入口）。
  為此 EngineScheduleExpiryCommand 增加可選 `delayMs`（commandResult 不帶
  時間戳，reducer 無牆鐘錨點），EngineCommandResultIntent 增加可選
  `errorStatusCode`（由 effectExecutor 從 TuttidProtocolError.statusCode 提取）。
- 影響：所有經 engine 的 composerOptions/load 統一獲得有限重試；手動重試
  （錯誤態點擊）每次授予全新重試預算。
- 建議：主線 review 關注 delayMs 對 engine 內部命令契約的擴展是否可接受。
