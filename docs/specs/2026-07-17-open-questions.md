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
- **已解決（Wave 4-②）**：採重命名方案。`purpose` → `description` 全鏈路落地
  （OpenAPI、daemon、存儲遷移 `workspace_agents_contract_cleanup_v1` 拷貝
  存量數據、desktop 服務層與 i18n key `descriptionLabel`）。

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
- **已解決（Wave 4-②）**：分歧消解。`permissions` 已全鏈路刪除（不再存在
  「保存清空」問題）；dormant 欄位（`modelFallbacks`、`capabilitiesExplicit`/
  `skills`/`tools`）改為 draft 透傳——`WorkspaceAgentDraft.dormant` 承載存量值,
  `workspaceAgentDraftToPutInput` 原樣回發，保存不再破壞 dormant 數據
  （新增回歸測試覆蓋）。

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
- **已解決（Wave 4-②）**：按建議執行。`enabled` 從 OpenAPI/daemon 移除，
  遷移把存量 false 歸一為 true（物理列保留），`ErrAgentDisabled` 與
  Resolve/validateReferences 的 enabled 分支全部刪除；卡片「已停用」狀態點
  與 `agents.enabled` i18n key 退役（綠點語義改為「Runtime 可用」，key 改名
  `agents.ready`）。

### W3②-4 方案下拉對「無 modelPlanProtocol 的 Runtime」只保留當前選中項

- 現狀：provider 目錄中 `codex`/`tutti-agent`/`opencode` 聲明
  `modelPlanProtocol=openai`，`claude-code` 聲明 `anthropic`；`cursor` 等
  Runtime 的 protocol 仍為空 → 方案下拉只顯示「使用 Agent Runtime 默認模型」
  與（若存量已綁）當前方案。這是 daemon `validateHarnessPlan` 的鏡像
  （不支持的 provider 綁任何方案都會被拒），非過濾 bug。
- OpenCode 已落地原生 openai plan 注入（`OpenCodePreparer` +
  `ModelPlanModelAddressing=provider_prefixed`）；若未來 cursor 支持注入，
  需在 provider catalog 聲明 `modelPlanProtocol` 並重新生成目錄，前端無需再改。

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

## Wave 4-③（自動化規則重構：單一動作語義 + 目標/權限/工具目錄）

### W4③-1 action 欄位選「移除」：OpenAPI + biz 全退役，v2 遷移歸一存量

- 問題：D2 允許「移除或 dormant」。dormant 會留下「consult 規則無 agent 目標
  卻被要求 launch」的殭屍態，且 IsAcceptanceReview 等分支仍纏繞編譯面。
- 決策：**移除**。`AutomationRuleAction` schema、`AutomationRule.action`、
  `PutAutomationRuleRequest.action` 從 OpenAPI 刪除並 regen；biz 刪除
  Action/IsAction/IsAcceptanceReview/ParseReviewVerdict；`automation_rules_v2`
  遷移 **刪除 consult/model-target/空目標行**（無法表達新語義；dev 環境需求方
  已確認可安全歸一），其餘 agent-target 行清空 action 判別值。SQLite 物理列
  保留（寫 '' 常量），避免重建表；`target_kind` 枚舉收斂為僅 `agent`，
  modelPlanId/model/requiredCapabilities 作為 retired 欄位 dormant 保留
  （恆空，寫入被 Normalize 拒絕）——這保住了 ListAutomationRulesByPlan 與
  模型方案刪除守衛的既有形狀。
- 影響：舊 daemon 降級讀新庫會因空 action 失敗（dev-only，可接受）。

### W4③-2 防護資料源從 CollaborationRun 遷到 automation_rule_executions

- 問題：「不再產生 CollaborationRun 卡片」但「防護保留不動」——原 dedup/
  次數/token 預算全部查 collabrun ledger。
- 決策：新增 `automation_rule_executions` 表（主鍵 workspace/rule/source/
  trigger），launch 前先落行（重複觸發/重啟不會二次 launch），launch 失敗行
  標記 `launch_failed` 並照舊計入 run 次數（與舊語義一致）。token 記錄改為
  在目標會話首個終局 turn（completed/failed/interrupted，含 cancel 出局的
  interrupted）時，把其 runtimeContext.usage 四項 settle-once 進該行。
