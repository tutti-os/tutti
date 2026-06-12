# PR3 壓縮上下文顯性入口 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用量條旁提供 Compact 按鈕；usage 達閾值時主動提醒（80% 弱提示、95% 強提醒帶 Compact 行動按鈕），同會話同檔位只提醒一次。

**Architecture:** 依賴 PR0（capability `compact`）與 PR5（`resolveAgentActivityUsage` + `agentUsageThresholds.ts` + 標題欄 chip）。Compact 按鈕復用 composer 的 `/compact` 提交路徑（`resolveSlashCommandSelectionEffect` 的 submitPrompt 效果——直接調用 viewModel/controller 暴露的 prompt 提交動作,提交字面量 `/compact`）。閾值提醒在 controller 層做檔位跨越檢測（per session 記錄已提醒檔位,usage 回落到檔位下方時重置）,提醒呈現用該包/宿主既有 toast 機制（grep WorkspaceChrome 的 `toast.custom` 模式或 gui 包內現有通知途徑——優先包內已有機制,避免跨包新增依賴）。

**Tech Stack:** TypeScript（agent-gui vitest）。

**分支:** `capability-negotiation`。

---

### Task A: Compact 按鈕

**Files:**

- Modify: `packages/agent/gui/agent-gui/agentGuiNode/AgentGUINodeView.tsx`（`AgentGUIDetailHeader`：usage chip 旁渲染按鈕）
- Modify: `packages/agent/gui/agent-gui/agentGuiNode/controller/useAgentGUINodeController.ts`（viewModel/actions 暴露 `submitCompact()`——內部走現有 prompt 提交動作,等價於用戶輸入 `/compact` 提交;先 grep composer onSubmit 的最終去向找到該動作）
- Modify: i18n（按鈕文案/тooltip 三語）
- Test: vitest——按鈕在 `compactSupported === false` 或 usage 為 null 時不渲染;點擊調用 submitCompact。

**要求:**

- 顯示條件：`compactSupported !== false` 且會話存在（unknown 視為可用,與 slash 策略一致）。
- 點擊後按鈕短暫 disabled（直至下一次 usage 更新或 turn 結束——簡化:提交後 disabled,session status 回 ready 時恢復;沿用 viewModel 既有 status 字段）。
- 視覺沿用 detailHeader 既有按鈕/圖標慣例（先讀同 header 其他操作的寫法）。

- [x] **Step 1: 失敗測試** → **Step 2: 確認失敗** → **Step 3: 實現** → **Step 4: `pnpm vitest run && pnpm typecheck`** → **Step 5: Commit** `feat(agent-gui): compact action in session header`

### Task B: 閾值提醒

**Files:**

- Create: `packages/agent/gui/agent-gui/agentGuiNode/model/agentUsageAlerts.ts`（純函數:輸入 prev/next percentUsed 與已提醒檔位集合,輸出應觸發的檔位與新集合——便於單測）
- Modify: `useAgentGUINodeController.ts`（useEffect 監聽 usage 變化,跨越檔位時觸發提醒;per agentSessionId 記錄）
- Modify: 提醒呈現（弱:非阻斷 toast/inline 橫幅;強:帶「Compact」行動按鈕的 toast,點擊調用 Task A 的 submitCompact——具體載體按勘察結論選現有機制）
- Modify: i18n 三語
- Test: `agentUsageAlerts.test.ts`（vitest 純函數矩陣:80 跨越觸發一次、95 觸發強檔、回落重置、重複不觸發）+ controller 集成測試（若該包有 controller 測試慣例;無則純函數測試 + typecheck）

**純函數簽名（鎖定,Task A/B 共享閾值常量來自 PR5 的 `agentUsageThresholds.ts`）:**

```ts
export type UsageAlertTier = "warn" | "critical";
export interface UsageAlertState {
  warned: boolean;
  criticaled: boolean;
}
export function nextUsageAlert(
  percentUsed: number | null,
  state: UsageAlertState
): { fire: UsageAlertTier | null; state: UsageAlertState };
```

語義:percent >= USAGE_CRITICAL_PERCENT 且未 criticaled → fire critical 並置兩位 true;否則 >= USAGE_WARN_PERCENT 且未 warned → fire warn;percent < USAGE_WARN_PERCENT → 全部重置 false;null → 原樣。

- [x] **Step 1: 失敗測試** → **Step 2: 確認失敗** → **Step 3: 實現** → **Step 4: 驗證（vitest + typecheck + check:i18n）** → **Step 5: Commit** `feat(agent-gui): usage threshold compact reminders`

### Task C: 收尾

- [x] **Step 1:** gui 全測試 + `pnpm lint:ts` 對改動文件無 error。（gui 全測試僅剩既有的 timeline-grid 失敗——由工作區未提交的 packages/ui 改動造成,非本 PR 範圍）
