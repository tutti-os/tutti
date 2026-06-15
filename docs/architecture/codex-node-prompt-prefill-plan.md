# Codex Node Prompt Prefill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open or reuse one Codex Agent GUI workbench node, prefill its composer with a prompt, and wait for the user to manually send it.

**Architecture:** Add a one-shot Agent GUI workbench activation for prompt prefill. The issue manager must stop using the prompt-session path for this flow because that path creates a runtime session with initial content. The new flow sends a launch request to Workbench, lets Workbench pick or create exactly one Agent GUI node, then the node writes the prompt into its local draft composer state.

**Tech Stack:** TypeScript, React, `@tutti-os/workbench-surface`, `@tutti-os/agent-gui`, desktop renderer workbench contributions, issue-manager feature adapters.

---

## Current Behavior

The issue manager action currently runs through:

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

That is the wrong primitive for prompt prefill. `initialContent` creates a real agent runtime session and starts the agent-side execution path. The prefill flow must not call:

- `WorkspaceAgentPromptSessionService.createSession`
- `WorkspaceAgentActivityService.activateSession({ mode: "new", initialContent })`
- `WorkspaceAgentActivityService.sendInput`

The Agent GUI already has local draft state:

- `draftBySessionId`
- `updateDraftPrompt`
- `nodeDefaultDraftPromptKey(provider)`

The implementation should write the generated prompt into that draft state and focus the composer.

## Desired Behavior

When a task center action requests Codex prompt prefill:

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
  -> Workbench reuses one existing Codex node if present
     OR creates one new Codex node if none exists
  -> target node receives one-shot "agent-gui:prefill-prompt" activation
  -> target node writes draftPrompt into its composer draft
  -> target node focuses the composer
  -> user manually sends
```

Only the target node receives the activation. Other Codex nodes do not see this request unless a future implementation deliberately broadcasts it, which this plan forbids.

## Node Selection Rule

Use this rule for V1:

1. Prefer the topmost existing node with the Codex dock entry.
2. If no Codex node exists, create a new Codex node.
3. Deliver the prefill activation to that one node.

This matches existing Workbench `reuseDockEntryNode` behavior:

- `reuseDockEntryNode: true`
- `dockEntryId: agentGuiWorkbenchDockEntryId("codex")`
- Workbench searches the node stack from front to back and reuses the first matching node.
- If no match exists, Workbench opens a new node from the launch result.

Do not implement exact `targetNodeId` routing in V1. That can be added later if product requirements need choosing among multiple Codex nodes.

## Data Contract

### New Workbench Activation

Add to `packages/agent/gui/workbench/types.ts`:

```ts
export const agentGuiWorkbenchPrefillPromptActivationType =
  "agent-gui:prefill-prompt";

