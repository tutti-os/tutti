# AgentEnvPanel 重构设计（controller + store + 纯 view-model）

日期：2026-06-27
范围：`apps/desktop/.../workspace-agent/ui/AgentEnvPanel.tsx` 及其依赖链路
状态：待评审

## 目标与动机

`AgentEnvPanel.tsx`（约 760 行、两个组件同文件）的容器层同时承担了三件本应分离的职责，构成本次重构要消除的坏味道：

1. **派生泄漏**：`installDetail`/`adapterDetail`/`networkChecks`/`networkReachable`、以及裸字符串匹配 `reasonCode.includes("codex_version_too_old")`、`reasonCode.includes("adapter_version_mismatch")` 等展示派生逻辑（旧文件 405–598 行）直接写在组件体里，未被单测覆盖；而它们的兄弟分类 `reasonCodeIndicatesCliVersionUnsupported` 却已是隔壁 `agentEnvWizardFlow.ts` 里的纯函数——抽象边界不一致。
2. **effect 汤 + ref-guard 反模式**：4 个 `useEffect`（reset-on-open / auto-start / reveal-timer / anomaly-report）都挂在 `open` 上互相牵制；其中 auto-start 用 `autoStartedSeqRef` 兜住"`runAction` mutate snapshot → effect 重跑"的自造重入，注释里写满"do not weaken the ref guard"。这正是用户记忆 `state-management-prefer-store` 要避免的 `state + ref` 镜像反模式。
3. **prop 爆炸**：`SetupTrack` 接收 21 个 props，其中 5 个独立 pending 布尔各自穿透，说明父子接缝切错。

重构后组件层只做"订阅 + 渲染"，编排迁入 controller，派生迁入纯 view-model，符合仓库既有约定（`agentSessionViewStore.ts` 的 vanilla store 范式 + `agentEnvWizardFlow.ts` 的纯函数边界）。

## 既有约束（不可破坏）

- **Radix 受控 Dialog 不可在 `open=true→false` 过渡前卸载**，否则 `pointer-events:none` 残留锁死整个 app（旧文件 397–403 行注释）。重构后组件仍始终渲染 `<Dialog>`，由 `open` 驱动可见性。
- **`open*/close*AgentEnvPanel` deep-link API 不动**：它们在 `agent-gui` 包内被多处调用（`AgentGUINodeView.tsx`、`AgentMessageBlock.tsx`、desktop dock actions）。`agentEnvPanelStore`（valtio，shared 包）保持为 open/focus/requestSequence 请求通道。
- **"adapter mismatch 不得误红 CLI 步"** 的语义（复用 `reasonCodeIndicatesCliVersionUnsupported`）必须保留。
- **auto-start 每次 open 至多触发一次**、**anomaly-report 每次 open 至多上报一次** 的语义必须保留。

## 架构总览（四层）

```
纯逻辑层  packages/agent/gui/shared/agentEnv/   (可单测, 无 React, i18n-agnostic)
  agentEnvWizardFlow.ts        既有, 仅 detail token 化改动
  agentEnvViewModel.ts  (新)   buildAgentEnvWizardViewModel()

desktop 状态层  apps/desktop/.../workspace-agent/services/internal/
  agentEnvWizardStore.ts (新, vanilla useSyncExternalStore)
  agentEnvWizardController.ts (新, attach/detach 编排)

桥接 hook  apps/desktop/.../workspace-agent/ui/
  useAgentEnvWizard.ts (新)    组件唯一入口

组件层  apps/desktop/.../workspace-agent/ui/
  AgentEnvPanel.tsx            瘦身为 Dialog 外壳
  AgentEnvSetupTrack.tsx (拆)  { viewModel, actions }
  AgentEnvReportConsent.tsx (拆)
  agentEnvPanelText.ts (新)    token→文案映射(describeStageProblem/doneStageLabel/detail)
```

## 数据流

```
service.snapshot ─┐
wizardStore       ├─► useAgentEnvWizard ──► buildAgentEnvWizardViewModel ──► viewModel ──► 组件渲染
request(open/...) ─┘            │
                               └─► attachAgentEnvWizard(service订阅) ──► 编排:
                                     auto-start / anomaly / reveal-timer / open-sync
                                     (同步读 getSnapshot(), 去重键写入 wizardStore)
```

