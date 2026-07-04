# Codex App-Server 層重構 — 設計文檔

- 日期：2026-07-01
- 分支：`refactor/codex-appserver-layering`
- Baseline：已 rebase 到 `origin/main`（含 #602 thread-scope、#604 session recycling、#608 attach hydration）
- 狀態：設計（決策已鎖，可進實作規劃）
- 英文版：`2026-07-01-codex-appserver-refactor-design.md`

## 問題

tutti 已接入 Codex **App Server**——`packages/agent/daemon/runtime/codex_appserver_adapter.go` 實作了 `Start / Resume / Exec / Cancel / SubmitInteractive`，並把 server request 投影成 approval / interactive prompt。功能是通的，但裡面糾纏著**兩種不同的債**。

### 1. 可維護性債（看得見的那種）

- **沒有 typed protocol 邊界。** 方法是手維護字串常數（`appServerMethodThreadStart = "thread/start"` …），payload 靠手拼 `map[string]any`。協議漂移只能靠人和測試守。
- **糾纏的巨檔。** Codex runtime 層把 transport、lifecycle、協議、event reduce、approval 全揉在幾個超大檔案：

  | 檔案                                         | 行數 | 混在一起的職責                      |
  | -------------------------------------------- | ---- | ----------------------------------- |
  | `codex_adapter.go`（Codex-over-ACP，legacy） | 3451 | initialize / prompt / lifecycle     |
  | `codex_appserver_adapter.go`                 | 2209 | lifecycle + 方法字串 + payload 組裝 |
  | `codex_appserver_events.go`                  | 1816 | event reduce / 映射                 |
  | `codex_appserver_review.go`                  | 140  | review                              |
  | `codex_appserver_startup_trace.go`           | 187  | startup trace                       |

  約 7.8k 行手寫，覆蓋協議 surface **更少**，卻比最乾淨參考（`codex-sdk-go`）的「約 1.6k 行手寫 + 生成型別」更難維護。

### 2. 正確性債（真正在產 bug 的那種）

我們從真實 bug 記錄（已 merge 的 PR + log 分析 session）反推設計目標。改寫本次定位的關鍵發現：

> **手寫協議字串產出的 user-facing bug 約等於 0。** 反覆出現的 bug 全部聚在**四台目前隱式、且互相糾纏的狀態機**，不在協議邊界。

| 群                                                               | 症狀 & 來源                                                                                                                                                                                    | 病根                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. daemon↔desktop hydration / optimistic reconcile**（最高頻） | 「用戶發完訊息、自己的訊息不見、只看到 Agent 回覆」（session `7633ebb9` / `2d73bad7` / `08920807`）；#608 attach 後 hydrate；#585 / `aab952ba` keep submitted prompts / drain queued prompts。 | desktop 自己做 optimistic echo + version 追蹤 + reconcile，事務邊界脆弱，是「第二套 core」的活體反例。**注意：真正的錯在 desktop** —— daemon 正確地在 `version=1` 持有 user row；是 desktop 把 `after_version=1` 推出去卻從未 paint。 |
| **B. thread / sub-agent 身分**                                   | #602 foreign-thread 事件被丟棄。                                                                                                                                                               | `session ≡ thread` flat 模型；子 agent 的子 thread 無處可去，#602 只能用 `appServerNotificationThreadMismatch` 把它**丟掉**。                                                                                                         |
| **C. turn / compaction 生命週期**                                | 上下文 100% 後點壓縮失敗（session `67009835`）；`4118312f` compact 要等 `turn/completed` 才能關；`2412b08d` 累計 token 造成假壓縮警告。                                                        | turn 生命週期（含 compact 這種特殊 turn）不是健壯、顯式的狀態機。                                                                                                                                                                     |
| **D. session / live-session 生命週期**                           | #604 把 idle-recycle 外掛進 `controller.go`（2592 行）。                                                                                                                                       | live-session lifecycle 是外掛的，不被任何一層擁有。                                                                                                                                                                                   |
| **E. approval / 授權**                                           | #418 approval 指令細節沒顯示；cua driver 授權/重啟卡住（`1ec14c03`）。                                                                                                                         | approval 投影 & 授權時序。                                                                                                                                                                                                            |