export interface AgentGuiWorkbenchPrefillPromptPayload {
  draftPrompt: string;
  userProjectPath?: string | null;
}
```

The payload is transient. It must not be written into persisted Workbench snapshots or external node state.

### New Launch Helper

Add to `packages/agent/gui/workbench/launch.ts`:

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

### Launch Descriptor Behavior

Update `createAgentGuiWorkbenchLaunchDescriptor` so a payload with a non-empty `draftPrompt` returns:

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

Keep existing session launch behavior unchanged. Session launch continues to use `agentGuiWorkbenchOpenSessionActivationType` and `targetAgentSessionId`.

### Desktop Launch Request

Extend `WorkspaceAgentGuiLaunchRequest` in `apps/desktop/src/renderer/src/features/workspace-agent/services/workspaceAgentGuiLaunchCoordinator.ts`:

```ts
export interface WorkspaceAgentGuiLaunchRequest {
  agentSessionId?: string;
  draftPrompt?: string;
  provider: DesktopAgentGUIProvider;
  userProjectPath?: string | null;
  workspaceId: string;
}
```

In `WorkspaceWorkbench`, route requests with `draftPrompt.trim()` to the new draft launch helper. Requests with `agentSessionId` keep using `createWorkspaceAgentGuiSessionLaunchRequest`.

## Files To Modify

- `packages/agent/gui/workbench/types.ts`
  - Owns the new activation type and payload type.

- `packages/agent/gui/workbench/launch.ts`
  - Owns payload parsing and `createAgentGuiWorkbenchDraftLaunchRequest`.
  - Ensures `reuseDockEntryNode: true` for prefill launches.

- `packages/agent/gui/workbench/launch.test.ts`
  - Verifies draft launch request shape.
  - Verifies launch descriptor produces prefill activation.
  - Verifies draft launch reuses dock entry node and has no target session id.

- `apps/desktop/src/renderer/src/features/workspace-workbench/services/workspaceAgentGuiLaunch.ts`
  - Re-export the new draft launch helper as `createWorkspaceAgentGuiDraftLaunchRequest`.

- `apps/desktop/src/renderer/src/features/workspace-agent/services/workspaceAgentGuiLaunchCoordinator.ts`
  - Extends desktop launch request shape.

- `apps/desktop/src/renderer/src/features/workspace-workbench/ui/WorkspaceWorkbench.tsx`
  - Routes draft launch requests to `host.launchNode(createWorkspaceAgentGuiDraftLaunchRequest(...))`.
  - Keeps session launch requests unchanged.

- `apps/desktop/src/renderer/src/features/workspace-agent/ui/DesktopAgentGUIWorkbenchBody.tsx`
  - Reads the prefill activation from `context.activation`.
  - Passes a one-shot prefill request into `AgentGUI`.
  - Reuses existing focus behavior or forwards the activation sequence as a composer focus request.

- `packages/agent/gui/AgentGUI.tsx`
  - Accepts the new optional prefill request prop and forwards it to `AgentGUINode`.

- `packages/agent/gui/agent-gui/agentGuiNode/AgentGUINode.tsx`
  - Adds prop typing for the prefill request and forwards it to `useAgentGUINodeController`.

- `packages/agent/gui/agent-gui/agentGuiNode/controller/useAgentGUINodeController.ts`
  - Consumes the one-shot prefill request.
  - Writes into `draftBySessionId[nodeDefaultDraftPromptKey(provider)]`.
  - Optionally sets selected project path from `userProjectPath`.
  - Does not create, activate, or send an agent session.

- `packages/agent/gui/agent-gui/agentGuiNode/controller/useAgentGUINodeController.spec.tsx`
  - Verifies prompt prefill lands in draft prompt.
  - Verifies the prefill does not call `activateSession` or `sendInput`.
  - Verifies duplicate activation sequences are ignored.

- `apps/desktop/src/renderer/src/features/workspace-agent/ui/DesktopAgentGUIWorkbenchBody` tests, if present or easy to add.
  - Verifies activation payload is passed to Agent GUI.

- `apps/desktop/src/renderer/src/features/workspace-issue-manager/internal/adapters/desktopIssueManagerAgentRunner.ts`
  - Add a prefill launcher path or a new adapter for issue-manager actions that should prefill instead of execute.

- `packages/workspace/issue-manager/src/contracts/adapters.ts`
  - Add a host adapter type if the shared issue manager should expose this as a first-class action rather than overloading `IssueManagerAgentRunner`.

- `packages/workspace/issue-manager/src/services/internal/controllerActions.ts`
  - Route the new UI action to prefill instead of run, if product copy changes from "Agent 执行" to a prefill action.

## Implementation Tasks

### Task 1: Add Agent GUI Workbench Draft Launch Contract

**Files:**

- Modify: `packages/agent/gui/workbench/types.ts`
- Modify: `packages/agent/gui/workbench/launch.ts`
- Test: `packages/agent/gui/workbench/launch.test.ts`

- [ ] **Step 1: Add failing tests for draft launch request shape**

Add tests that assert:

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

- [ ] **Step 2: Add failing tests for launch descriptor**

Add tests that assert:

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

- [ ] **Step 3: Run the targeted test and verify it fails**

Run:

```bash
pnpm --filter @tutti-os/agent-gui test -- workbench/launch.test.ts
```

Expected: failure because the draft launch helper and activation type do not exist.

- [ ] **Step 4: Implement the activation type and launch helper**

Add the activation constant and payload interface in `types.ts`. Add `createAgentGuiWorkbenchDraftLaunchRequest` in `launch.ts`.

- [ ] **Step 5: Implement draft payload parsing in the descriptor**

In `launch.ts`, add a parser like:

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

Use this parser before session activation construction. If present, return a descriptor with `reuseDockEntryNode: true` and `targetAgentSessionId: null`.

- [ ] **Step 6: Run the targeted test and verify it passes**

Run:

```bash
pnpm --filter @tutti-os/agent-gui test -- workbench/launch.test.ts
```

Expected: pass.

### Task 2: Route Desktop Agent GUI Launch Requests

**Files:**

- Modify: `apps/desktop/src/renderer/src/features/workspace-workbench/services/workspaceAgentGuiLaunch.ts`
- Modify: `apps/desktop/src/renderer/src/features/workspace-agent/services/workspaceAgentGuiLaunchCoordinator.ts`
- Modify: `apps/desktop/src/renderer/src/features/workspace-workbench/ui/WorkspaceWorkbench.tsx`
- Test: existing desktop workbench launch tests if available, or add focused tests around the launch helper routing.

- [ ] **Step 1: Re-export draft launch helper**

In `workspaceAgentGuiLaunch.ts`, export:

```ts
createAgentGuiWorkbenchDraftLaunchRequest as createWorkspaceAgentGuiDraftLaunchRequest;
```

- [ ] **Step 2: Extend launch request type**

Add optional `draftPrompt` and `userProjectPath` to `WorkspaceAgentGuiLaunchRequest`.

- [ ] **Step 3: Route draft requests before session requests**

In `WorkspaceWorkbench.tsx`, update the registered handler:

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

Session behavior must remain unchanged when `draftPrompt` is empty.

- [ ] **Step 4: Verify no runtime session is created by this route**

Review that this task only calls `host.launchNode`. It must not import or call `IWorkspaceAgentPromptSessionService`, `activateSession`, or `sendInput`.

### Task 3: Consume Prompt Prefill Activation In Agent GUI

**Files:**

- Modify: `apps/desktop/src/renderer/src/features/workspace-agent/ui/DesktopAgentGUIWorkbenchBody.tsx`
- Modify: `packages/agent/gui/AgentGUI.tsx`
- Modify: `packages/agent/gui/agent-gui/agentGuiNode/AgentGUINode.tsx`
- Modify: `packages/agent/gui/agent-gui/agentGuiNode/controller/useAgentGUINodeController.ts`
- Test: `packages/agent/gui/agent-gui/agentGuiNode/controller/useAgentGUINodeController.spec.tsx`

- [ ] **Step 1: Add controller tests**

Add tests that mount the controller with a prefill request:

```ts
prefillPromptRequest: {
  sequence: 1,
  draftPrompt: "Review this issue",
  userProjectPath: "/Users/example/project"
}
```

Assert:

```ts
expect(result.current.viewModel.draftPrompt).toBe("Review this issue");
expect(agentActivityRuntime.activateSession).not.toHaveBeenCalled();
expect(agentActivityRuntime.sendInput).not.toHaveBeenCalled();
```

Add a second rerender with the same `sequence` and a different prompt. Assert the draft remains `"Review this issue"`.

Add a third rerender with `sequence: 2` and prompt `"Review this follow-up"`. Assert the draft changes to `"Review this follow-up"`.

- [ ] **Step 2: Add prop plumbing**

Add an optional prop:

```ts
prefillPromptRequest?: {
  draftPrompt: string;
  sequence: number;
  userProjectPath?: string | null;
} | null;
```

Thread it through:

```text
DesktopAgentGUIWorkbenchBody
  -> AgentGUI
  -> AgentGUINode
  -> useAgentGUINodeController