组件**不再**直接读 `service.isActionPending` 或拼派生；全部经 `viewModel`。编排**不再**经 effect 对 snapshot 做反应；由 controller 订阅 service、在每个 tick 同步 `getSnapshot()` 决策。

## 各单元设计

### 1. 纯 view-model — `agentEnvViewModel.ts`（shared）

`AgentSetupStage.detail` 从 `string | null` 改为 token（i18n 留给组件，沿用既有 `StageProblem` token 先例）：

```ts
export type StageDetailToken =
  | { kind: "text"; text: string } // "version · path"
  | { kind: "version-floor"; current: string; required: string } // CLI 低于支持下限
  | { kind: "version-mismatch"; current: string; required: string }; // adapter 版本不匹配

export interface AgentEnvWizardViewModelInput {
  provider: WorkspaceAgentProvider; // 已由 desktop 层解析(见 §4)
  status: AgentProviderStatus | null;
  isLoading: boolean; // snapshot.isLoading → redetecting
  activeAction: CodexSetupActiveAction | null;
  installActionPending: boolean;
  loginPending: boolean;
  revealIndex: number;
  stageLabels: AgentSetupStageLabels; // 已翻译的 6 个步骤名(沿用现状约定)
}

export interface AgentEnvWizardViewModel {
  provider: WorkspaceAgentProvider;
  ready: boolean;
  busy: boolean;
  detected: boolean;
  redetecting: boolean;
  displayStages: AgentSetupStage[]; // 已折入 registry detail + reveal 投影, detail 为 token
  blockingStageId: AgentSetupStageId | null;
  networkChecks: NetworkCheck[];
  hasAnomaly: boolean;
  activePhase: CodexSetupPhase | null;
  log: string[];
  registry: string | null;
  error: { code: string | null; message: string | null } | null;
  manualCommand: string | null;
  installPending: boolean;
  loginPending: boolean;
}

export function buildAgentEnvWizardViewModel(
  input: AgentEnvWizardViewModelInput
): AgentEnvWizardViewModel;
```

内部职责（吸收旧组件 405–598 行）：reason-code 分类（`versionTooOld`/`cliBelowFloor`/`adapterVersionMismatch`，复用 `reasonCodeIndicatesCliVersionUnsupported`）、`installDetail`/`adapterDetail` token 化、`networkChecks` 组装与 `networkReachable` 判定、调 `deriveAgentSetupStages` → 折 registry detail → `projectRevealedStages`、`blockingStage` 定位、`hasAnomaly`、`manualCommand` 查表。`NetworkCheck` 类型从组件迁入本模块。

`deriveAgentSetupStages` 的 `cliVersionDetail`/`adapterDetail`/`networkDetail`/`accountDetail` 参数与 `AgentSetupStage.detail` 类型同步改为 `StageDetailToken | null`；其 spec 相应更新。

> 注：`provider` 解析依赖 desktop 常量 `desktopManagedAgentProviders`，**不**放进 shared 纯模块；由 desktop 层解析后作为入参传入（见 §4）。

### 2. vanilla store — `agentEnvWizardStore.ts`（desktop）

吸收旧组件 5×`useState` + 1×`useRef`，按 `agentSessionViewStore.ts` 范式：

```ts
type ReportState = "idle" | "confirming" | "reported" | "dismissed";
interface AgentEnvWizardSnapshot {
  revealIndex: number;
  reportState: ReportState;
  copied: boolean;
  logExpanded: boolean;
  autoStartedSeq: number | null;   // 取代 autoStartedSeqRef —— 去重键进 store
}

// mutators
resetWizardForOpen(focus: AgentEnvPanelFocus | null): void; // revealIndex=focus==="detect"?0:REVEAL_ALL; 其余清空; autoStartedSeq=null
restartWizardReveal(): void;                                // revealIndex=0; reportState=idle; copied/logExpanded=false (redetect 用)
advanceWizardReveal(): void;                                // revealIndex+1
setWizardReportState(s: ReportState): void;
setWizardCopied(b: boolean): void;
toggleWizardLog(): void;
markWizardAutoStarted(seq: number): void;

// 读取
useAgentEnvWizardState(): AgentEnvWizardSnapshot;           // useSyncExternalStore
getAgentEnvWizardSnapshot(): AgentEnvWizardSnapshot;
subscribeAgentEnvWizardStore(listener: () => void): () => void;
resetAgentEnvWizardStoreForTests(): void;
```

