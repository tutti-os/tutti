import type { WorkspaceLinkAction } from "@contexts/workspace/presentation/renderer/actions/workspaceLinkActions";
import { normalizeDesktopAgentGUIProvider } from "../desktopAgentGUINodeState.ts";
import type { DesktopAgentGUIProvider } from "../desktopAgentGUINodeState.ts";

export interface DesktopAgentGUILinkActionDependencies {
  homeDirectory?: string | null;
  launchAgentGui(input: {
    agentSessionId: string;
    provider: DesktopAgentGUIProvider;
    workspaceId: string;
  }): Promise<boolean> | boolean;
  launchWorkspaceIssueManager(input: {
    issueId?: string | null;
    mode?: "breakdown" | "execute";
    outputDir?: string | null;
    runId?: string | null;
    taskId?: string | null;
    topicId?: string | null;
    workspaceId: string;
  }): Promise<boolean> | boolean;
  launchWorkspaceFiles(input: {
    homeDirectory?: string | null;
    mode?: "reveal" | "open-directory";
    path: string;
    source?: "agent_command";
    validateExists?: boolean;
    workspaceId: string;
  }): Promise<boolean> | boolean;
  launchWorkspaceApp?: (input: {
    appId: string;
    workspaceId: string;
  }) => Promise<boolean> | boolean;
  launchGroupChat?: (input: {
    conversationId?: string | null;
    messageId?: string | null;
    summaryTaskId?: string | null;
    workspaceId: string;
  }) => Promise<boolean> | boolean;
  openBrowserUrl(input: {
    reuseIfOpen?: boolean;
    source?: "agent_command";
    url: string;
    workspaceId: string;
  }): Promise<boolean> | boolean;
  workspaceId: string;
}

const issueManagerWorkspaceAppId = "issue-manager";
const groupChatWorkspaceAppId = "group-chat";

export async function runDesktopAgentGUILinkAction(
  action: WorkspaceLinkAction,
  dependencies: DesktopAgentGUILinkActionDependencies
): Promise<boolean> {
  switch (action.type) {
    case "open-workspace-file":
      return dependencies.launchWorkspaceFiles({
        homeDirectory: dependencies.homeDirectory,
        ...(action.mode ? { mode: action.mode } : {}),
        path: action.path,
        source: "agent_command",
        validateExists: true,
        workspaceId: dependencies.workspaceId
      });
    case "open-local-asset-preview":
      return dependencies.launchWorkspaceFiles({
        homeDirectory: dependencies.homeDirectory,
        path: action.path,
        source: "agent_command",
        workspaceId: dependencies.workspaceId
      });
    case "open-url":
      return dependencies.openBrowserUrl({
        reuseIfOpen: false,
        source: "agent_command",
        url: action.url,
        workspaceId: dependencies.workspaceId
      });
    case "open-agent-session":
      if (action.workspaceId !== dependencies.workspaceId) {
        return false;
      }
      return dependencies.launchAgentGui({
        agentSessionId: action.agentSessionId,
        provider: normalizeDesktopAgentGUIProvider(action.provider),
        workspaceId: dependencies.workspaceId
      });
    case "open-workspace-issue": {
      if (action.workspaceId !== dependencies.workspaceId) {
        return false;
      }
      if (!action.issueId?.trim()) {
        return false;
      }
      const mode = resolveWorkspaceIssueLaunchMode(action.mode);
      return dependencies.launchWorkspaceIssueManager({
        issueId: action.issueId,
        ...(mode ? { mode } : {}),
        ...(action.outputDir ? { outputDir: action.outputDir } : {}),
        ...(action.runId ? { runId: action.runId } : {}),
        ...(action.taskId ? { taskId: action.taskId } : {}),
        ...(action.topicId ? { topicId: action.topicId } : {}),
        workspaceId: dependencies.workspaceId
      });
    }
    case "open-workspace-app": {
      if (action.workspaceId !== dependencies.workspaceId) {
        return false;
      }
      const appId = action.appId.trim();
      if (!appId) {
        return false;
      }
      if (appId === issueManagerWorkspaceAppId) {
        return dependencies.launchWorkspaceIssueManager({
          workspaceId: dependencies.workspaceId
        });
      }
      if (
        appId === groupChatWorkspaceAppId &&
        dependencies.launchGroupChat &&
        (action.messageId || action.summaryTaskId)
      ) {
        return dependencies.launchGroupChat({
          workspaceId: dependencies.workspaceId,
          ...(action.messageId ? { messageId: action.messageId } : {}),
          ...(action.summaryTaskId
            ? { summaryTaskId: action.summaryTaskId }
            : {}),
          ...(action.conversationId
            ? { conversationId: action.conversationId }
            : {})
        });
      }
      if (!dependencies.launchWorkspaceApp) {
        return false;
      }
      return dependencies.launchWorkspaceApp({
        appId,
        workspaceId: dependencies.workspaceId
      });
    }
  }
}

type WorkspaceIssueManagerLaunchInput = Parameters<
  DesktopAgentGUILinkActionDependencies["launchWorkspaceIssueManager"]
>[0];

function resolveWorkspaceIssueLaunchMode(
  value: unknown
): WorkspaceIssueManagerLaunchInput["mode"] {
  return value === "breakdown" || value === "execute" ? value : undefined;
}