```

- [ ] **Step 3: Parse activation in DesktopAgentGUIWorkbenchBody**

Add a local resolver:

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

The constant can be re-exported from `desktopAgentGUINodeState.ts`, following the existing open-session activation export pattern.

- [ ] **Step 4: Consume the request in the controller**

In `useAgentGUINodeController`, add:

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

This deliberately switches to the home composer so the draft is not appended to a running session. It does not call `activateSession({ mode: "new" })`.

- [ ] **Step 5: Focus the composer**

Reuse `composerFocusRequestSequence`. Treat the prefill activation sequence as a focus request:

```ts
const composerFocusRequestSequence =
  context.activation?.type === workbenchFocusInputActivationType ||
  context.activation?.type === desktopAgentGUIPrefillPromptActivationType
    ? context.activation.sequence
    : null;
```

- [ ] **Step 6: Run Agent GUI controller tests**

Run:

```bash
pnpm --filter @tutti-os/agent-gui test -- agent-gui/agentGuiNode/controller/useAgentGUINodeController.spec.tsx
```

Expected: pass.

### Task 4: Add Issue Manager Prefill Adapter

**Files:**

- Modify: `packages/workspace/issue-manager/src/contracts/adapters.ts`
- Modify: `packages/workspace/issue-manager/src/core/feature.ts`
- Modify: `apps/desktop/src/renderer/src/features/workspace-issue-manager/index.ts`
- Modify: `apps/desktop/src/renderer/src/features/workspace-issue-manager/internal/adapters/desktopIssueManagerAgentRunner.ts`
- Modify: `packages/workspace/issue-manager/src/services/internal/controllerActions.ts`
- Test: `packages/workspace/issue-manager/src/services/internal/controllerActions.test.ts`
- Test: `apps/desktop/src/renderer/src/features/workspace-issue-manager/internal/adapters/desktopIssueManagerAgentRunner.test.ts`

- [ ] **Step 1: Add a shared prefill adapter contract**

Add:

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

Add optional `agentPromptPrefillLauncher?: IssueManagerAgentPromptPrefillLauncher` to `IssueManagerFeature`.

- [ ] **Step 2: Implement desktop prefill launcher**

In the desktop adapter, build the same prompt as execution:

```ts
const prompt = buildIssueManagerRunPrompt({
  copy: createIssueManagerI18nRuntime(input.i18n),
  issue: request.issue,
  task: request.task,
  workspaceRoot: "."
});
```

Then call:

```ts
await input.launchAgentGui?.({
  draftPrompt: prompt,
  provider: request.provider,
  userProjectPath: request.executionDirectory,
  workspaceId: input.workspaceId
});
```

Return `{ status: "opened" }` on success and `{ status: "failed", errorMessage }` on launch failure.

- [ ] **Step 3: Keep existing run adapter unchanged**

Do not change `createDesktopIssueManagerAgentRunner.runTask` in this task. That path is still the real execution path and should continue creating runtime sessions with `initialContent`.

- [ ] **Step 4: Add controller action for prefill**

Add a new action such as `prefillAgentPrompt(providerOverride?: string)`. Use the same provider plan as `runTask`, but call `agentPromptPrefillLauncher.prefillPrompt`.

Track analytics separately from execution. Use a new event name such as:

```ts
issue_manager.task_prompt_prefill_opened;
```

This avoids counting prompt prefill as a task run.

- [ ] **Step 5: Add tests**

Controller tests should assert:

```ts
assert.equal(prefillCalls.length, 1);
assert.deepEqual(prefillCalls[0]?.issue, issue);
assert.deepEqual(prefillCalls[0]?.task, task);
assert.equal(prefillCalls[0]?.provider, "codex");
assert.deepEqual(runCalls, []);
```

Desktop adapter tests should assert:

```ts
assert.equal(capturedLaunch?.provider, "codex");
assert.equal(capturedLaunch?.workspaceId, "workspace-1");
assert.match(capturedLaunch?.draftPrompt ?? "", /Handle this issue reference/);
assert.match(capturedLaunch?.draftPrompt ?? "", /mention:\/\/workspace-issue/);
assert.equal(capturedLaunch?.userProjectPath, "/Users/example/project");
```

### Task 5: Wire UI Copy And Button Behavior

**Files:**

- Modify: `packages/workspace/issue-manager/src/i18n/issueManagerI18n.ts`
- Modify: `packages/workspace/issue-manager/src/ui/internal/task/IssueManagerRunSections.tsx`
- Test: existing issue-manager UI tests if available.

- [ ] **Step 1: Decide product copy**

Use explicit copy so the user understands this does not execute:

```ts
askAgentToPrefillPrompt: "填入 Codex";
```

If the current button must remain labeled `Agent 执行`, keep the execution button unchanged and add a separate menu item for prefill. Do not silently change `Agent 执行` semantics without product approval.

- [ ] **Step 2: Wire prefill action to UI**

Add an action trigger that calls:

```ts
controller.prefillAgentPrompt(provider);
```

Use the same provider dropdown component so the user can choose Codex or another provider if later allowed.

- [ ] **Step 3: Limit to Codex for V1 if required**

If V1 must only support Codex, filter provider options:

```ts
providerOptions.filter((option) => option.provider === "codex");
```

Show the existing no-provider disabled menu item if Codex is unavailable.

### Task 6: End-To-End Verification

**Files:**

- No production files unless a test exposes a bug.

- [ ] **Step 1: Run focused package tests**

Run:

```bash
pnpm --filter @tutti-os/agent-gui test -- workbench/launch.test.ts
pnpm --filter @tutti-os/agent-gui test -- agent-gui/agentGuiNode/controller/useAgentGUINodeController.spec.tsx
pnpm --filter @tutti-os/workspace-issue-manager test -- services/internal/controllerActions.test.ts
```

Expected: all pass.

- [ ] **Step 2: Run desktop adapter tests**

Run the existing desktop renderer test command used for feature tests. If the repository exposes a focused test target, run only:

```text
features/workspace-issue-manager/internal/adapters/desktopIssueManagerAgentRunner.test.ts
features/workspace-agent/ui/DesktopAgentGUIWorkbenchBody...
```

Expected: all pass.

- [ ] **Step 3: Manual verification in the app**

1. Open a workspace with no Codex node.
2. Trigger the issue-manager prefill action.
3. Confirm a Codex Agent GUI node opens.
4. Confirm the composer contains the generated prompt.
5. Confirm no agent run starts and no new session appears in the message center until the user sends.
6. Open a second Codex node if possible.
7. Trigger prefill again.
8. Confirm only the topmost reusable Codex dock node changes draft.
9. Confirm other Codex nodes do not change.

## Risks And Guardrails

- **Risk: accidentally starting a run.** Guard by keeping the prefill path away from `initialContent`, `activateSession(mode: "new")`, and `sendInput`.
- **Risk: multiple Codex nodes responding.** Guard by using Workbench node activation, not `window.dispatchEvent` or a global store broadcast.
- **Risk: prompt lands in an existing active conversation.** V1 should switch to home composer before writing the draft.
- **Risk: overwriting a user's draft.** V1 intentionally replaces the home draft for the selected provider. If this is not acceptable, add a confirmation or append behavior in a later product pass.
- **Risk: hidden unavailable Codex provider.** If Codex is disabled or not installed, reuse existing provider status options and show disabled reasons.

## Out Of Scope

- Choosing an exact Codex node among several open Codex nodes.
- Persisting prompt drafts across app restart.
- Starting a run automatically after prefill.
- Generalizing the feature to all providers unless product explicitly wants it.
- Changing existing `Agent 执行` semantics without visible copy or product sign-off.

## Success Criteria

- Triggering the new flow opens or reuses exactly one Codex node.
- If no Codex node exists, a new Codex node appears and receives the prompt.
- The prompt is visible in the composer.
- The user must manually send.
- No runtime agent session is created by prefill alone.
- Existing session launch and issue-manager execution flows still work unchanged.
