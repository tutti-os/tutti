# Codex 节点 Prompt 预填实现计划

> **给 agentic workers：** 实施本计划时需要使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`，逐任务执行。任务使用 checkbox（`- [ ]`）跟踪。

**目标：** 打开或复用一个 Codex Agent GUI workbench 节点，把 prompt 预填到输入框里，并等待用户手动发送。

**架构：** 新增一个一次性的 Agent GUI workbench activation，用于 prompt 预填。任务中心的这个新流程不能继续走 prompt-session 路径，因为该路径会用初始内容创建真实 runtime session，从而进入执行链路。新流程只向 Workbench 发送 launch request，由 Workbench 选择或创建唯一一个 Agent GUI 节点，然后该节点把 prompt 写入本地 composer draft 状态。

**技术栈：** TypeScript、React、`@tutti-os/workbench-surface`、`@tutti-os/agent-gui`、desktop renderer workbench contributions、issue-manager feature adapters。

---

## 实现结果

当前实现已经把任务中心的执行 prompt 和拆解 prompt 改为预填 Agent GUI 草稿：

- 任务中心继续复用原有 prompt 生成逻辑。
- desktop adapter 不再先创建 session，而是把 prompt 作为 `draftPrompt` 交给 Agent GUI launch。
- Workbench 通过 `reuseDockEntryNode` 复用目标 provider 的 dock 节点；没有匹配节点时创建一个新的 Agent GUI 节点。
- 这不是广播机制。一次 launch 只会把 activation 交给 Workbench 选中的一个目标节点，不会让多个 Codex 节点同时响应同一个请求。
- Agent GUI 消费 `agent-gui:prefill-prompt` activation 后会清理该 activation，避免节点重挂载时用旧 prompt 覆盖用户编辑。
- prefill 路径只写 composer draft，不调用 `activateSession({ mode: "new" })`、`sendInput` 或 `WorkspaceAgentPromptSessionService.createSession`。

已覆盖的验证点：

- Workbench draft launch request 和 descriptor。
- draft launch 复用 provider dock entry，且没有 `targetAgentSessionId`。
- AgentGUI prefill 写入草稿、不调用 activate、不调用 sendInput。
- 重复 activation sequence 不覆盖用户编辑。
- prefill activation 被消费后清理，避免重挂载重复应用。
- 任务中心 adapter 只 launch draft prompt，不调用 session creator。
- 中英文任务中心文案更新。

---

## 当前行为

任务中心当前的 agent 动作链路是：

```text
IssueManager action
  -> createDesktopIssueManagerAgentRunner / createDesktopIssueManagerAgentBreakdownLauncher
  -> WorkspaceAgentPromptSessionService.createSession({ prompt })
  -> WorkspaceAgentActivityService.activateSession({
       mode: "new",
       initialContent: [{ type: "text", text: prompt }]
     })
  -> requestWorkspaceAgentGuiLaunch({ agentSessionId, provider })
```

这不是 prompt 预填应该使用的基础能力。`initialContent` 会创建真实 agent runtime session，并启动 agent 侧执行链路。预填流程禁止调用：

- `WorkspaceAgentPromptSessionService.createSession`
- `WorkspaceAgentActivityService.activateSession({ mode: "new", initialContent })`
- `WorkspaceAgentActivityService.sendInput`

Agent GUI 内部已经有本地草稿状态：

- `draftBySessionId`
- `updateDraftPrompt`
- `nodeDefaultDraftPromptKey(provider)`

实现时应把生成的 prompt 写入这个 draft 状态，并聚焦 composer。

## 目标行为

当任务中心请求 Codex prompt 预填时：

```text
IssueManager action
  -> build prompt text
  -> requestWorkspaceAgentGuiLaunch({
       provider: "codex",
       draftPrompt,
       userProjectPath,
       workspaceId
     })
  -> WorkspaceWorkbench launch handler
  -> host.launchNode(createWorkspaceAgentGuiDraftLaunchRequest(...))
  -> Workbench 如果存在 Codex 节点则复用一个
     如果不存在 Codex 节点则创建一个新节点
  -> 目标节点收到一次性的 "agent-gui:prefill-prompt" activation
  -> 目标节点把 draftPrompt 写入 composer draft
  -> 目标节点聚焦 composer
  -> 用户手动发送