- **計量口徑如實說明**：runtimeContext 頂層 usage 四項來自
  `runtimeTokenUsage`，是「最近一次模型請求」的用量（codex 取
  tokenUsage["last"]，見 packages/agent/daemon/runtime/token_usage.go 註釋），
  **不是會話累計**。因此 token 預算對 spawn 型執行實際幾乎只靠 maxRuns
  兜底——這與被退役的 collabrun agent-action 路徑同源同語義（collabrun
  observer 讀的是同一份 runtimeContext），屬平移而非回歸。若預算要成為
  真實限流，需把口徑改為會話累計（runtime 需上報 cumulative 計數或
  daemon 側自行累加），留待需求方決定。
- 已知邊界：歷史 collabrun 記錄不再參與 dedup/預算統計（切表起點歸零；
  in-flight 觸發窗口極窄，dev 可接受）。

### W4③-3 acceptance review 隨 consult 動作一併退役（連帶語義）

- 影響鏈：issue orchestration 強度檔位中 34-66（原「啟用固定驗收 Review」）
  現在與 <34 相同 = 該會話自動化停用；≥67 僅選 on_task_failed 規則。
  runRule 的 ReviewOutcomes 記錄分支、tuttid 根部 recorder 已刪；
  `IssueManagerService.RecordAutomationReviewOutcome` 與 modelpolicy
  `RecordAutomatedReviewOutcome` 保留 dormant（issues/legacy 域資產，本波
  不擴大刪除面）。agent-gui 的 AgentActivityAutomationRuleSummary.action
  契約欄位保留（agent-gui 本波凍結），desktop 映射恆填 ""。
- 建議：若需求方仍要「自動驗收」，應以新語義重新設計（例如目標 Agent 會話
  產出結構化結論回寫 Issue），不建議復活 consult 特例。

### W4③-4 允許的工具目錄 = capabilityCatalog 非 skill 條目

- 假設：3-3 的「能力目錄」取 composer options `capabilityCatalog`
  （plugin/connector/mcpServer/mcpTool，排除 unsupported 與 skill——Wave 3-②
  已回到 skills 自動同步全部），值為 option.id，與 WorkspaceAgent tools
  存儲值先例一致；空選擇 = 不加約束（繼承目標配置），文案已提示。
- 影響：原自由文本可寫 "browser"/"computer" 控制 daemon 級瀏覽器/計算機
  開關；目錄化後這兩個開關不在 capabilityCatalog 中，暫不可經自動化規則
  表達（daemon constrainWorkspaceAgentTools 語義未動）。
- 建議：若需要，後續給目錄追加兩個合成條目（browser/computer）即可，
  daemon 側無需改動。

### W4③-5 內建 target 的保存校驗只認「存在 + enabled」

- 假設：validateReferences 對非 `workspace-agent:` 前綴目標經新
  `AgentTargetReader`（GetAgentTarget）校驗存在與 enabled，不做
  NormalizeTarget/launch-ref 深校驗——與 issues 域 assignment 校驗先例
  同層級；launch 時 session-create 路徑仍是嚴格權威（StrictPermissionMode
  fail-closed、provider/launch-ref 校驗）。

### W4③-6 首條消息不再內聯來源轉錄，mention 是唯一上下文通道

- 決策：按 D2 字面「提示詞 + mention + 事件說明」三段組成首條消息；原
  48 條/32KB 內聯轉錄複製移除，ContextReader 縮減為僅取來源會話 cwd
  （SourceReader.AutomationSourceCwd）。目標 Agent 經 $tutti-handoff /
  tutti-cli skill 解析 mention 讀取來源上下文。
- 影響：不具 Tutti CLI mention 解析能力的目標（理論上無）拿不到來源正文；
  換來的是首條消息不再無條件外洩整段對話。

### W4③-7 智能生成鏈（Wave 3-② dormant 契約）解耦自動化域

- 現狀：generation.go 的 GeneratedRule.Action 原引用 automationrulebiz
  枚舉；退役後改為普通字串常量 "consult"（preview-only 契約原樣保留，
  等 D1「全鏈路刪除」的契約清理波處置）。生成建議已無法落成自動化規則
  （PUT 無 action 且 consult 目標形狀被拒），純展示殘留。

