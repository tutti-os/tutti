# AgentGUI 三个小改 — 设计文档

日期: 2026-06-27
范围: `packages/agent/gui`（+ `packages/ui/system` 一个新原语）

## 背景

来自飞书 Nexight 业务群近两周诉求的只读盘点（codex 子 agent 报告，2026-06-27）。
从候选清单中挑出三个小、自包含、可独立落地的改动：

1. 消息中心标题显示「最新用户任务」而非总结/首条
2. 对话流图片支持右键复制
3. 上下文压缩按钮放进 usage popover

三者互不依赖，可分别开 PR。全部位于 `packages/agent/gui`，外加一个共享 UI 原语。

## 共同约束

- 新增文案到 `packages/agent/gui/app/renderer/i18n/locales/{en,zh-CN}.ts`。
- 收尾跑 `pnpm --filter @tutti-os/agent-gui test`；改动数据流的部分另跑
  `pnpm check:agent-activity-runtime-boundaries`。
- 按 `packages/agent/gui/AGENTS.md` 走 doc-impact 自评，多半更新
  `docs/architecture/agent-gui-node.md`。
- 前置：此 worktree 未安装 `node_modules`（bare repo + 外置 worktree），
  动手前需 `pnpm install`。

---

## 改动 ①：消息中心标题 → 最新用户任务优先

### 现状

`agent-message-center/workspaceAgentMessageCenterModel.ts`

- `analyzeMessageCenterSessionMessages`（line ~299）遍历消息时只记录
  `firstUserMessageSummary`（首条用户消息）。
- `resolveSessionTitle`（line 266，唯一消费点在 line 114）当前优先级：
  `session.title`（provider 生成的总结） → `firstUserMessageSummary` → provider → id。

### 改动

1. 在 `analyzeMessageCenterSessionMessages` 增加 `latestUserMessageSummary`：
   遍历时每遇到 user 消息就覆盖（最终保留最后一条）。加入返回的
   `MessageCenterSessionMessageAnalysis`。
2. `resolveSessionTitle` 新签名接收 `latestUserMessageSummary`，优先级改为：
   **最新用户消息 → `session.title`（总结，fallback） → 首条用户消息 → provider → id**。
3. line 114 的调用点传入新字段。

### 边界 / 影响

- 纯 model/projection 改动，无 provider、daemon、数据层变更。
- 列表卡片标题会随用户最近一次发言变化；session 总结退为 fallback（仍用于纯自动会话）。
- 需更新断言「首条用户消息」标题的测试：`workspaceAgentMessageCenterModel.spec.ts`、
  及可能受影响的 `WorkspaceAgentMessageCenterPanel.spec.tsx` /
  `workspaceAgentMessageCenterViewModel.spec.ts`。
- 属数据流改动 → 跑 `check:agent-activity-runtime-boundaries`。

---

## 改动 ②：对话流图片 → 右键复制（所有图片）

### 现状

- 图片渲染在 `shared/agentConversation/components/AgentMessageBlock.tsx`（grid，line ~320），
  用户发的与 agent 产出的图片都走 `ZoomableImage`，`src` 是 data URL。
- 现有 `handleCopyMessageText`（line 96）用 `agentHostApi?.clipboard?.writeText`，
  无 host 时 fallback `navigator.clipboard.writeText`。
- 桌面 host clipboard 实现（`createDesktopAgentHostApi.ts:119`）本身就是
  `navigator.clipboard.writeText`——没有走主进程 IPC。

### 关键决策：不加 host writeImage

因为桌面 host clipboard 即 `navigator.clipboard`，复制图片直接走 renderer 的
`navigator.clipboard.write([new ClipboardItem(...)])` 即可，最少层、最稳，符合「最小改法」。
**不**新增 `AgentHostClipboardApi.writeImage`。

### 改动

1. 新增 renderer 工具 `copyImageToClipboard(src: string): Promise<boolean>`
   （放在 agentConversation 工具层）：
   - data URL / src → `Blob`；
   - `ClipboardItem` 仅稳定支持 `image/png`，故非 png 用离屏 canvas 转 png；
   - `navigator.clipboard.write([new ClipboardItem({ "image/png": blob })])`；
   - try/catch 返回 boolean，沿用现有成功/失败 toast 模式。
2. 每张会话图片包一个右键菜单，单项「复制图片」，onSelect 调 `copyImageToClipboard`。

### 右键菜单实现：复用 radix-ui umbrella，零新依赖

- 仓库所有 radix 原语来自统一的 `radix-ui` umbrella 包（`packages/ui/system`，
  `radix-ui: ^1.4.2`）：`DropdownMenu`/`Popover`/`Dialog`/`Select` 等均 `from "radix-ui"`。
- `ContextMenu` 属同一 umbrella 包，无需新增 `@radix-ui/react-context-menu`
  （新增反而是冗余/hacky 路径）。
- 在 `packages/ui/system/src/components/context-menu/context-menu.tsx` 新建 wrapper，
  镜像 `dropdown-menu.tsx`：`import { ContextMenu as ContextMenuPrimitive } from "radix-ui"`，
  复用 `MenuSurface` / `menuItemClassName`。从 `packages/ui/system` barrel 导出。
- 在 agent/gui 侧 `app/renderer/components/ui/context-menu.tsx` re-export（镜像
  现有 `dropdown-menu.tsx` re-export 模式）。

### 边界 / 影响

- 覆盖所有对话流图片（用户 + agent）。
- 新增 i18n：菜单项「复制图片」、复制成功/失败 toast。
- 新 UI 原语需补轻量渲染测试；图片复制工具补单测（png 直传 / 非 png 转换 / 失败）。

---

## 改动 ③：上下文压缩按钮 → usage popover

### 现状

- `agent-gui/agentGuiNode/AgentComposer.tsx` 的 `AgentUsageChip`（line ~450–549）渲染
  usage `Popover`（`data-testid="agent-gui-usage-popover"`），挂载点 line ~2733。
- `/compact` 在 `agentSlashCommandProviderPolicy.ts` 的 `UNIVERSAL_IMMEDIATE_COMMANDS`，
  选中即提交，最终走 `executeSlashCommandEffect` 的 `submitPrompt` →
  `onSubmit(textPromptContent("/compact"))`。
- `compactSupported`、`hasCompactableContext` 已是 AgentComposer 的 props
  （line 165-166，由 `AgentGUINodeView` / controller 传入）。

### 改动

1. 给 `AgentUsageChip` 透传 `onCompact`、`compactSupported`、`hasCompactableContext`、`busy`。
2. usage popover 内容底部加「压缩上下文」按钮，onClick 调
   `onSubmit(textPromptContent("/compact"))`（即现有立即提交路径，不新造逻辑），
   提交后关闭 popover。
3. 按钮仅在 `compactSupported && hasCompactableContext && !busy` 时显示/可用。

### 边界 / 影响

- 不改 `/compact` 提交逻辑本身，只加一个触发入口。
- 新增 i18n：按钮文案。
- 补测试：popover 内按钮在支持/不支持/busy 三态下的显示与点击提交。

---

## 不在本次范围

- 应用更新黑屏、Codex 反复登录、stop/cancel ACP 中断等（更大或更 sensitive，单独立项）。
- 不动 `/compact` 的后端/provider 行为。
- 不做无关重构。