```

只有目标节点会收到 activation。其他 Codex 节点不会看到这次请求，除非未来刻意实现广播；本计划明确禁止广播。

## 节点选择规则

V1 使用以下规则：

1. 优先复用最上层的、dock entry 为 Codex 的已有节点。
2. 如果没有 Codex 节点，则创建一个新的 Codex 节点。
3. 只把 prefill activation 交付给这一个节点。

这和现有 Workbench 的 `reuseDockEntryNode` 行为一致：

- `reuseDockEntryNode: true`
- `dockEntryId: agentGuiWorkbenchDockEntryId("codex")`
- Workbench 会从前到后搜索 node stack，复用第一个匹配节点。
- 如果没有匹配节点，Workbench 会根据 launch result 打开一个新节点。

V1 不实现精确 `targetNodeId` 路由。如果后续产品需要在多个 Codex 节点中选择某一个，可以再加。

## 数据契约

### 新的 Workbench Activation

在 `packages/agent/gui/workbench/types.ts` 中添加：

```ts
export const agentGuiWorkbenchPrefillPromptActivationType =
  "agent-gui:prefill-prompt";

export interface AgentGuiWorkbenchPrefillPromptPayload {
  draftPrompt: string;
  userProjectPath?: string | null;
}
```

该 payload 是瞬时数据，不能写入持久化 Workbench snapshot 或外部 node state。

### 新的 Launch Helper

在 `packages/agent/gui/workbench/launch.ts` 中添加：

```ts
export function createAgentGuiWorkbenchDraftLaunchRequest(input: {
  draftPrompt: string;
  provider: unknown;
  userProjectPath?: string | null;
}) {
  const provider = normalizeAgentGuiWorkbenchProvider(input.provider);
  return {
    dockEntryId: agentGuiWorkbenchDockEntryId(provider),
    payload: {
      draftPrompt: input.draftPrompt,
      provider,
      ...(input.userProjectPath?.trim()
        ? { userProjectPath: input.userProjectPath.trim() }
        : {})
    },
    reason: "host" as const,
    typeId: agentGuiWorkbenchTypeId
  };
}
```

### Launch Descriptor 行为

更新 `createAgentGuiWorkbenchLaunchDescriptor`：当 payload 中有非空 `draftPrompt` 时，返回：

```ts
{
  activation: {
    payload: {
      draftPrompt,
      ...(userProjectPath ? { userProjectPath } : {})
    },
    type: agentGuiWorkbenchPrefillPromptActivationType
  },
  dockEntryId: request.dockEntryId ?? agentGuiWorkbenchDockEntryId(provider),
  instanceId: createAgentGuiWorkbenchInstanceId({ provider }),
  provider,
  reuseDockEntryNode: true,
  targetAgentSessionId: null
}
```

保持现有 session launch 行为不变。session launch 继续使用 `agentGuiWorkbenchOpenSessionActivationType` 和 `targetAgentSessionId`。

### Desktop Launch Request

扩展 `apps/desktop/src/renderer/src/features/workspace-agent/services/workspaceAgentGuiLaunchCoordinator.ts` 中的 `WorkspaceAgentGuiLaunchRequest`：

```ts
export interface WorkspaceAgentGuiLaunchRequest {
  agentSessionId?: string;
  draftPrompt?: string;
  provider: DesktopAgentGUIProvider;
  userProjectPath?: string | null;
  workspaceId: string;
}
```

在 `WorkspaceWorkbench` 中，如果请求带有 `draftPrompt.trim()`，则路由到新的 draft launch helper；如果请求带 `agentSessionId`，继续使用 `createWorkspaceAgentGuiSessionLaunchRequest`。

## 需要修改的文件

- `packages/agent/gui/workbench/types.ts`
  - 定义新的 activation type 和 payload type。

- `packages/agent/gui/workbench/launch.ts`
  - 负责 payload 解析和 `createAgentGuiWorkbenchDraftLaunchRequest`。
  - 确保 prefill launch 使用 `reuseDockEntryNode: true`。

- `packages/agent/gui/workbench/launch.test.ts`
  - 验证 draft launch request 结构。
  - 验证 launch descriptor 生成 prefill activation。
  - 验证 draft launch 复用 dock entry node，并且没有 target session id。

- `apps/desktop/src/renderer/src/features/workspace-workbench/services/workspaceAgentGuiLaunch.ts`
  - 重新导出新的 draft launch helper，命名为 `createWorkspaceAgentGuiDraftLaunchRequest`。

- `apps/desktop/src/renderer/src/features/workspace-agent/services/workspaceAgentGuiLaunchCoordinator.ts`
  - 扩展 desktop launch request 结构。

- `apps/desktop/src/renderer/src/features/workspace-workbench/ui/WorkspaceWorkbench.tsx`
  - 将 draft launch request 路由到 `host.launchNode(createWorkspaceAgentGuiDraftLaunchRequest(...))`。
  - 保持 session launch request 行为不变。

- `apps/desktop/src/renderer/src/features/workspace-agent/ui/DesktopAgentGUIWorkbenchBody.tsx`
  - 从 `context.activation` 读取 prefill activation。
  - 将一次性 prefill request 传给 `AgentGUI`。
  - 复用现有 focus 行为，或把 activation sequence 作为 composer focus request 下传。

- `packages/agent/gui/AgentGUI.tsx`
  - 接收新的可选 prefill request prop，并转发给 `AgentGUINode`。

- `packages/agent/gui/agent-gui/agentGuiNode/AgentGUINode.tsx`
  - 添加 prefill request 的 prop 类型，并转发给 `useAgentGUINodeController`。

- `packages/agent/gui/agent-gui/agentGuiNode/controller/useAgentGUINodeController.ts`
  - 消费一次性 prefill request。
  - 写入 `draftBySessionId[nodeDefaultDraftPromptKey(provider)]`。
  - 可选地根据 `userProjectPath` 设置选中的项目路径。
  - 不创建、不 activate、不发送 agent session。

- `packages/agent/gui/agent-gui/agentGuiNode/controller/useAgentGUINodeController.spec.tsx`
  - 验证 prompt prefill 能进入 draft prompt。
  - 验证 prefill 不调用 `activateSession` 或 `sendInput`。
  - 验证重复 activation sequence 会被忽略。

- `apps/desktop/src/renderer/src/features/workspace-agent/ui/DesktopAgentGUIWorkbenchBody` 相关测试
  - 如果已有或容易添加，验证 activation payload 能传给 Agent GUI。

- `apps/desktop/src/renderer/src/features/workspace-issue-manager/internal/adapters/desktopIssueManagerAgentRunner.ts`
  - 添加 prefill launcher 路径，或新增一个 adapter，供 issue-manager 的预填动作使用。

- `packages/workspace/issue-manager/src/contracts/adapters.ts`
  - 如果共享 issue manager 要把这个能力作为一等 action 暴露，则新增 host adapter 类型，而不是复用 `IssueManagerAgentRunner`。

- `packages/workspace/issue-manager/src/services/internal/controllerActions.ts`
  - 如果产品 copy 从“Agent 执行”变为预填动作，则将新的 UI action 路由到 prefill 而不是 run。

## 实施任务

### 任务 1：添加 Agent GUI Workbench Draft Launch 契约

**文件：**

- 修改：`packages/agent/gui/workbench/types.ts`
- 修改：`packages/agent/gui/workbench/launch.ts`
- 测试：`packages/agent/gui/workbench/launch.test.ts`

- [ ] **步骤 1：添加 draft launch request 结构的失败测试**

添加测试断言：

```ts
const request = createAgentGuiWorkbenchDraftLaunchRequest({
  provider: "codex",
  draftPrompt: "Review this issue",
  userProjectPath: "/Users/example/project"
});

