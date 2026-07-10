# Agent Provider Status: 模型为真相源,读/检测反转

日期：2026-06-28
范围：`services/tuttid` 的 agentstatus 服务 + daemon API + tuttid 客户端 + desktop 状态 service
状态：待评审

## 问题

桌面端安装进行中每 1 秒轮询进度（active-action），但进度只能从 `GetAgentProviderStatuses`（= `agentstatus.Service.List`）的 `activeAction` 字段拿到，而 `List` **每次调用都现场全量探测**：跑 `--version`、发 HTTP 探网络（registry/api/proxy）、查 adapter。于是高频轮询被迫每秒重探网络，网络不稳时反复闪红、整条轨道反复重检测。

**根因（从头看）**：`List` 把"状态"建模成了**按需计算的纯函数**——"现在算一遍当前真相"。所以**读 = 检测**,这是反的。

## 不同信号的本质温度不同

| 信号                   | 何时变                | 本质                        |
| ---------------------- | --------------------- | --------------------------- |
| 已装 CLI/adapter、版本 | 仅在我们跑安装/卸载时 | 事件驱动（daemon 自己知道） |
| 登录态                 | 仅登录/登出           | 事件驱动                    |
| 网络可达性             | 偶发、外部            | 按需探测、可缓存            |
| 安装进度 activeAction  | 安装中持续            | 流                          |

把四种温度不同的东西塞进一个"同步现算"的调用——是丑的来源。

## 设计原则：反转读与检测

**状态是 daemon 维护的一个模型（single source of truth），客户端观察它；读是廉价默认,检测是显式命令。**

- **读（`GetStatus`）**：读模型 + 叠加实时 activeAction，**不探测任何东西**。高频、可轮询。
- **检测（`Detect`）**：探网络 + 复核已装/登录态，**更新模型**。低频，仅在打开 / 「重新检测」/ 动作收尾。
- **网络是模型里一个被探测的字段**，只在 Detect 时刷新；读直接返回上次探到的稳定值。
- **进度（activeAction）本就在模型里实时流动**。

本设计是这个正确架构的**同步版**（轮询廉价读）；其反应式版（`Watch` 订阅、彻底去轮询）见「未来方向」。

## 关键约束（已核查代码）

1. **`agentstatus.Service` 是值类型**，被按值拷贝、甚至在 `provider_availability.go:149` new 出空实例。→ 状态模型必须放**包级全局**（与 `active_action.go` 同模式），不能挂 `Service` 字段。
2. daemon 长生命周期（`wiring.go:215` 构造一次），包级模型跨请求存活。
3. `GetAgentProviderStatuses` / `Probe` 是 desktop↔daemon **本地 API**，无外部消费者。当前 `List` 仅两个调用方：前端 `desktopAgentProviderStatusService` + daemon 内部 `provider_availability.go:151`。→ 翻转端点语义安全、可控。

## 各单元设计

### 1. 状态模型 — `services/tuttid/service/agentstatus/status_store.go`（新）

包级全局，与 `active_action.go` 同模式：

```go
var statusStore = struct {
	sync.Mutex
	byProvider map[string]storedStatus
}{byProvider: map[string]storedStatus{}}

type storedStatus struct {
	status     ProviderStatus // 含 Network（上次 Detect 探到的稳定值）
	capturedAt time.Time
}

// putDetectedStatus 由 Detect 在一次探测后写入。
func putDetectedStatus(provider string, status ProviderStatus, capturedAt time.Time)

// readStatuses 返回所请求 provider 的模型状态（已 Detect 过的那些），
// 每个叠加实时 active-action，外加最新 capturedAt。无探测。未 Detect 过的 provider 省略。
func readStatuses(providers []string) (statuses []ProviderStatus, capturedAt time.Time)

func resetStatusStoreForTests()
```

`readStatuses` 对每个返回项 `status.ActiveAction = activeActionForProvider(p)`（实时进度覆盖模型里的旧值）。

### 2. `Service.Detect`（命令）— `service.go`

把今天 `List`（`service.go:238`）的函数体**原样保留**（现场探网络 + `statusForSpec` 全检测），仅在末尾**写入模型**：

```go
func (s Service) Detect(ctx context.Context, input ListInput) (Snapshot, error) {
	// ……今天 List 的探测逻辑原样……（probeRegistry/probeProxy/probeProviderAPI + statusForSpec）
	now := s.now()
	for i := range statuses {
		statuses[i].ActiveAction = activeActionForProvider(statuses[i].Provider)
		putDetectedStatus(statuses[i].Provider, statuses[i], now) // 新增：写模型
	}
	return Snapshot{CapturedAt: now, Providers: statuses}, nil
}
```

（即：现有 `List` 重命名为 `Detect` + 写模型一行。语义=今天的 List：现场探测、返回新鲜。）

### 3. `Service.GetStatus`（读）— `service.go`（新）

```go
// GetStatus 返回模型里各 provider 的已检测状态 + 实时 active-action，不做任何探测。
// 冷模型（尚未 Detect）→ 空 Providers。这是廉价、可高频轮询的默认读。
func (s Service) GetStatus(input ListInput) (Snapshot, error) {
	statuses, capturedAt := readStatuses(input.Providers)
	if len(statuses) == 0 {
		return Snapshot{CapturedAt: s.now(), Providers: nil}, nil
	}
	return Snapshot{CapturedAt: capturedAt, Providers: statuses}, nil
}
```