`REVEAL_STEP_MS=450` / `REVEAL_ALL=MAX_SAFE_INTEGER` 常量迁入本模块（reveal 由 controller 推进）。

### 3. controller — `agentEnvWizardController.ts`（desktop）

```ts
interface AttachAgentEnvWizardParams {
  service: IAgentProviderStatusService;
  provider: WorkspaceAgentProvider;
  focus: AgentEnvPanelFocus | null;
  requestSequence: number;
  context: { workspaceId: string; workbenchHost?: unknown };
}
export function attachAgentEnvWizard(p: AttachAgentEnvWizardParams): () => void; // 返回 detach
export function restartAgentEnvWizardDetection(
  p: AttachAgentEnvWizardParams
): void; // redetect
```

`attach` 流程：

1. `resetWizardForOpen(focus)`。
2. 初次探测：`focus ? service.refresh([provider]) : service.ensureLoaded({providers:[provider]})`。
3. `service.subscribe(orchestrate)`，并立即跑一次 `orchestrate()`。
4. 返回 `detach`：unsubscribe + 清 reveal 定时器。

`orchestrate()`（每个 service tick 与每次 reveal 推进后调用，全部同步读快照——**无 effect、无 ref**）：

- **auto-start**：`snap=service.getSnapshot()`；`wizard=getAgentEnvWizardSnapshot()`；若 `wizard.autoStartedSeq !== requestSequence`，用 `resolveWizardAutoStartAction({focus, detected, ready, installPending, loginPending})` 算 action；有则先 `markWizardAutoStarted(requestSequence)` 再 `service.runAction(provider, action, context)`。**去重键在 store，先标记后执行**，跨多个 tick 不重入。
- **anomaly**：若 `wizard.reportState==="idle"` 且 `deriveHasAnomaly(snap)`：有 consent → `reportEnvIssue(provider)`+`setWizardReportState("reported")`；否则 `setWizardReportState("confirming")`。`deriveHasAnomaly` 为 shared 纯小函数（只看各 stage error 状态 + `activeAction.error`，与 label 文案/reveal 无关），由 controller 与 `buildAgentEnvWizardViewModel` **共用同一份**，避免 anomaly 判定算两遍。
- **reveal**：据 `shouldAdvanceReveal(stages, revealIndex)` 决定是否 `setTimeout(REVEAL_STEP_MS → advanceWizardReveal())`；单一 pending 定时器句柄，advance 后重算重排，detach 时清除。

`restartAgentEnvWizardDetection`：`restartWizardReveal()` + `setWizardReportState("idle")` + `service.refresh([provider])`（沿用旧 `handleRedetect` 语义）。

定时器抽象通过注入的 `scheduler`（默认 `window.setTimeout/clearTimeout`）以便单测。

### 4. hook — `useAgentEnvWizard.ts`（desktop）

```ts
export function useAgentEnvWizard(input: {
  service: IAgentProviderStatusService;
  request: AgentEnvPanelRequest; // useAgentEnvPanelRequest()
  workspaceId: string;
  workbenchHost?: unknown;
}): { viewModel: AgentEnvWizardViewModel; actions: AgentEnvWizardActions };
```

- `useStatusSnapshot(service)` + `useAgentEnvWizardState()` 双订阅。
- `provider = useMemo(resolveActiveProvider(request.provider, snapshot.defaultProvider))`（`resolveActiveProvider` 为 desktop 小纯函数，吃 `desktopManagedAgentProviders`）。
- **唯一 lifecycle effect**：`request.open` 为真时 `attachAgentEnvWizard({...})`，cleanup 调 detach；deps `[open, requestSequence, provider, service, workspaceId, workbenchHost]`。这是"订阅外部系统"语义，effect 的正当用途。
- `viewModel = useMemo(buildAgentEnvWizardViewModel({provider, status, ...snapshot 派生, revealIndex, stageLabels}), deps)`；`stageLabels` 由 hook 内 `useTranslation` 构造。
- `actions`：`redetect`(→`restartAgentEnvWizardDetection`)、`runStageAction(actionId)`、`confirmReport`/`dismissReport`(→`setWizardReportState`+`service.setDiagnosticsConsent`/`reportEnvIssue`)、`copyManual(cmd)`(navigator.clipboard+`setWizardCopied`)、`toggleLog`。均为 `useCallback` 稳定引用。