**重定位的設計目標。** 本次仍是 **shape-first（選項 C）**——但形狀是**載體，不是目的**。目的是把四台糾纏的狀態機（thread / turn+compact / session-lifecycle / hydration-snapshot）收斂成**顯式、單一擁有者、有測試的層，讓每一類 bug 結構上不可能發生**。codegen typed 邊界（§ D2/D3）**從「重點」降級為「使能基礎設施」**：它是讓每一層「乾淨蓋起來、而非再打 patch」的前提。能力追齊仍是後續另一輪工作。

## 目標與範圍

**範圍內**

- 把 App-Server 接入重構成分層、單一職責的單元，底墊 typed protocol 邊界，四台狀態機各由恰好一層擁有。
- **預設 behavior-preserving，例外處改正正確性：** 凡是當前行為屬於已知 bug/patch（上表各群），重構用 by-construction 的做法取代 patch，並把該 bug 的個案變成 regression test（見 § Bug 語料）。
- 把 legacy **Codex-over-ACP** adapter（`codex_adapter.go`）作為最後清掃退場——**不動**其他 agent 在用的通用 ACP 棧。

**範圍內、僅 daemon 半（群 A）：** hydration 契約的 daemon 側——一份 `clientSubmitId`-keyed、無縫、可全量 resync 的 snapshot，讓 desktop _有能力_ 自我修復。

**明確不在範圍（延後）**

- **desktop 的 optimistic/reconcile 重寫（群 A 的 desktop 半）。** 病根在 renderer，是不同層、不同爆炸半徑。獨立成最後一步（Step 9）/ 另一輪工作，蓋在本次凍結的 daemon 契約之上。
- 新增協議能力（fork / compact / realtime / inject_items 的產品化）。codegen 讓它們可用；接進產品是另一件事。
- **子 agent 巢狀活動可視化**（渲染子 thread 的逐步活動）。本次只把子 thread 事件路由回父的 collab 工具卡（§ D10）；可展開的巢狀視圖延後，且 thread registry 讓它日後很便宜。
- Provider-relay / 第三方模型（另一條產品線，見 CodexBridge `codex-provider-relay`）。

## 關鍵決策