assert.equal(request.typeId, agentGuiWorkbenchTypeId);
assert.equal(request.dockEntryId, agentGuiWorkbenchDockEntryId("codex"));
assert.deepEqual(request.payload, {
  provider: "codex",
  draftPrompt: "Review this issue",
  userProjectPath: "/Users/example/project"
});
```

- [ ] **步骤 2：添加 launch descriptor 的失败测试**

添加测试断言：

```ts
const descriptor = createAgentGuiWorkbenchLaunchDescriptor(
  createAgentGuiWorkbenchDraftLaunchRequest({
    provider: "codex",
    draftPrompt: "Review this issue"
  })
);

assert.equal(descriptor.provider, "codex");
assert.equal(descriptor.reuseDockEntryNode, true);
assert.equal(descriptor.targetAgentSessionId, null);
assert.deepEqual(descriptor.activation, {
  type: agentGuiWorkbenchPrefillPromptActivationType,
  payload: {
    draftPrompt: "Review this issue"
  }
});
```

- [ ] **步骤 3：运行定向测试并确认失败**

运行：

```bash
pnpm --filter @tutti-os/agent-gui test -- workbench/launch.test.ts
```

预期：失败，因为 draft launch helper 和 activation type 尚不存在。

- [ ] **步骤 4：实现 activation type 和 launch helper**

在 `types.ts` 添加 activation 常量和 payload interface。在 `launch.ts` 添加 `createAgentGuiWorkbenchDraftLaunchRequest`。

- [ ] **步骤 5：在 descriptor 中实现 draft payload 解析**

在 `launch.ts` 添加类似解析函数：

```ts
function prefillPromptFromLaunchPayload(
  payload: unknown
): { draftPrompt: string; userProjectPath?: string | null } | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const draftPrompt = (payload as { draftPrompt?: unknown }).draftPrompt;
  if (typeof draftPrompt !== "string" || !draftPrompt.trim()) {
    return null;
  }
  const userProjectPath = (payload as { userProjectPath?: unknown })
    .userProjectPath;
  return {
    draftPrompt,
    ...(typeof userProjectPath === "string" && userProjectPath.trim()
      ? { userProjectPath: userProjectPath.trim() }
      : {})
  };
}
```

在构造 session activation 之前使用该 parser。如果 parser 返回值存在，则返回 `reuseDockEntryNode: true` 且 `targetAgentSessionId: null` 的 descriptor。

- [ ] **步骤 6：运行定向测试并确认通过**

运行：

```bash
pnpm --filter @tutti-os/agent-gui test -- workbench/launch.test.ts
```

预期：通过。

### 任务 2：路由 Desktop Agent GUI Launch Request

**文件：**

- 修改：`apps/desktop/src/renderer/src/features/workspace-workbench/services/workspaceAgentGuiLaunch.ts`
- 修改：`apps/desktop/src/renderer/src/features/workspace-agent/services/workspaceAgentGuiLaunchCoordinator.ts`
- 修改：`apps/desktop/src/renderer/src/features/workspace-workbench/ui/WorkspaceWorkbench.tsx`
- 测试：如果已有 desktop workbench launch 测试则使用；否则围绕 launch helper routing 添加聚焦测试。

- [ ] **步骤 1：重新导出 draft launch helper**

在 `workspaceAgentGuiLaunch.ts` 中导出：

```ts
createAgentGuiWorkbenchDraftLaunchRequest as createWorkspaceAgentGuiDraftLaunchRequest;
```

- [ ] **步骤 2：扩展 launch request 类型**

给 `WorkspaceAgentGuiLaunchRequest` 添加可选字段 `draftPrompt` 和 `userProjectPath`。

- [ ] **步骤 3：让 draft request 优先于 session request 路由**

在 `WorkspaceWorkbench.tsx` 中更新注册的 handler：

```ts
async ({ agentSessionId, draftPrompt, provider, userProjectPath }) => {
  const normalizedDraftPrompt = draftPrompt?.trim() ?? "";
  await host.launchNode(
    normalizedDraftPrompt
      ? createWorkspaceAgentGuiDraftLaunchRequest({
          draftPrompt: normalizedDraftPrompt,
          provider,
          userProjectPath
        })
      : createWorkspaceAgentGuiSessionLaunchRequest({
          agentSessionId,
          provider
        })
  );
};
```

当 `draftPrompt` 为空时，session 行为必须保持不变。

- [ ] **步骤 4：确认该路由不会创建 runtime session**

审查该任务中的代码，确保只调用 `host.launchNode`，不要导入或调用 `IWorkspaceAgentPromptSessionService`、`activateSession`、`sendInput`。

### 任务 3：在 Agent GUI 中消费 Prompt Prefill Activation

**文件：**

- 修改：`apps/desktop/src/renderer/src/features/workspace-agent/ui/DesktopAgentGUIWorkbenchBody.tsx`
- 修改：`packages/agent/gui/AgentGUI.tsx`
- 修改：`packages/agent/gui/agent-gui/agentGuiNode/AgentGUINode.tsx`
- 修改：`packages/agent/gui/agent-gui/agentGuiNode/controller/useAgentGUINodeController.ts`
- 测试：`packages/agent/gui/agent-gui/agentGuiNode/controller/useAgentGUINodeController.spec.tsx`

- [ ] **步骤 1：添加 controller 测试**

使用 prefill request 挂载 controller：

```ts
prefillPromptRequest: {
  sequence: 1,
  draftPrompt: "Review this issue",
  userProjectPath: "/Users/example/project"
}
```

断言：

```ts
expect(result.current.viewModel.draftPrompt).toBe("Review this issue");
expect(agentActivityRuntime.activateSession).not.toHaveBeenCalled();
expect(agentActivityRuntime.sendInput).not.toHaveBeenCalled();
```

第二次 rerender 使用相同 `sequence` 和不同 prompt，断言 draft 仍然是 `"Review this issue"`。

第三次 rerender 使用 `sequence: 2` 和 prompt `"Review this follow-up"`，断言 draft 变为 `"Review this follow-up"`。

- [ ] **步骤 2：添加 prop 透传**

添加可选 prop：

```ts
prefillPromptRequest?: {
  draftPrompt: string;
  sequence: number;
  userProjectPath?: string | null;
} | null;
```

按以下链路透传：

```text
DesktopAgentGUIWorkbenchBody
  -> AgentGUI
  -> AgentGUINode
  -> useAgentGUINodeController