### W4③-8 執行期失敗完全不可見（review 回派記錄）

- 問題：規則保存後目標可能失效——存量規則的目標 Agent 被 disable/刪除，
  或陳舊 permissionModeId 在觸發時被 StrictPermissionMode fail-closed
  拒絕。此時 launch 落 `launch_failed` 行（消耗該 trigger 並計入 run
  次數，行為安全），但 `automation_rule_executions` 沒有任何 list API 或
  GUI 展示面，用戶只看到「規則沒反應」，唯一線索是 daemon slog
  `automation_rule.session_launch_failed`。
- 附帶：PutRule 保存時不校驗 permissionModeId 的有效性——校驗需按
  provider 拉 composer catalog，save 路徑不宜引入該依賴；編輯器目錄
  （3-3）已在 UI 層把非法值擋在常規路徑之外，陳舊值只在觸發時被拒。
- 建議：後續為 executions 增加查看面（list API + 設定頁規則行內最近
  執行狀態），或至少把 launch_failed 以通知/消息中心形式冒泡。

### W4③-9 無 turn id 的 settle 靠 occurred:<ts> 兜底 dedup（記錄即可）

- 現狀：settledTurnID（service.go）在 Turn 與 TurnLifecycle 均無 turn id
  時退化為 `occurred:<OccurredAtUnixMS>` 作為 trigger 鍵。若某 provider 的
  settled patch 不帶 turn id 且重放時 OccurredAtUnixMS 改變，同一次完成
  理論上可雙發（durable dedup 主鍵含 trigger_id，鍵不同即視為新觸發）。
- 評估：三大主 adapter（codex/claude/cursor）的 settled 報告均攜帶
  turn id，窗口極窄；此兜底邏輯為既有語義原樣保留（本波未改）。
- 建議：若未來接入不帶 turn id 的 provider，應在 adapter 層合成穩定
  turn id，而非依賴時間戳兜底。

### W4③-10 P0 事後修復：live 完全不觸發——測試形狀 vs live 形狀的系統性 gap

- 現象：GUI 實測規則零觸發、`automation_rule_executions` 空表、tuttid.log
  無任何 automation 日誌——單測全綠、兩輪對抗 review 通過之後。
- 根因：`automationTriggerFromState` 只認 State 上的
  `TurnLifecycle{phase:settled,outcome}` / `Turn{phase:settled,outcome}`，但
  **所有三大 live adapter（codex app-server、Claude SDK、standard ACP）都是
  root-provider-lifecycle 形態**：終局事實只以
  `RootProviderTurn{phase:completed}` patch 上報（reporter_state.go 對
  EventRootProviderTurnCompleted 明確不產生 Turn/TurnLifecycle patch），
  canonical settled+outcome 是 store 在 `applyRootProviderTurnTransitionTx` /
  `reconcileRootTurnAfterChildTerminalTx` 聚合中**自己寫出來的**，從不出現在
  任何送達 SessionStateObservers 的 State 裡。觀察者在入口 `!ok` 靜默返回，
  故零日誌。
- 為什麼單測漏掉：所有 ObserveAgentSessionState 測試都手工構造
  `TurnLifecycle{ActiveTurnID:&id, Phase:"settled", Outcome:&outcome}`——一個
  「順著判別條件的實現」再造出來的形狀（連 ActiveTurnID 都違反 ADR 0008
  「settled 後 ActiveTurnID 為空」的快照契約），而不是重放任何 adapter 的
  真實 patch 序列。測試證明了「判別函數對它自己期望的形狀有效」，沒有證明
  「live 上存在會產生這個形狀的上游」。
- 為什麼兩輪對抗 review 也漏掉：review 的證據面停在 automationrule 包內
  （判別條件 vs biz 語義 vs 預算/dedup），沒有向下追問「settled+outcome 的
  State 是誰、在哪條 live 路徑上發出來的」。而倉庫內同形狀消費者（issue run
  observer、collabrun settlement、modelpolicy acceptance）全都長期存在同款
  判別，形成「大家都這麼讀所以形狀一定會來」的錯誤共識；唯一真正把 canonical
  settle 餵給觀察者的先例（`SettleStaleTurnsOnStartup` 的合成輸入）只覆蓋
  啟動重建路徑，正常 settle 路徑從 protocol v2 起就沒有等價物。