| #         | 決策                                                                                                                                                                                                                                                                        | 理由                                                                                                                                                                                                                                                                            |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1        | **只退場 _Codex-over-ACP_ 路徑（`codex_adapter.go`）。** app-server 是 Codex 唯一未來路徑。**通用 ACP 棧保留**——其他 agent 透過它接入。                                                                                                                                     | 產品方向。`standard_acp_adapter.go`（Gemini / Hermes / Claude / 未來 agent）與共用 ACP 基礎設施留著；只有 Codex 對 ACP 的使用退場。                                                                                                                                             |
| D2        | **typed protocol 邊界來自「錨定官方上游 schema 的 codegen」**，非手寫 struct，也非 vendor 外部 SDK。                                                                                                                                                                        | 官方 `codex-rs/app-server-protocol` 帶 `src/bin/export.rs`，吐 JSON Schema + TS。上游是唯一 source of truth，漂移自動可見。                                                                                                                                                     |
| D3        | **codegen 一步到位**——不做手寫過渡 struct。                                                                                                                                                                                                                                 | 避免「先建 typed 又拆掉」的返工；pipeline 很小且下游已驗證。                                                                                                                                                                                                                    |
| D4        | **JSON-RPC 傳輸本來就共用，且維持共用。** `acp_client.go` 是通用 JSON-RPC-over-stdio client（`newACPClient` + `newAppServerJSONRPCClient`），當通用基礎設施**保留**。重構在它**之上**為 Codex app-server 路徑加 typed `Client` façade；通用 ACP adapter 繼續用共用 client。 | 在共用 client 之上做 typed 邊界，不是合併/移除傳輸。                                                                                                                                                                                                                            |
| D5        | **不把 `codex-sdk-go` 整包 vendor 進 daemon 內核。** 當 pipeline 模板 + 骨架參考 + 校準基準。                                                                                                                                                                               | daemon 內核供應鏈信任；它的 facade 語意是它自己的產品取捨。                                                                                                                                                                                                                     |
| **D6**    | **設計目標是把四台狀態機（thread / turn+compact / session-lifecycle / hydration-snapshot）收斂成顯式單一擁有者的層；codegen 是使能基礎設施，不是目的。** 每層的驗收是「讓某類 bug 結構上不可能」，用 bug 語料驗證。                                                         | 從真實 bug 記錄反推：是糾纏、不是手寫字串在產 bug。#602 的教訓——在糾纏的層裡修 bug 只會再複製它——逼出「先把層弄乾淨，再 by-construction 修」。                                                                                                                                  |
| **D7**    | **reducer/resolver 的縫就是型別（`activityshared.Event`），不是新的跨協議 interface。** 規則：任何碰 `activityshared.Event` 的簽名裡不准出現 Codex 線協議型別。                                                                                                             | `activityshared.Event` 本就與 agent 無關（typed `EventPayload`、`Provider` 欄位、無 Codex/ACP 字眼），且三個 adapter 已都吐它。橫跨 ACP + app-server 的 `Reduce(Notification)` 需要一個假的統一輸入型別。等到第二個真實作（未來 standard_acp 重構）才萃取真正共用的 interface。 |
| **D8**    | **thread 升為一等物件 + registry；路由取代 #602 的 drop-filter。** typed `Client` 持 `threadId → thread context`，把每個 notification 路由到對的 per-thread reducer。                                                                                                       | `session ≡ thread` flat 模型是整個 foreign-thread bug class 的根。路由（非過濾）讓它結構上不可能，且對齊 `codex-sdk-go` 的 `Thread/TurnHandle`。                                                                                                                                |
| **D9**    | **群 A：daemon 契約在本次；desktop 重寫延後（Step 9）。** 本次保證 `clientSubmitId`-keyed、無縫、可 resync 的 snapshot；desktop optimistic/reconcile 重寫獨立成最後一步。                                                                                                   | 病根在 desktop；把 renderer 拉進 daemon 分層重構會破壞「一步一層」紀律、爆炸半徑跳級。先凍結契約，讓 desktop 修復有地基。                                                                                                                                                       |
| **D10**   | **子 agent 的子 thread 事件路由回父 collab 工具卡；巢狀可視化延後。**                                                                                                                                                                                                       | 子 agent 是父 thread 裡的子 thread，在父對話只呈現成一張 `collabAgentToolCall`。路由（D8）讓卡片帶上準確的最終狀態/輸出/錯誤——正是 #602 用 `appServerCollabAgentRawOutput` 想硬撈的。逐步巢狀視圖動到 renderer（不在範圍），日後靠 registry 很便宜。                            |
| **Ops-1** | 生成的 protocol 包：**`packages/agent/daemon/runtime/codexproto`**（跟消費端同 module；日後別的 Go module 要用再上移）。                                                                                                                                                    | 摩擦最小；不預先共享。                                                                                                                                                                                                                                                          |
| **Ops-2** | schema 產物：**vendor（commit）+ CI 漂移檢查。** commit `export` 產物，build 不需 Rust、可重現；CI 從 pin 的 codex checkout 重生成並 diff 抓漂移。                                                                                                                          | 可重現與新鮮度兼得。                                                                                                                                                                                                                                                            |

## ACP surface：保留 vs 移除

`packages/agent/daemon/runtime` 裡的 ACP 程式碼是**通用多 agent 棧**，上面疊一層 Codex 專屬 adapter。只移除 Codex 專屬那層。

| 檔案                                                                   | 處置               | 原因                                                                                                                                                                                   |
| ---------------------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `standard_acp_adapter.go`（3503）                                      | **保留**           | 通用 ACP adapter，服務 Gemini / Hermes / Claude / 未來 agent（`NewGeminiAdapter`、`NewHermesAdapter`…）。可複用路徑。per-agent 差異已用 `standardACPConfig` 參數化，不是新開 adapter。 |
| `acp_client.go`（823）                                                 | **保留**           | 通用 JSON-RPC-over-stdio client，本就雙用途（`newACPClient` + `newAppServerJSONRPCClient`）。通用 ACP adapter _與_ Codex app-server 路徑共用。                                         |
| `acp_live_state.go`、`acp_restore_errors.go`、`acp_turn_normalizer.go` | **保留**           | 共用 helper。`acpTurnNormalizer` 已驗證三方共用（codex-over-ACP、codex-app-server、standard-ACP）。通用 turn/state 正規化，非 Codex 專屬。                                             |
| `codex_adapter.go`（3451）                                             | **移除（Step 8）** | Codex-over-ACP adapter——legacy 路徑。                                                                                                                                                  |
| `codex_appserver_*.go`                                                 | **重構**           | 本次工作主體。                                                                                                                                                                         |

**刪除的不變量（Step 8）：** 移除 `codex_adapter.go` 後必須讓通用 ACP 棧完全正常；其測試（`standard_acp_adapter_test.go`、`acp_*_test.go`）保持綠。共用 `acp_*` helper 裡任何 Codex-only 分支就地剪除，不是靠刪 helper。