```

- [ ] **步骤 3：在 DesktopAgentGUIWorkbenchBody 中解析 activation**

添加本地 resolver：

```ts
function resolvePrefillPromptActivation(
  activation: WorkbenchHostActivation | null
) {
  if (
    !activation ||
    activation.type !== desktopAgentGUIPrefillPromptActivationType
  ) {
    return null;
  }
  const payload = activation.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const draftPrompt = (payload as { draftPrompt?: unknown }).draftPrompt;
  if (typeof draftPrompt !== "string" || !draftPrompt.trim()) {
    return null;
  }
  const userProjectPath = (payload as { userProjectPath?: unknown })
    .userProjectPath;
  return {
    draftPrompt,
    sequence: activation.sequence,
    ...(typeof userProjectPath === "string" && userProjectPath.trim()
      ? { userProjectPath: userProjectPath.trim() }
      : {})
  };
}
```

常量可以从 `desktopAgentGUINodeState.ts` 重新导出，模式参考现有 open-session activation export。

- [ ] **步骤 4：在 controller 中消费 request**

在 `useAgentGUINodeController` 中添加：

```ts
const handledPrefillPromptSequenceRef = useRef<number | null>(null);

useEffect(() => {
  const request = prefillPromptRequest;
  if (
    !request ||
    handledPrefillPromptSequenceRef.current === request.sequence
  ) {
    return;
  }
  handledPrefillPromptSequenceRef.current = request.sequence;
  const prompt = request.draftPrompt.trim();
  if (!prompt) {
    return;
  }
  if (request.userProjectPath?.trim()) {
    const projectPath = normalizeProjectDraftPath(request.userProjectPath);
    selectedProjectPathRef.current = projectPath;
    setSelectedProjectPath(projectPath);
  }
  const previous = activeConversationIdRef.current;
  if (previous) {
    void activation.unactivate(previous);
  }
  isComposerHomeRef.current = true;
  setIsComposerHome(true);
  activeConversationIdRef.current = null;
  setActiveConversationId(null);
  setDraftBySessionId((current) => ({
    ...current,
    [nodeDefaultDraftPromptKey(dataRef.current.provider)]: prompt
  }));
  persistActiveConversation(null);
}, [activation, persistActiveConversation, prefillPromptRequest]);
```

这里刻意切到 home composer，避免把 draft 追加到正在运行的 session 上。该逻辑不调用 `activateSession({ mode: "new" })`。

- [ ] **步骤 5：聚焦 composer**

复用 `composerFocusRequestSequence`。把 prefill activation sequence 当作 focus request：

```ts
const composerFocusRequestSequence =
  context.activation?.type === workbenchFocusInputActivationType ||
  context.activation?.type === desktopAgentGUIPrefillPromptActivationType
    ? context.activation.sequence
    : null;