- 修復（修在正確的層）：projection 在 canonical root turn settle 提交點
  （`observeRootTurnSettled`，覆蓋正常聚合、子會話 drain、cancel 三條路徑）
  合成與 stale-startup 同款的 settled State 輸入，fan-out 給**專用 opt-in
  觀察者清單**（`SetRootTurnSettleStateObserver`，本波僅掛 automationRules，
  見 W4③-11），附 session 的 agentTargetID/runtimeContext（保住來源匹配、
  rescue 深度與 usage settle-once）；session 讀取失敗/缺行時**放棄本次
  fan-out**（runtimeContext 裡的 automation-origin 標記是鏈式防護唯一斷路器，
  少送優於送錯，durable dedup 保證只是漏一次觸發）。交付語義為
  at-least-once（cancel AlreadySettled 重疊、outbox publish-再-mark 重試），
  觀察者必須自帶冪等。並補 child-session 守衛（codex collab 子線程自己的
  settled patch 不評估規則）。判別條件本身不動。
- 附註（review #5）：合成路徑使用的 `JoinSessionRuntimeContext` 是 panic
  包裝（session_metadata.go:231-237）；輸入是同一 store 剛 split 過的行，
  實際不可達，與既有讀路徑（service_session.go:38,42）同險級，記錄備查。
- 判別性測試教訓：red→green 測試必須**重放 live patch 形狀**（running Turn
  patch → 純 RootProviderTurn completed patch，經真實 sqlite store + 真實
  projection），而不是直接構造判別函數期待的 State。凡是「觀察者判別 State
  形狀」的新消費者，都應以這條 integration 路徑為模板取證上游真實形狀。

### W4③-11 settle fan-out 僅 opt-in 給 automationrule；其餘同形狀消費者維持 live 現狀

- 現狀：canonical root-turn settle 的合成觀察走**專用清單**
  （wiring `SetRootTurnSettleStateObserver`，只註冊 automationRules），不餵
  wiring 547 的全量 SessionStateObservers。issue-run settlement
  （issue_run_observer.go）、collabrun 卡片 settle（collabrun/service.go
  collaborationSettlement）、modelpolicy 驗收自動升級（review_engine.go）、
  appFactory 終態處理在 live 依然收不到 turn settle——**歷史如此**（它們
  判別的 settled State 形狀從 protocol v2 起就沒有 live 生產者），本修復
  不改變其行為。
- 為什麼不一併復活：對抗 review 發現 issue-run 觀察者有真實回歸——live 上
  Issue run 完結歷來靠 agent 自報 CompleteRun + 閒置 grace reconciler
  （issues_reconciler.go:118-172）兜底，天然容忍多輪會話；觀察者路徑零容忍，
  plan/goal/prompt-queue 的多輪會話會在**首輪** turn settle 就被標成
  completed（無 outputs），工作還在跑。其餘消費者亦各有未裁決語義
  （collabrun 卡片何時算 settle、modelpolicy 是否應在每輪完成都上驗收梯）。
- 後續：任一消費者要復活，須先逐個裁決語義（多輪、cancel、automation-origin
  的處理），再掛入專用清單並自帶冪等（交付是 at-least-once）。

### W4③-12 殘餘 child 被 cancel 時 root 以 completed settle，Stop 手勢可觸發 on_task_complete（待裁決）

- 邊角（review #4）：provider root turn 已以 outcome=completed 完結、但仍有
  child 在跑（canonical root 轉 waiting）時，用戶 Stop 取消殘餘 child →
  `reconcileRootTurnAfterChildTerminalTx`（root_turn_completion.go:162-173）
  用**記錄在案的 RootProviderTurnOutcome=completed** settle root——用戶的
  取消手勢在此場景會觸發 on_task_complete 自動化規則。
- 評估：這是 store 既有的 root outcome 語義（provider 事實優先），非本波
  引入；觸發一次且被 dedup 約束。是否應以「用戶意圖」（interrupted/canceled）
  覆蓋 outcome、或在自動化判別側對此類 settle 降級，留待需求方裁決。

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

## Wave 4-②（契約清理：2-1 / 2-6 / 2-8 / 2-9 + dormant 透傳）