### 5. 组件层

- **`AgentEnvPanel.tsx`**：调 `useAgentEnvWizard`，渲染 `<Dialog open={request.open}>` 外壳 + 头/脚，body 委托 `<AgentEnvSetupTrack viewModel actions />`，consent 委托 `<AgentEnvReportConsent state actions />`。无 `useState`/`useEffect`/`useRef`/`useMemo` 派生。始终渲染 Dialog（保留 Radix 不卸载约束）。
- **`AgentEnvSetupTrack.tsx`**：props 收口为 `{ viewModel, actions, t }`（21→3）。stage 行渲染 token detail（经 `agentEnvPanelText.ts`）。
- **`AgentEnvReportConsent.tsx`**：consent 块。
- **`agentEnvPanelText.ts`**：`describeStageProblem`/`doneStageLabel`/`renderStageDetail(token, t)` 等 token→文案映射（i18n 边界集中此处）。

## 错误处理与边界

- 旧 daemon 无 network 字段 → `networkChecks=[]` → `networkReachable=null` → 不阻塞（保留）。
- `desktopManagedAgentProviders` 为空时 `resolveActiveProvider` 回退第一个、需 guard（旧 261 行隐患一并修）。
- `runAction`/`reportEnvIssue` 失败由 service 既有路径处理；controller 不吞错。
- `workbenchHost` 类型：本次保持 `unknown`（消除属独立改动，不扩大范围）。

## 测试矩阵

| 单元                               | 类型         | 关键用例                                                                                                                                                                                               |
| ---------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agentEnvViewModel.spec.ts`        | 纯, 无 React | detail token 三态；networkChecks 组装/`networkReachable` null·false·true；blockingStage；hasAnomaly；`cliBelowFloor`/`adapterVersionMismatch`/`versionTooOld` 分类；adapter mismatch **不**红 CLI 步   |
| `agentEnvWizardFlow.spec.ts`       | 既有, 更新   | detail token 化后签名调整                                                                                                                                                                              |
| `agentEnvWizardStore.spec.ts`      | 纯           | mutators + `resetForTests` + reset/restart 语义                                                                                                                                                        |
| `agentEnvWizardController.spec.ts` | fake service | auto-start 跨 N tick 仅一次；ready/pending/无 focus 时不启动；requestSequence 变化重新武装；anomaly→reported(有 consent)/confirming(无)；reveal 在 ok 步推进、running/error 停住；detach 清定时器+退订 |
| 组件渲染测试                       | 轻量         | 既有 `desktopAgentProviderStatusService.test.ts` 同族测试更新；Track 在 ready/blocking/busy 下快照                                                                                                     |

## 迁移顺序（每步可编译、测试绿）

1. 纯层：新增 `agentEnvViewModel.ts` + spec；token 化 `AgentSetupStage.detail` 与 `deriveAgentSetupStages`、更新其 spec；`SetupTrack` 暂时就地适配 token 渲染。落地绿。
2. 新增 `agentEnvWizardStore.ts` + spec。
3. 新增 `agentEnvWizardController.ts` + spec（fake service）。
4. 新增 `useAgentEnvWizard.ts`。
5. 重写 `AgentEnvPanel.tsx` 接 hook；拆出 `AgentEnvSetupTrack.tsx`/`AgentEnvReportConsent.tsx`/`agentEnvPanelText.ts`；删除 4 effect、5 useState、1 useRef、内联派生。
6. 更新组件层既有测试。

## 验收标准

- `AgentEnvPanel.tsx` 不含 `useEffect`/`useRef`，`useState` 清零；行数显著下降。
- auto-start 去重不再依赖 ref，去重键在 store；相关"do not weaken the ref guard"注释消失。
- 展示派生（含 reason-code 字符串匹配）全部进纯 view-model 并被单测覆盖。
- `SetupTrack` props ≤ 4。
- Radix 不卸载、deep-link API、auto-start/anomaly 一次性、adapter-不红-CLI 语义不回归。

## 明确不做（YAGNI / 范围外）

- 不把 `agentEnvPanelStore` 从 valtio 迁走、不动 deep-link 公共 API。
- 不重命名 `Codex*` 契约类型（历史命名，单独议题）。
- 不改 `workbenchHost: unknown` 的类型化（单独议题）。
- 不引入 web-gui 跨平台复用（当前 panel 仅 desktop）。