```

- [ ] **步骤 6：运行 Agent GUI controller 测试**

运行：

```bash
pnpm --filter @tutti-os/agent-gui test -- agent-gui/agentGuiNode/controller/useAgentGUINodeController.spec.tsx
```

预期：通过。

### 任务 4：添加 Issue Manager Prefill Adapter

**文件：**

- 修改：`packages/workspace/issue-manager/src/contracts/adapters.ts`
- 修改：`packages/workspace/issue-manager/src/core/feature.ts`
- 修改：`apps/desktop/src/renderer/src/features/workspace-issue-manager/index.ts`
- 修改：`apps/desktop/src/renderer/src/features/workspace-issue-manager/internal/adapters/desktopIssueManagerAgentRunner.ts`
- 修改：`packages/workspace/issue-manager/src/services/internal/controllerActions.ts`
- 测试：`packages/workspace/issue-manager/src/services/internal/controllerActions.test.ts`
- 测试：`apps/desktop/src/renderer/src/features/workspace-issue-manager/internal/adapters/desktopIssueManagerAgentRunner.test.ts`

- [ ] **步骤 1：添加共享 prefill adapter contract**

添加：

```ts
export interface IssueManagerAgentPromptPrefillRequest extends IssueManagerScope {
  executionDirectory?: string | null;
  issue: IssueManagerIssueSummary;
  provider: string;
  task?: IssueManagerTaskSummary;
}