### W4②-1 欄位映射裁定：2-7 dormant vs 2-9 刪除

- 問題：spec 2-7「兼容能力（Skills/插件/連接器選擇）」與 2-9「高級能力與 ID
  與權限」未逐欄位對應到 WorkspaceAgent OpenAPI schema。
- 裁定：
  - `capabilitiesExplicit` / `skills` / `tools` → **2-7，dormant 保留**。
    依據：2-7 原文點名「Skills/插件/連接器選擇」，`tools` 存儲值正是
    capabilityCatalog 條目 id（plugin/connector/mcp\*，W4③-4 同源），
    `capabilitiesExplicit` 是該白名單機制的開關，三者是同一機制。
  - `permissions` → **2-9，全鏈路刪除**（任務書明示）。
  - 2-9 的「ID」指編輯器的只讀 Agent ID 展示區（W3-② 已拆 UI）；`id` /
    `agentTargetId` 是結構性身份，不屬可刪契約面，契約無對應刪除項。
  - `modelFallbacks` → 2-5 dormant（既定）；`enabled` → 2-8 刪除（既定）。
- 影響：2-9 在契約層的淨刪除面 = `permissions` 一個欄位 + generation 端點簇
  （2-1）+ `enabled`（2-8）+ `purpose` 重命名（2-6）。

### W4②-2 tools 歸 dormant ⇒ constrainWorkspaceAgentTools 交集邏輯保留

- 決策：`tools` 屬 2-7 dormant，因此 workspace_agent_resolution.go 的
  constrainWorkspaceAgentTools（自動化規則 allowedTools 與 WorkspaceAgent
  存量 tools 求交集、只窄不寬）**原樣保留**，繼續讀存量數據；未改
  runtimeprep 語義，automationrule 測試不受影響。
- 備選（未採納）：若 tools 改判 2-9 刪除，規則工具將直通 runtimeprep（與
  內建 target 一致），需刻意重定義「規則允許工具 = 精確生效集」語義並改
  daemon_executor 測試。記錄於此供需求方覆核。

### W4②-3 permissions 刪除連帶：權限模式推導路徑退役

- 現狀：舊鏈路允許在 permissions 裡寫 `permissionModeId:<id>` 由 daemon 在
  launch 時推導默認權限模式（applyWorkspaceAgentCapabilityDefaults）。
- 決策：隨 `permissions` 全鏈路刪除，該推導分支與
  workspaceAgentPermissionModeID 助手一併刪除。權限模式的正規來源維持:
  composer 顯式選擇 / 自動化規則 permissionModeId / provider 默認。
- 影響：歷史上依賴該旁路的 Agent（若有）launch 後回落 provider 默認權限
  模式；W3-② 已確認編輯器從未暴露過此欄位的結構化輸入。

### W4②-4 runtime snapshot 的 purpose 鍵向後兼容讀

- 問題：session runtime snapshot 是 durable 會話數據，舊會話的
  `agentDefinition.purpose` / `agentDefinition.permissions` 鍵無法遷移。
- 決策：新快照寫 `description` 鍵；讀取側 `description` 優先、回退
  `purpose`（TestSessionRuntimeSnapshotReadsLegacyPurposeKeyAsDescription
  錨定）；`permissions` 鍵讀取直接忽略（map 解析天然容忍多餘鍵），不做
  快照重寫、不升 snapshot version（純增量兼容）。
- 影響：舊會話 resume 全程無感；composer options runtimeContext 的
  `workspaceAgent.purpose` 鍵同步改名 `description`（全倉 grep 無 TS 消費者，
  屬 ephemeral 投影非 durable 數據）。

### W4②-5 存儲遷移形狀：加列拷貝 + 常量歸一,物理列不重建

- 遷移 `workspace_agents_contract_cleanup_v1`（applyWorkspaceAgentsV5）：
  `ADD COLUMN description` + `description = purpose` 拷貝（保數據）;
  `enabled <> 1` 歸一為 1；`permissions_json` 清為 `[]`。
- 沿用 W4③-1 automation_rules_v2 先例：`purpose`/`enabled`/`permissions_json`
  物理列保留（SQLite 刪列需重建表），新代碼不再讀寫（INSERT 靠列默認值）。
  `purpose` 列拷貝後保留原文（利於降級可讀），但此後不再更新——降級舊
  daemon 會讀到陳舊 purpose,dev-only 可接受。
