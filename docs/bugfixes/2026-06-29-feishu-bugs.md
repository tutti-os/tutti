# 2026-06-29 Feishu Bug Records

## EbVfrVlvYelOPBc6OMUcjiSTnZb - task run latest status opens missing session

- Link: https://ccn53rwonxso.feishu.cn/record/EbVfrVlvYelOPBc6OMUcjiSTnZb
- Base record id: `recvnVhs7OCDlc`
- Bug: 任务中心的最新执行状态关联不对，点击打开会话显示会话不存在，但实际会话存在。
- Evidence: Feishu attachments show task `新建ppt和文档` failed in Task Center, while clicking the latest execution status opens a toast saying the Agent session no longer exists. The attached log bundle contains the real Claude Code session `737f3449-4a14-422f-92fe-2ee04534877c` for `请处理这个任务引用。 @新建ppt和文档` and a related Codex session `8f933226-c3cd-493c-82b4-299fffd4a5ed`.
- Cause: The issue-manager runner generated a prospective `agentSessionId` for the task run, but the desktop Agent GUI draft launch did not carry that id through the workspace launch and prefill activation path. When the user submitted the draft, Agent GUI created or used another session id, leaving the task run's latest status pointing at a missing/stale session.
- Fix: Preserve `agentSessionId` through the issue-manager runner, Agent GUI workbench draft launch payload, desktop prefill activation resolver, workspace workbench launch handling, and the next `mode: "new"` Agent GUI activation.
- Verification:
  - `corepack pnpm --filter @tutti-os/agent-gui exec vitest run --environment jsdom workbench/launch.test.ts`
  - `corepack pnpm --filter @tutti-os/agent-gui exec vitest run --environment jsdom agent-gui/agentGuiNode/controller/useAgentGUINodeController.spec.tsx -t 'uses prefilled agent session ids for the next draft submission'`
  - `corepack pnpm --filter @tutti-os/desktop test -- src/renderer/src/features/workspace-agent/services/desktopAgentGUIPrefillPromptActivation.test.ts src/renderer/src/features/workspace-issue-manager/internal/adapters/desktopIssueManagerAgentRunner.test.ts src/renderer/src/features/workspace-workbench/services/internal/workspaceWorkbenchComposition.test.ts`
  - `corepack pnpm --filter @tutti-os/agent-gui exec vitest run --environment jsdom workbench/launch.test.ts agent-gui/agentGuiNode/controller/useAgentGUINodeController.spec.tsx -t 'uses prefilled agent session ids for the next draft submission|agent gui workbench launch contract'`
  - `corepack pnpm --filter @tutti-os/agent-gui typecheck`
  - `corepack pnpm --filter @tutti-os/desktop typecheck`
- Status: fixed locally
- Commit: pending
- Feishu status update: pending