## 四台狀態機 → 擁有它的層

| 狀態機                              | 群  | 擁有的層 / 步                                             | by-construction 的修法                                                                |
| ----------------------------------- | --- | --------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| **thread 身分**                     | B   | typed `Client` 的 thread registry（Step 3）               | 依 `threadId` 路由，不再丟棄 foreign thread。                                         |
| **turn + compaction 生命週期**      | C   | reducer（turn 事件，Step 4）+ facade（Step 5）            | 顯式 turn 狀態機；compact 是一等特殊 turn（只在 `turn/completed` 關；token 正確計）。 |
| **session / live-session 生命週期** | D   | Thread/Turn facade（Step 7），與 `controller.go` 對齊     | facade 擁有 idle 偵測/recycling，不再外掛。                                           |
| **hydration / snapshot 契約**       | A   | reducer 產物（Step 4，daemon 半）+ 延後 desktop（Step 9） | daemon 吐 `clientSubmitId`-keyed、無縫、可 resync 的 snapshot；desktop 不再猜。       |

## 參考對照（按 concern 分別借鑑，絕不 mono-copy）

| 層 / concern                                                      | 最佳參考                                                                                                                                              | 備註                                                                                                                                          |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 協議 source of truth（型別、method surface）                      | **官方 `codex-rs/app-server-protocol`** 的 `bin/export`（JSON Schema + TS，`--experimental`）                                                         | 其他都是它的下游。                                                                                                                            |
| event 語意 / lossless tier                                        | **官方 `app-server-client`**（in-process + remote 壓成同一個 `AppServerEvent`；deltas / `item/completed` / `turn/completed` 必送達，progress 可降級） | 權威 backpressure 設計；直接指導群 A 的 snapshot 契約。                                                                                       |
| Go 分層（Transport / Client / typed stubs / facade）+ 一等 Thread | **`codex-sdk-go`**                                                                                                                                    | 同語言；約 1.6k 行手寫覆蓋 ~90 client + 9 server method，靠生成的 `types_gen.go`。它的 `Thread/TurnHandle` 是 D8 thread registry 的目標形狀。 |
| event reducer / tool 映射                                         | `ai-sdk-provider-codex-asp` 的 `CodexEventMapper`                                                                                                     | 跨 turn tool-result 回填、worker affinity（需要時）。                                                                                         |
| approval → durable pending state                                  | `openclaw-codex-app-server` 的 pending-input 模型                                                                                                     | approval/user-input 變 durable state + UI 驅動回覆，非同步卡死的 RPC handler。                                                                |
| non-destructive hydration；approval stall detection               | `Agmente`（優先 loaded-thread read）、`CodexBridge`（批准後無 signal 卡死偵測）                                                                       | 指導群 A/E 的修法與 reducer/resolver 介面。                                                                                                   |

## 不變量（tutti 架構鐵律）

thread / turn / approval / history 的 reconciliation 屬於 daemon（`services/tuttid` / `packages/agent/daemon`）。`apps/desktop` 只消費 typed state/events 並提交命令（approve / interrupt / start-turn）。**桌面不得長成第二套 Codex business core。**

**判別測試（litmus）：** 桌面需不需要知道 Codex 的 wire 格式？

- 需要（碰 method 名 / event schema / JSON-RPC）→ 正在長成第二套 core → **違反。**
- 只知道 tutti 自己的 `AgentActivity*` typed 領域 → **正確。**

**重構後對這條的驗收：** 桌面能拿到的東西不能比重構前更「靠近 Codex 原始協議」。lossless tier 必須抵達 daemon 的 typed 事件；桌面永遠只看 tutti 領域型別。（群 A 的 daemon-半契約，就是讓桌面**不碰 wire** 也能拿到它需要的一切。）

## 目標架構

