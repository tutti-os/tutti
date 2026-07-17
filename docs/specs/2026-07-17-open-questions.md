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

### W2⑤-3 create 模型綁定 fail-safe 閘的取捨（Bug A 回派）

- 問題：跨方案裸模型 id（如 x-ai/grok-4.5）經 lastActiveModel 記憶/持久化
  defaults 洩漏到不相容 provider 的 create（daemon 400）。spec 未定 fail-safe
  的具體判定規則。
- 假設/決策：
  1. 模型身份統一為 {model, modelPlanId} 成對：記憶（lastActiveModelByProvider、
     同 provider 活躍會話繼承）全部改存/回填成對；帶 modelPlanId 的 create 由
     daemon `applyRequestedModelPlan` + `resolveProvidedModelPlan` 全量校驗
     （協議/enabled/model∈plan），**daemon 側無校驗缺口，未改 Go**。
  2. create 最後一道閘 `enforceComposerModelBindingForCreate`：裸模型僅在
     options 已載入且出現在 options.models 時放行；options 為 null（未載/失敗）
     或模型不在名單 → 丟棄模型（daemon 用默認），寧可不帶不可帶錯。例外：
     options 已載入但 models 名單為空（provider 不宣告目錄）沿用既有 sanitize
     語義放行，由 daemon clamp。
  3. **持久化 composer defaults 的 schema（OpenAPI 生成型別）沒有 modelPlanId
     欄位且本輪禁改 OpenAPI**：方案模型一律不寫入 remembered defaults（bare id
     斷源），native 模型照舊記憶。後續若要跨重啟記住方案模型，需擴展
     DesktopAgentComposerDefaults 增加 modelPlanId（OpenAPI 變更，記待辦）。
  4. 選 native 模型（patch 無 modelPlanId）時顯式清空 planId
     （`pairedComposerSettingsPatch`），杜絕 stale plan + native model 混搭。
- 影響：同 provider 的裸 native 模型繼承在 options 未載入的窗口內會退回
  daemon 默認（行為更保守）；活躍會話中從方案模型切 native 模型現在會觸發
  「新會話生效」提示（planId 顯式變化），語義更正確。
- 建議：主線 CDP 驗證「方案會話 → 回 codex home 首發」不再 400，以及顯式選
  方案模型後 create payload 帶完整成對綁定。

### W2⑤-4 聚合模型菜單的降級與合併語義（Bug B 回派）

- 問題：codex home 聚合菜單缺 provider 原生模型；options 未載入時降級行為未定義。
- 假設/決策：
  1. 非方案綁定 target：聚合方案模型**擴展而非替換**原生模型列表
     （native 在前 + aggregate 在後；值空間不同無碰撞）。
  2. 方案綁定 target（options.modelPlan 非空）：維持 aggregate-only——其
     「原生」名單本就是綁定方案的模型，合併會出現重複項。
  3. options 未載入窗口：選「顯示 loading」而非「僅安全項可選」——model
     支持度（modelConfigurable）在 options 到達前未知，此時展示任何可選列表
     都是猜測；菜單保持 disabled + 「正在加载」（配合 W2⑤-2 的重試/錯誤態，
     不會永久 loading）。
- 建議：若需求方希望 options 載入前即可選方案模型（純方案工作流），需先定義
  「options 未載入時 supportsModel 的默認語義」，屬產品決策。

### W2⑤-5 覆核回派：兩個 P1 已修 + P2-1 記錄不修

- **P1-1（已修）方案會話切 native 模型死路**：staged draft 的 planId 恆為顯式
  鍵（null = native），`composerModelPlanRequiresNewSession` 原對空 planId 直接
  false ⇒ staged native 永不生效、session draft 永久殘留。修：謂詞改為「draft
  含顯式 planId 鍵且與 active planId 不同（含 null ≠ 非空）⇒ 需開新會話」；
  已核實 session-keyed drafts 僅 staging/restore 兩個寫入者（皆經
  resolveEffectiveComposerSettings，planId 恆顯式），無誤傷面。
- **P1-2（已修）同方案切模型裸記 defaults / 跨方案混搭 pair**：持久化推導下沉
  純函數 `sessionComposerSettingsPersistence`——remembered defaults 用「patch
  planId 鍵優先、否則 session 當前 planId」作有效綁定判定（方案模型不裸記）；
  node defaults 的 model 變更恆同步寫入 modelPlanId 鍵（成對），杜絕與存量
  另一方案 planId 拼出混搭 pair。