- 升級方向（review 回派補記）：舊 client → 新 daemon 滾動升級窗口內，舊
  desktop 的 PUT 仍發 `purpose` 欄位——新 daemon 的 workspaceAgentPutInput
  只讀 `body.Description`，Go json 解碼忽略未知欄位，該次保存會把
  description 存成空串，舊文案丟失（僅該行、僅該次編輯）。dev-only 可接受，
  記錄備查。
- 遷移重入（review 回派補記）：V5 自身的重入路徑（marker 已寫後再調
  applyWorkspaceAgentsV5）無直接測試，靠 `hasMigration` 守衛短路——與
  V2-V4 同構模式，風險極低，記錄備查。
- 判別性測試：TestWorkspaceAgentsMigrationBackfillsLegacyBindingIdempotently
  擴展覆蓋「pre-v5 存量（purpose 文本 + enabled=0 + permissions 覆寫）升級後
  description 就位、retired 列歸一」；enabled=false 行升級後 Resolve 可過由
  服務層測試（Resolve 已無 enabled 分支）+ 存儲歸一共同保證。

### W4②-6 遺留索引：idx_workspace_agents_directory 前綴仍是退役的 enabled

- 現狀：V1 建的 `idx_workspace_agents_directory` 索引前綴為
  `enabled DESC`（migrations_workspace_agents.go），本波列表查詢改為
  `ORDER BY updated_at_unix_ms DESC, name ASC, agent_id ASC` 後不再匹配該
  索引前綴（enabled 遷移後恆為 1,前綴實際退化為常量）。
- 影響：workspace 級 Agent 目錄規模極小，無實際性能影響；純遺留。
- 建議：未來需要重建 workspace_agents 表或索引時順手改建為
  `(workspace_id, updated_at_unix_ms DESC, name ASC)`，本波不動。

### W4②-7 「已停用」狀態語義收斂與生成殘留清理

- 狀態點：Agent 卡片二態化——Runtime 可用（綠 `agents.ready`）/ Runtime
  不可用（紅 `harnessUnavailable`）；「已停用（灰）」隨 enabled 退役。
  `agents.disabled` key 保留：編輯器內建 Runtime 目錄的停用後綴仍在用
  （那是 AgentTarget.enabled,另一概念，W4③-5 的 validateReferences 依賴，
  未動）。
- 2-1 生成鏈全刪清單：OpenAPI `generate-draft` path + 4 個 schema、
  `service/workspaceagent/generation.go`(+test)、API handler 與
  GenerateConfiguration 接口、wiring Completer 注入、tuttid-ts client 方法、
  desktop 各 stub。W4③-7 記錄的「dormant 生成契約」隨之出清。
- 附帶：generation schema 刪除後 oapi-codegen 的枚舉去衝突前綴消失，
  `CollaborationRunModeConsult` 等常量重命名為 `Consult` 等（生成器行為，
  collabrun 語義零改動，daemon_collab_runs.go 一處引用同步改名）。

### W4②-8 ValidateAutomationAgentReference 失去 disabled 拒絕分支

- 現狀：自動化規則保存時對 workspace-agent 目標的嚴格校驗原有三類拒絕:
  Agent disabled / Harness 不可用 / Plan 不可用。enabled 退役後餘兩類。
- 影響：歷史上被停用的目標 Agent 在遷移後重新變為可觸發——這正是 2-8
  「移除開關」的預期語義（不存在停用態）；如需臨時停用某 Agent 的自動化，
  正規做法是停用規則本身（AutomationRule.enabled 保留）。

## Wave 4-⑤（P1 回派：純內建 Codex 首頁裸方案模型 create 400——Wave 3 門禁漏網路徑）

> 2026-07-23 后续修订：create 边界不再通过
> `enforceComposerModelBindingForCreate` 改写提交参数。权威模型目录完成读取后，
> composer defaults authority reconciler 会同步清理内存 ref、React state 和
> node 持久化中的失效默认值；create 只读取已完成 reconciliation 的默认值。
> 下文关于 create 门禁及 unverifiable 窗口摘除模型的内容保留为历史决策记录，
> 不再描述当前实现。