```
                                   ┌─ Event Reducer ──────→ tutti typed activity events（lossless tier）
                                   │   + hydration/snapshot 契約（clientSubmitId-keyed、可 resync）
Transport ──→ typed Client ──→ Thread ┤
 (stdio)      (pending req      registry ├─ Approval Resolver ──→ durable pending state + typed responder
              / server req      (threadId │   （server requests）
              / notif sub)      → context)└─ Thread/Turn Facade ─→ lifecycle 編排
                  ▲              per-thread     （session + live-session recycling；收薄後的 adapter）
                  │              路由；
                  │              子 thread → 父 collab 卡片（D10）
           codexproto 包（codegen；錨官方 export；
                           版本戳；CI 漂移檢查）  — 使能基礎設施
                  ▲
       共用 JSON-RPC client（acp_client.go）── 同時服務 ──▶ 通用 ACP 棧
                  ▲                                         (standard_acp_adapter.go：
       Codex-over-ACP adapter（codex_adapter.go）           Gemini / Hermes / Claude …)
       — legacy，Step 8 刪除                                 — 保留

  [延後 Step 9 / 另一輪] desktop optimistic/reconcile 重寫，
  消費本次凍結的群 A snapshot 契約。
```

## 多步對齊計畫

四台狀態機全部收斂，但拆成可獨立 ship 的步驟。順序：安全網 → 加法式 codegen → 由下往上（transport → thread → events → turn → approvals → facade）→ legacy 刪除 → 延後 desktop。每步讓工作區測試保持綠，並落地它那類 bug 的 regression test。

### Step 0 — 特徵化安全網 + bug 語料

- 把既有 `codex_appserver_*_test.go` 確立為行為契約。
- **把 bug 語料補成 regression test**（群 A/B/C/D/E——現在都綠，因修復已 merge）；重構全程保持綠，且凡用新結構取代 patch 處，要維持同樣的可觀察結果。
- 薄弱處補 golden 測試：event reducer 產出、approval/interactive 投影。
- pin 一個 Codex 版本 baseline。
- **出口：** 一組（含 bug 語料）後續每步都必須維持綠的測試。

### Step 1 — typed protocol 層（codegen，一步到位）· _使能基礎設施_

- 新包 `packages/agent/daemon/runtime/codexproto`：跑官方 `export` → 生 protocol types + RPC stubs → 版本戳。vendor 產物（Ops-2）。
- 加 CI 漂移檢查（從 pin 的 codex checkout 重生成後 diff）。
- **純加法**——還沒人消費它。
- **出口：** 生成的 typed 層可 build；CI 跑漂移檢查。

### Step 2 — 在共用傳輸之上加 typed Client façade

- 為 Codex app-server 路徑加 typed `Client`（pending requests、server-request 處理、notification 訂閱），對齊 `codex-sdk-go` `rpc/`，**包住既有共用的 `acp_client.go`**，而非取代它。
- app-server adapter 改用 typed stub（`codexproto`）呼叫，而非字串 + `map[string]any`。
- **不要**刪除或重構 `acp_client.go` 或通用 ACP adapter。
- **出口：** Codex app-server 路徑透過 typed `Client` 說話；通用 ACP 棧不動；測試綠。

### Step 3 — Thread registry（狀態機 B）

- 把 thread 升為一等物件：`Client` 持 `threadId → thread context`，把每個 notification 路由到對的 per-thread reducer。
- **路由取代 #602 的 `appServerNotificationThreadMismatch` drop-filter。** 子（sub-agent）thread 路由到自己的 context；其結果折疊回父的 `collabAgentToolCall` 卡片（D10）。
- **出口：** foreign-thread bug class 結構上不可能；#602 regression test 靠路由（非丟棄）通過；drop-filter 被移除。

### Step 4 — Event Reducer + hydration/snapshot 契約（狀態機 A，daemon 半）

- 把事件處理從 1816 行檔案抽成專職 reducer：app-server notification → tutti typed activity event。
- 內建官方 **lossless tier**：deltas / `item/completed` / `turn/completed` 保證送達；progress 類可降級。
- **定義 daemon snapshot/hydration 契約：** 完整、`clientSubmitId`-keyed、無縫、可全量 resync——讓「沒 paint 但真實」的 user row 不會被 `after_version` 跳過，desktop 永遠能還原真相。
- **出口：** reducer 成為獨立、可測試單元；群 A snapshot 契約在 daemon 邊界被定義並測試；adapter 不再 inline 解析 raw notification。

### Step 5 — turn + compaction 生命週期（狀態機 C）

- 把 turn 生命週期做成顯式狀態機，跨 reducer（turn 事件）與 facade；**compaction 是一等特殊 turn**（只在 `turn/completed` 關；token 計算不會誤觸假壓縮警告）。
- **出口：** 群 C regression test（100% 後壓縮、compact-turn 關閉時序、token 計算）透過顯式狀態機通過。

### Step 6 — Approval / Interactive Resolver（狀態機 E）