- **P2-1（記錄不修）**：daemon 對 plan-bound target 若不回填
  `runtimeContext.modelPlan`，聚合菜單會把「原生名單（=方案模型）」與聚合
  方案項重複展示（僅視覺重複，無正確性問題）。待主線確認 daemon 回填契約的
  覆蓋面後決定是否按 (planId, model) 去重。

## Wave 3-②（Agent 配置簡化）

### W3②-1 「用途 → 描述」僅改 UI 文案，數據仍走 purpose 欄位（過渡態）

- 問題：2-6 要求把「用途」改為單一基礎「描述」欄位；D1 把用途欄位歸入
  「根本沒用 → 全鏈路刪除」，但本波禁改 OpenAPI/契約。
- 假設：UI label/placeholder 改為「描述/Description」（i18n key 仍叫
  `purposeLabel`，內部標識符不強改），數據暫存於 `WorkspaceAgent.purpose`；
  Agent 卡片副標題繼續展示該欄位。
- 影響：契約與 UI 語義暫時錯位（purpose 承載描述文案）。
- 建議：契約清理波把 `purpose` 重命名/合併為 `description`（OpenAPI +
  daemon + 存儲 + 遷移），或直接刪除並將描述併入 instructions 首段。

### W3②-2 保存即歸位：故障轉移鏈/能力白名單/權限覆寫在下次保存時清空

- 問題：2-5/2-7/2-9 只拆 UI（D1 dormant 或延後全刪），但編輯器已無法表達
  這些配置；既有 Agent 若帶白名單/fallback/權限覆寫，打開編輯再保存會發生什麼
  spec 只對 2-7 明示（回到 auto 是預期）。
- 假設：三者統一「保存即歸位」——保存 payload 恆發
  `modelFallbacks: []`、`capabilitiesExplicit: false, skills: [], tools: []`、
  `permissions: []`（daemon 對 explicit=false 會將 skills/tools 存為 nil，
  已有測試 TestPutCapabilitySelectionDistinguishesAutomaticAndExplicitNone
  覆蓋）。不保存則存量數據原樣保留（dormant）。
- 影響：帶存量 fallback/權限覆寫的 Agent 在任何一次編輯保存後回到中性配置，
  且無 UI 告知。
- 建議：若需求方希望「僅隱藏不清除」，改為 draft 透傳存量值即可（一行改
  `workspaceAgentDraftToPutInput`）；contract 清理波刪欄位時此分歧自然消失。

### W3②-3 「允許用於新對話」開關移除後，存量停用 Agent 無 UI 復啟路徑

- 問題：2-8 移除開關；`enabled` 欄位仍在契約中且 daemon Resolve 對
  disabled Agent 嚴格拒絕。
- 假設：新建 Agent 恆 `enabled: true`；編輯保存時透傳存量值（不強行翻轉）。
  存量 `enabled: false` 的 Agent 卡片仍顯示「已停用」狀態點，但不再有任何
  UI 能把它切回啟用。
- 影響：僅影響歷史上手動停用過的 Agent；可刪除重建繞過。
- 建議：契約清理波（D1 對 2-8 是全鏈路刪除）直接退役 enabled 欄位，
  daemon 遷移將存量 false 歸一為 true；屆時 Resolve 的 ErrAgentDisabled
  分支同步刪除。

### W3②-4 方案下拉對「無 modelPlanProtocol 的 Runtime」只保留當前選中項

- 現狀（2-4 驗證中的既有語義，未改動）：provider 目錄中只有 codex(openai)
  與 claude-code(anthropic) 聲明了 modelPlanProtocol；cursor/opencode 等
  Runtime 的 protocol 為空 → 方案下拉只顯示「使用 Agent Runtime 默認模型」
  與（若存量已綁）當前方案。這是 daemon `validateHarnessPlan` 的鏡像
  （不支持的 provider 綁任何方案都會被拒），非過濾 bug。
- 建議：若未來 cursor/opencode 支持注入，需在 provider catalog 聲明
  `modelPlanProtocol` 並重新生成目錄，前端無需再改。

## Wave 3-④（Tutti Mode 交互：Budget popup / 單次流程 / 任務級指派）

### W3④-1 編排強度落點：activation revision + Turn 快照 + Host Context 注入