export interface IssueManagerAgentPromptPrefillResult {
  errorMessage?: string;
  status: "opened" | "failed";
}

export interface IssueManagerAgentPromptPrefillLauncher {
  prefillPrompt(
    input: IssueManagerAgentPromptPrefillRequest
  ): Promise<IssueManagerAgentPromptPrefillResult>;
}
```

在 `IssueManagerFeature` 中添加可选字段 `agentPromptPrefillLauncher?: IssueManagerAgentPromptPrefillLauncher`。

- [ ] **步骤 2：实现 desktop prefill launcher**

在 desktop adapter 中构造和执行路径相同的 prompt：

```ts
const prompt = buildIssueManagerRunPrompt({
  copy: createIssueManagerI18nRuntime(input.i18n),
  issue: request.issue,
  task: request.task,
  workspaceRoot: "."
});
```

然后调用：

```ts
await input.launchAgentGui?.({
  draftPrompt: prompt,
  provider: request.provider,
  userProjectPath: request.executionDirectory,
  workspaceId: input.workspaceId
});
```

成功时返回 `{ status: "opened" }`，launch 失败时返回 `{ status: "failed", errorMessage }`。

- [ ] **步骤 3：保持现有 run adapter 不变**

本任务不要修改 `createDesktopIssueManagerAgentRunner.runTask`。该路径仍然是真正执行路径，应继续创建带 `initialContent` 的 runtime session。

- [ ] **步骤 4：添加 controller action**

新增类似 `prefillAgentPrompt(providerOverride?: string)` 的 action。复用 `runTask` 的 provider plan，但调用 `agentPromptPrefillLauncher.prefillPrompt`。

埋点需要和执行分开。使用新的 event name，例如：

```ts
issue_manager.task_prompt_prefill_opened;
```

这样不会把 prompt 预填统计成 task run。

- [ ] **步骤 5：添加测试**

Controller 测试断言：

```ts
assert.equal(prefillCalls.length, 1);
assert.deepEqual(prefillCalls[0]?.issue, issue);
assert.deepEqual(prefillCalls[0]?.task, task);
assert.equal(prefillCalls[0]?.provider, "codex");
assert.deepEqual(runCalls, []);
```

Desktop adapter 测试断言：

```ts
assert.equal(capturedLaunch?.provider, "codex");
assert.equal(capturedLaunch?.workspaceId, "workspace-1");
assert.match(capturedLaunch?.draftPrompt ?? "", /Handle this issue reference/);
assert.match(capturedLaunch?.draftPrompt ?? "", /mention:\/\/workspace-issue/);
assert.equal(capturedLaunch?.userProjectPath, "/Users/example/project");
```

### 任务 5：接入 UI 文案和按钮行为

**文件：**

- 修改：`packages/workspace/issue-manager/src/i18n/issueManagerI18n.ts`
- 修改：`packages/workspace/issue-manager/src/ui/internal/task/IssueManagerRunSections.tsx`
- 测试：如果已有 issue-manager UI 测试则使用。

- [ ] **步骤 1：确认产品文案**

使用明确文案，让用户知道这不会执行：

```ts
askAgentToPrefillPrompt: "填入 Codex";
```

如果当前按钮必须继续叫 `Agent 执行`，则保持执行按钮不变，额外添加一个 prefill 菜单项。不要在没有产品确认的情况下静默改变 `Agent 执行` 的语义。

- [ ] **步骤 2：把 prefill action 接到 UI**

添加 action trigger，调用：

```ts
controller.prefillAgentPrompt(provider);
```

复用相同的 provider 下拉组件，这样用户之后也可以选择 Codex 以外的 provider，如果产品允许的话。

- [ ] **步骤 3：如果 V1 只支持 Codex，则限制 provider**

如果 V1 只支持 Codex，过滤 provider options：

```ts
providerOptions.filter((option) => option.provider === "codex");
```

如果 Codex 不可用，显示现有的 no-provider disabled menu item。

### 任务 6：端到端验证

**文件：**

- 不修改生产文件，除非测试暴露 bug。

- [ ] **步骤 1：运行聚焦 package 测试**

运行：

```bash
pnpm --filter @tutti-os/agent-gui test -- workbench/launch.test.ts
pnpm --filter @tutti-os/agent-gui test -- agent-gui/agentGuiNode/controller/useAgentGUINodeController.spec.tsx
pnpm --filter @tutti-os/workspace-issue-manager test -- services/internal/controllerActions.test.ts
```

预期：全部通过。

- [ ] **步骤 2：运行 desktop adapter 测试**

运行仓库中用于 feature test 的 desktop renderer 测试命令。如果仓库提供聚焦 test target，只跑：

```text
features/workspace-issue-manager/internal/adapters/desktopIssueManagerAgentRunner.test.ts
features/workspace-agent/ui/DesktopAgentGUIWorkbenchBody...
```

预期：全部通过。

- [ ] **步骤 3：在 app 内手动验证**

1. 打开一个没有 Codex 节点的 workspace。
2. 触发 issue-manager prefill action。
3. 确认打开了一个 Codex Agent GUI 节点。
4. 确认 composer 中包含生成的 prompt。
5. 确认用户发送前没有 agent run 启动，Message Center 中也没有新 session。
6. 如果可行，再打开第二个 Codex 节点。
7. 再次触发 prefill。
8. 确认只有最上层可复用的 Codex dock 节点 draft 发生变化。
9. 确认其他 Codex 节点没有变化。

## 风险和护栏

- **风险：误启动 run。** 护栏：prefill 路径远离 `initialContent`、`activateSession(mode: "new")` 和 `sendInput`。
- **风险：多个 Codex 节点一起响应。** 护栏：使用 Workbench node activation，不使用 `window.dispatchEvent` 或全局 store 广播。
- **风险：prompt 落入已有 active conversation。** V1 写 draft 前应切到 home composer。
- **风险：覆盖用户已有 draft。** V1 有意替换当前 provider 的 home draft。如果不能接受，后续产品迭代可以加确认或 append 行为。
- **风险：Codex provider 不可用但入口仍显示。** 复用现有 provider status options 和 disabled reason。

## 不在范围内

- 在多个已打开 Codex 节点中精确选择某一个。
- 跨 app 重启持久化 prompt draft。
- 预填后自动启动 run。
- 泛化到所有 provider，除非产品明确要求。
- 在没有明显文案或产品确认的情况下改变现有 `Agent 执行` 语义。

## 成功标准

- 触发新流程后，只打开或复用一个 Codex 节点。
- 如果不存在 Codex 节点，则新建一个 Codex 节点并收到 prompt。
- prompt 可见于 composer。
- 用户必须手动发送。
- 仅预填不会创建 runtime agent session。
- 现有 session launch 和 issue-manager 执行流程保持不变。