无 `ctx`（无探测）；保留 `input ListInput` 复用 `Providers` 过滤。

### 4. daemon API：端点诚实翻转 — `daemon_agent_statuses.go` + openapi

- **`GetAgentProviderStatuses`（现存端点）→ 改为调 `GetStatus`**（廉价读）。名副其实。
- **新增 `DetectAgentProviders`（命令端点，如 `POST /agent-providers/detect`，query/body `providers`）→ 调 `Detect`**。复用现有响应 schema `AgentProviderStatusListResponse`。
- 重新生成 `server.gen.go` / `types.gen.go`（Go）+ `packages/clients/tuttid-ts` 的 `types.gen.ts`。
- **重指调用方**：daemon 内部 `provider_availability.go:151` 由 `List` 改调 `Detect`（它要新鲜可用性）。

### 5. tuttid 客户端 — `packages/clients/tuttid-ts`

- 生成 `detectAgentProviders(request)`（命令，同响应类型）。
- `getAgentProviderStatuses` 保留（现在打到廉价读端点）。
- `createDesktopTuttidClient.ts` + `tuttidClientTypes.ts` 各加一条 `detectAgentProviders`。

### 6. desktop 状态 service — `desktopAgentProviderStatusService.ts`

把"取数"分成两条语义清晰的路径：

- **detect 路径**（`requestStatuses` 内部）：改调 `tuttidClient.detectAgentProviders(...)`。用于：初次 `ensureLoaded`、`refresh`、「重新检测」、动作收尾（install/login 后那次 refresh）。可置 `isLoading`（这是真正的检测）。
- **read 路径**（新 `private async readStatus(providers)`）：调 `tuttidClient.getAgentProviderStatuses(...)`，经现有 reconcile 应用结果，但**不置 `isLoading`**（后台轮询）。
- `runPendingActionStatusPoll`（约 `:633`）：`await this.refresh(...)` → `await this.readStatus([provider])`。
- 因为模型已持有上次探到的 network，read 返回的 status 自带稳定 network——**前端无需任何字段保留/合并特例**。

## 数据流

```
打开 / 「重新检测」/ 动作收尾  ─► Detect ─► 现场探测 + 写模型 ─► 前端拿到完整新鲜状态
安装中每秒轮询进度            ─► GetStatus ─► 读模型(稳定 network) + 实时 activeAction，不探测、不置 isLoading
provider_availability         ─► Detect ─► 新鲜可用性（行为同今天）
```

## 错误处理与边界

- **冷模型**：read 在任何 Detect 之前被调 → 返回空 Providers。前端总在打开时先 Detect，故轮询时模型必热；万一空,前端 reconcile 保留已持有快照。
- read 永不触发 Detect（职责单一）。
- read IPC 失败：沿用现有 refresh 错误路径（记录、保留上次快照、不弹通知）。
- 并发：模型读写用 mutex（同 `active_action.go`）。Detect 写 + read 读并发安全。

## 测试矩阵

| 单元                    | 类型      | 关键用例                                                                                                    |
| ----------------------- | --------- | ----------------------------------------------------------------------------------------------------------- |
| `status_store_test.go`  | Go 纯     | put 后 read 命中；read 叠加实时 active-action；冷模型返回空；多 provider 过滤                               |
| `Service.Detect`        | Go        | 探测后**写了模型**（Detect 前 GetStatus 空，Detect 后命中）；返回新鲜（行为同旧 List）                      |
| `Service.GetStatus`     | Go（spy） | **不调** `probeRegistry/probeProxy/probeProviderAPI`（probe spy 断言零调用）；返回模型 + 实时 active-action |
| daemon API              | Go        | `GetAgentProviderStatuses` → GetStatus；`DetectAgentProviders` → Detect；序列化正确                         |
| `provider_availability` | Go        | 改调 Detect 后行为不变                                                                                      |
| desktop service         | node:test | poll 走 read 端点、**不置 isLoading**；detect 路径走 detect 端点；安装收尾仍 detect                         |

## 未来方向（不在本 spec）

- **② 反应式订阅**：在状态模型上加 `Watch`，daemon 把模型变化推给前端,前端订阅,**轮询彻底消失**。与前端 store+subscription 重构同一哲学。本设计的模型即其天然基座——届时 `GetStatus` 退化为"订阅时的初始快照"。
- **登录轮询**（`loginStatusPoll`）：现仍走 detect（需复核 auth）。模型铺好后可改为"动作完成事件更新模型 + read"，或等 ② 订阅统一。本 spec 不动它。

## 验收标准

- 安装进行中：网络阶段**不再每秒重探/闪红**（read 返回模型里上次 Detect 的稳定 network）。
- 安装进行中：「重新检测」按钮稳定禁用（#454 已改 + read 不置 isLoading 消除另一来源）。
- `GetAgentProviderStatuses` 端点**不再做任何探测**（spy 断言）；探测只发生在 `DetectAgentProviders` / 动作收尾。
- `provider_availability` 等调用方行为不变（已重指到 Detect）。