- 問題：spec 4-1 允許「注入 Host Context 與/或 propose 時記到 proposal 上」兩種落點。
- 決策：持久化在 `TuttiModeActivation` 的 revision 上（`orchestrationIntensity`
  0-100，預設 50），隨每次滑桿確認 append 新 revision；Turn 派發時凍結進
  `TuttiModeTurnSnapshot`，由 Tutti Host Context 注入給規劃 Agent。**不**在
  propose 時由 daemon 記到 proposal——快照在 Agent 開始規劃前就已注入，語義
  最穩；propose 時已經拆解完成，再蓋章為時已晚。plan 文件 frontmatter 的
  `orchestrationIntensity` 仍由 Agent 回填（面板展示用）。
- 附帶取捨：強度變更 revision 沿用 `source: slash_command`（state 不變仍為
  active）。原因：v1 SQLite 表對 (state, source) 有 CHECK 約束，新增 source
  枚舉需重建表；「activation 轉換來源」語義仍成立。如需精確審計來源，後續
  可加 `intensity_update` source 並重建表。

### W3④-2 兩段式遷移：startup cancel（非 supersede）

- 決策：daemon 啟動時一次性掃描，把「當前 pending checkpoint 為
  configuration_review 且 workflow 非終態」的 workflow 走正常 Decide 路徑
  cancel（actor `tutti`，reason "configuration review retired by the
  single-review flow"）。理由：dev 環境需求方已確認可安全作廢；cancel 比
  supersede 語義更誠實（沒有新 revision 取代它）。
- dormant 保留：`configuration_review`/`generate_task_graph` 枚舉、
  `phase: configuration` 的解析（僅為讀舊 revision 檔）；歷史「已接受的
  configuration checkpoint」仍允許前進到 task_graph revision（不破壞在途
  合法狀態）；新的 configuration-phase propose/revise 一律拒絕。
- propose mutation replay 放寬：舊 propose mutation 記錄的是
  configuration_review checkpoint，replay 校驗改為只認「sequence==1 的初始
  revision」，避免舊 request-id 重放直接報錯。

### W3④-3 「請求修改」生效機制：daemon 派發 feedback turn（best-effort）

- 決策：reject（task_review）提交後，daemon 透過 `FeedbackDispatcher` 席位
  （wiring 注入，內部走 agentservice.SendInput）向 source session 發起新
  turn，內容含反饋原文 + `tutti plan revise` 指令；成功後記
  `WorkflowTurnLink(relation=feedback)`。派發為 fire-and-forget：決策已
  durable，派發失敗僅記 slog，Agent 仍可經 plan get/wait 觀察到 rejected。
- 已知邊界：source session 若正有 active turn，SendInput 會失敗（目前不走
  guidance、不排隊）。面板不會顯示派發失敗。建議後續：失敗時降級為
  guidance 或掛入 prompt queue，並把派發結果透出到 workflow operation。

### W3④-4 任務級 reasoning effort / permission mode：net-new 引入（非復原）

- 考古結論：git pickaxe 顯示 issues domain 從未有過任務級 reasoning 欄位；
  「先前被移除」實際發生在 composer/session 層的 schema 搬移（48ad757ab）。
  故本波是按用戶要求 net-new 引入，非還原舊欄位。
- 鏈路：plan 文件 task frontmatter（`reasoningEffort`/`permissionModeId`，
  離散 effort 詞彙/權限模式 id）→ OpenAPI `TuttiModePlanTask` → review 面板
  逐任務編輯 → accept 決策 `taskAssignments` overrides（checkpoint JSON 欄位
  durable 記錄）→ ActionableItem 投影合併 → issues domain
  `Task.ReasoningEffort/PermissionModeID`（SQLite v12 遷移）→ 任務啟動
  `CreateSessionInput.ReasoningEffort/PermissionModeID`（顯式 effort 覆蓋
  Issue 級 intensity 編譯；顯式 permission mode 覆蓋 target 預設）。
- 未做：issue-manager.v1.yaml REST 未暴露兩個新欄位（4-4 明示不改 Issue
  Manager 本體）；Issue Manager UI 看不到任務級 effort/permission。如需展示
  或編輯，後續要擴 issue-manager spec + regen。

### W3④-5 指派 overrides 的持久化與驗證邊界

- 落點：overrides 記在被接受的 checkpoint 上（decision 同事務寫入
  `task_assignments` JSON 欄位），而非偽造一個「用戶 revision」——revision
  維持 Agent 產物的不可變語義，ActionableItem 仍是
  「document + accepted checkpoint」的純投影，recovery/replay 天然一致。