- 把 server-request 處理（command/file/permissions approval、`requestUserInput`、MCP elicitation）抽成 resolver，投影成 durable pending state + typed responder；顯示 approval 指令細節（#418）。
- 覆蓋 **unknown / 不支援 server-request** 的明確 reject/error surface。
- **出口：** approval 流成為獨立、可測試單元；群 E 個案覆蓋。

### Step 7 — 把 Adapter 收薄成 Thread/Turn facade + session 生命週期（狀態機 D）

- `codex_appserver_adapter.go` 剩下的部分塌到 Thread/Turn lifecycle 編排（facade 形狀依 `codex-sdk-go`）。
- **facade 擁有 session / live-session 生命週期**，與 `controller.go` 的 idle-recycle 路徑（#604）對齊，讓 recycling 被擁有、不再外掛。
- **出口：** adapter 只做編排；不再有協議字串或 inline reduction；群 D recycling 行為由 facade 擁有。

### Step 8 — 退場 Codex-over-ACP

- 刪 `codex_adapter.go`（3451）與任何 Codex-only helper/分支；共用 `acp_*` helper 裡的 Codex-only 分支就地剪除。
- **明確保留** `standard_acp_adapter.go`、`acp_client.go` 與共用 `acp_*` helper。
- **出口：** Codex 只走 app-server；`codex_adapter.go` 消失；通用 ACP 棧綠；整個 runtime 包測試綠。

### Step 9 — _（延後 / 另一輪）_ desktop optimistic/reconcile 重寫（狀態機 A，desktop 半）

- 蓋在凍結的群 A snapshot 契約之上，重寫 desktop 的 optimistic echo + version 追蹤 + reconcile，讓「沒 paint 的 optimistic row」不會讓 `after_version` 失步，並用 `clientSubmitId` 回補真正的 user row。
- **出口：** 「用戶訊息消失」bug class 端到端關閉；desktop 只消費 tutti 領域型別（不變量成立）。

## 測試策略

- **契約：** Step 0 的特徵化測試**加上 bug 語料**是貫穿所有步驟的不變量。
- **逐狀態機：** Step 3–7 各自落地抽出的單元並附專屬測試，*且*以對應的 bug-class regression test 當驗收 gate。
- **漂移：** Step 1 的 CI 檢查重生成 `codexproto`，非預期 diff 即失敗。
- **baseline 指令（工作區）：** 在 `packages/agent/daemon` 跑 `go build ./runtime/...` + `go test ./runtime/ -run <app-server pattern>`。

## 風險與緩解

| 風險                                                       | 緩解                                                                                                               |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| codegen 工具鏈依賴 Rust `export` bin / `go-jsonschema`     | vendor schema 產物（Ops-2）；文檔化重生成指令；CI 漂移檢查抓偏差。                                                 |
| 重構中途上游 schema 變動                                   | Step 0 pin baseline；版本升級當成獨立、可 review 的 diff。                                                         |
| **路由（D8）改變行為：子 thread 事件原本被丟、現在被歸位** | 把改變範圍限縮在「填父 collab 卡片」（D10）；巢狀渲染留在範圍外；群 B regression test 斷言父卡片結果，而非新串流。 |
| **四狀態機 scope creep**                                   | 每台狀態機一步、且有 bug-class 驗收 gate；群 A 的 desktop 半明確延後（Step 9）；沒有一步合併多層。                 |
| 群 A daemon 契約隱含但不交付 desktop 修復                  | Step 9 明確且已排序；契約在 daemon 邊界凍結並測試，讓 desktop 修復有穩定地基。                                     |
| Step 8 刪除誤傷通用 ACP 棧                                 | Keep/Remove 表 + 刪除不變量；通用 ACP 測試把關；Codex-only 分支就地剪除。                                          |
| 步驟合批導致爆炸半徑大                                     | 每步獨立可 ship、可 review；不要合併。                                                                             |

## 已解決的決策（原先待議）

- **生成 protocol 層位置** → `packages/agent/daemon/runtime/codexproto`（Ops-1）。
- **schema vendor vs CI 重生成** → vendor + CI 漂移檢查（Ops-2）。
- **reducer/resolver 介面寬度** → 縫就是型別；現在不立跨協議 interface（D7）。
- **重構 vs 修 bug** → 四台狀態機全在範圍、分步；bug 反推目標並 gate 每一步（D6）；群 A 的 desktop 半延後到 Step 9（D9）；子 agent 路由限縮在父卡片（D10）。