### W4⑤-1 W2⑤-3 的「models 名單為空放行」例外撤銷（門禁語義修訂）

- 根因（live 復現定位 + 對抗 review 修正）：Wave 3 的 create 門禁
  `enforceComposerModelBindingForCreate` 的「視為已驗證」漏網窗口：
  (a) options 已載入但 `models` 名單為空——W2⑤-3 第 2 條的顯式例外；
  (b) **請求模型被播種進名單的自我引用**，且有**兩層播種**：
  bootstrap 冷載時 `composerSelectedModelOptions(effectiveSettings.Model)`
  把請求模型回作唯一選項（composer_options.go:225、480），而 **settled
  warm 目錄**投影同樣把不在目錄裡的請求模型 append 進多條目名單
  （composer_model_options.go 的 `selected != "" && !containsModelOption →
append`）；desktop 投影還有第三層 GUI 自身的
  `appendCurrentOption`（agentComposerOptionsProjection.ts）。GUI 拿這些
  名單驗證「模型在不在名單裡」是循環論證。
- **正確的 400 敘事（review 修正）**：純冷載窗口本身不產生 400——目錄冷時
  create 校驗 `availableComposerModelsForValidation` !ok 即跳過
  （model_validation.go:52，fail-open）。live 的 400 必然發生在「create 時
  daemon 目錄已 warm」：warm 多條目名單含 append 的毒模型 → 門禁 verified →
  payload 帶裸模型 → create 校驗只對原始目錄（不含 append）→ 400。
  codex/opencode/tutti-agent（UsesModelCatalog）同病；claude-code 無恙
  （authoritative + 校驗 fail-open + 自定義模型是產品行為）。
- 修訂決策：裸模型必須被**正面驗證**才放行。名單條目引入 **provenance
  契約**（本輪已做，daemon+GUI 雙側）：daemon 對「鏡像請求」的條目顯式標記
  `requested: true`（settled warm append 與 bootstrap 回聲兩處；
  ComposerConfigOptionValue.Requested → runtimeContext configOptions
  `requested` 鍵 + OpenAPI `AgentProviderComposerConfigOptionValue.requested`
  可選欄位，已 regen Go/TS 生成物；desktop `appendCurrentOption` 同樣自標）。
  GUI 三態判定只拿**非 requested 條目**當目錄證詞：options 缺失/
  `modelOptionsLoading`/剔除後空名單一律 unverifiable → create 摘除模型
  （daemon 用默認）；「單條目且鏡像 effectiveSettings.model」啟發式保留，
  僅作為對「未帶標記的舊快照」的向後兼容兜底。W2⑤-3 的空名單放行例外
  就此撤銷。完整 {model, modelPlanId} pair 照舊放行（daemon
  `applyRequestedModelPlan` 全量校驗）。claude-code 的 static 自定義模型
  append（composer_live_model_discovery.go `staticClaudeComposerModelOptions`）
  **刻意不標記**——那是「配置的自定義模型應可選」的產品行為，標記會讓 GUI
  摘除合法自定義模型。
- 契約鏈路核查：composer options 僅經 HTTP GetComposerOptions 傳輸，
  不經 push 事件（activity.updated.event.json 無 configOptions/modelConfig
  欄位），無 event schema strict gate 風險；runtimeContext 為
  additionalProperties:true 自由形態，configOptions 的 `requested` 鍵
  無需 schema 變更。

### W4⑤-2 首頁默認新增「目錄證詞正面拒絕即回落」策略（與 sanitize 非權威語義並存）

- 決策：純 provider 首頁的 composer 默認經
  `enforceComposerModelBindingForHomeDefaults`——settled 目錄證詞（剔除
  requested 條目後的名單）**正面拒絕**的裸模型不採納（顯示與存量 draft
  同步回落 null → provider 默認），並作用在分層合併結果上。
- 機制修正（review 回派）：preloaded 層復活的依據不是「daemon per-target
  prefs 被污染」——純 provider 目標的 GetComposerOptions 對 model 從不回
  持久化偏好，`effectiveSettings.model` 永遠只是**請求的回聲**（daemon 只
  回填 permissionModeId/browserUse/computerUse 類偏好）。復活環是：污染的
  node defaults 被帶進 options 請求 → 響應 effectiveSettings + append 條目
  鏡像它 → preloaded 層把它填回顯示。回落寫回 node defaults 切斷的正是
  這個自我固化環（下輪請求不再帶毒模型）。