- 語義：null 欄位 = 保留文件值；空字串 = 顯式清空。decide replay 攜帶的
  late overrides 被忽略（原 durable overrides 為準）。GUI 端切換 Agent 時
  自動把 plan/model/permission/effort 清空（目錄按 Agent 篩選，防不相容值
  靜默滑過）。
- 驗證邊界：decide 僅驗 taskId 存在於當前 revision；agent/plan/model 相容
  性沿用物化時 `validateIssueTaskAssignment`（協議 + 模型成員資格）與啟動
  時 composer 驗證。permissionModeId/reasoningEffort 值不在 decide 或物化
  時驗證（目錄是 runtime 概念），非法值啟動時按 provider 語義降級/報錯。

### W3④-6 4-2 移除範圍的字面取捨

- 面板：移除 Token 上限行與 auto/fixed 徽章，保留配額水位線展示；composer
  的 plan-issue 預算 preset 移除 auto/fixed 勾選與 token 輸入，保留兩個強度
  滑桿。後端 budget 契約（mode/tokenLimit）全部 dormant 保留（D1）。

### W3④-P0 失敗創建渲染死循環：路由/回滾競態（已修）與兩個上游殘留

- 崩潰鏈（CDP 復現 + 逐層定位）：session create 失敗 → 樂觀選中的 sessionId
  回滾（home）與路由 demotion（active→requested→selectConversation）在同一
  commit 波內互相餵養，composer 以 ~12ms/次在 home↔dead session 間往返
  （日誌可見 52 次 form 掛卸），直到 React "Maximum update depth exceeded"
  卸載整棵樹（黑屏）。錯誤棧裡的 Radix SelectTrigger/compose-refs 只是第 51
  次嵌套更新恰好落在重掛的 Select ref 上，非根因。
- 修復：兩道防線（先紅後綠 + 真機復現驗證）。(1) routing 對「最新 activation
  為 failed create」的 id 拒絕 demote/re-adopt（requested 直接落 home）；
  (2) 失敗回滾的抑制 ref 只被「另一個非空的外部選擇」解除，自身的空回聲不再
  提前解除（否則殘留的失敗 id 持久化回聲會被重新採納）。
- 上游殘留（本波定位、未修，屬模型綁定/composer options 簇）：
  (a) create 失敗的直接原因是 composer 把裸模型 `x-ai/grok-4.5` 發給 codex
  create——`lastActiveModelByProvider` 跨會話繼承了「經方案跑的模型」的裸
  id，而 composer options 為 null（加載失敗/未加載）時
  `sanitizeComposerSettingsForOptions` 原樣放行；顯式在聚合模型菜單選
  「中转接入点」方案模型後 create 仍缺 modelPlanId（綁定丟失，二次復現同錯）。
  (b) codex home 的聚合模型菜單在 options 未載入時只展示方案模型，無任何
  provider 原生模型可選。兩者建議回派給 ⑤/模型綁定 owner。

## 主線 GUI 走查觀察（Wave 3-④ e2e，追加）

### W3-GUI-4 Agent 缺乏 plan 文檔格式規格來源，被遺留舊格式檔誤導

- 觀察：Fable/Haiku 在會話中自述「command-guide 沒有格式規格」，隨後讀取
  ~/.tutti-dev/tutti-mode-plans/\*/revisions/ 下的**舊兩段式** revision 檔
  （phase: configuration）作為格式範例，寫出會被新校驗拒絕的 configuration-only 文檔。
- 影響：Agent 首次 propose 大概率撞 400，需靠錯誤信息自我糾正（多一輪往返）；
  弱模型可能直接失敗。
- 建議：(a) 注入的 command guide/skill 補上 tutti-mode-plan/v1 的最小格式範例
  （單次提交含 tasks）；(b) 評估對遺留 configuration 格式 revision 檔做標注或遷移，
  避免被當範例；(c) propose 的 400 錯誤文案應明確指出「需包含 tasks fenced block」。

### W3-GUI-5 弱模型會誤用 Claude Code 原生 EnterPlanMode 而非 Tutti CLI

- 觀察：Haiku 收到 Tutti Mode Plan 請求後先調用了原生 EnterPlanMode（隨後自我
  糾正）；期間退出原生 plan mode 需要用戶審批，流程卡住。
- 建議：Host Context 的 active 語句明示「使用 tutti plan propose CLI，
  不要使用 EnterPlanMode/原生規劃工具」。