- 表述修正（review 回派）：上一版「顯示≠提交、無 400」只對 provenance
  契約落地後成立；**修復前的 warm 窗口**（append 未標記）顯示與 create
  同時被騙，400 照發——這正是 F1 主窗口。本輪 provenance 落地後，warm
  名單裡的毒模型條目帶 `requested: true`，顯示端（rejected → 回落）與
  create 端（非目錄證詞 → 摘除）雙雙封住；殘留風險僅剩「舊快照無標記 +
  多條目 warm 名單」的滾動升級窗口（GUI 啟發式只覆蓋單條目回聲）。
- 與既有語義的邊界：`sanitizeComposerSettingsForOptions` 的
  `modelOptionsAuthoritative` 契約（非權威 provider 保留名單外模型）**原樣
  保留**——首頁默認策略是「跨會話撿回來的默認值」的採納規則，不改變
  sanitize 的通用清理語義。
- 已知取捨：unverifiable 窗口首頁**不摘除**存量默認——避免瞬態載入態
  破壞性覆寫合法記憶模型；create 門禁仍拒發。若需求方要求顯示也嚴格，
  需先解決「窗口內無可靠 provider 默認可展示」的 UX 語義。

### W4⑤-4（F2）unverifiable 窗口內合法記憶模型被靜默換成 daemon 默認（行為取捨，記錄）

- 現象：options 未載入/`modelOptionsLoading`/目錄證詞為空的秒級窗口內
  submit，create 門禁會把**合法的**裸記憶模型（如 gpt-5.6-sol）一併摘除，
  會話以 daemon 默認模型創建，無任何提示。
- 取捨依據：fail-safe 原則（寧可不帶不可帶錯）+ 窗口極短（options 載入
  完成即恢復）；替代方案（阻塞 submit 等 options、或帶模型讓 daemon 裁決）
  各有更差的 UX/一致性代價。記錄待需求方裁決是否需要「已回落默認模型」的
  輕提示。

### W4⑤-5（F3）真單模型 provider 的回聲兜底啟發式誤判（多數無害，記錄）

- 現象：GUI 對「未帶 requested 標記的單條目名單且鏡像 effectiveSettings」
  的向後兼容啟發式，會把**真的只有一個目錄模型且被選中**的 provider 判為
  unverifiable——該裸模型在 create 時被摘除，daemon 回落默認（通常就是
  同一個模型），故多數無害。provenance 契約全面落地（所有響應帶標記）後
  可考慮移除該啟發式，屆時單條目未標記名單即為真目錄。

### W4⑤-3 方案會話是否應寫 provider lastActive 桶（產品語義，待裁決）

- 現狀：`useAgentGUISessionPresentation` 把活躍會話的 {model, modelPlanId}
  成對寫入 **provider 鍵**的 lastActive 桶；純 provider 首頁 create 時若無
  自身默認會繼承該 pair（Wave 3 語義），帶 planId 的 create 由 daemon
  `applyRequestedModelPlan` 校驗放行——即**純內建首頁的新會話可能靜默走
  方案端點**（計費/配額歸方案）。這是 Wave 3 的既定繼承語義，本輪未動。
- 殘留寫入路徑：**建立於 modelPlanId 落庫之前的老方案會話**，其 runtime
  snapshot 無 ModelPlanID（session_runtime_snapshot.go 的 stamp 是後來
  引入的），resume 後 session state settings 只有裸 model → lastActive 桶
  被寫入裸方案模型。本輪修復後該裸 id 在 create/首頁均無害（unverifiable/
  rejected 摘除），但桶本身仍髒。
- 待裁決：(a) 方案會話是否根本不該寫 provider 桶（改寫 target 級桶或
  丟棄）；(b) 純 provider 首發繼承 pair 是否需要顯式 UI 提示（「將經
  <方案名> 計費」）；(c) daemon 是否應在 resume 老會話時按 target 綁定
  回填 modelPlanId（消滅裸寫入源頭）。
