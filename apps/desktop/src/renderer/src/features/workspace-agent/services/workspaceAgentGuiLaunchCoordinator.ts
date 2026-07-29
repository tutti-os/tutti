import type { DesktopAgentGUIProvider } from "../desktopAgentGUINodeState.ts";

export interface WorkspaceAgentGuiLaunchRequest {
  agentSessionId?: string;
  agentTargetId?: string | null;
  autoSubmit?: boolean;
  draftPrompt?: string;
  model?: string | null;
  modelPlanId?: string | null;
  openInNewWindow?: boolean;
  provider?: DesktopAgentGUIProvider | null;
  userProjectPath?: string | null;
  workspaceId: string;
}

export type WorkspaceAgentGuiLaunchHandler = (
  request: WorkspaceAgentGuiLaunchRequest
) => Promise<void> | void;

const launchHandlersByWorkspaceId = new Map<
  string,
  WorkspaceAgentGuiLaunchHandler
>();

export function registerWorkspaceAgentGuiLaunchHandler(
  workspaceId: string,
  handler: WorkspaceAgentGuiLaunchHandler
): () => void {
  const normalizedWorkspaceId = workspaceId.trim();
  if (!normalizedWorkspaceId) {
    return noop;
  }

  launchHandlersByWorkspaceId.set(normalizedWorkspaceId, handler);
  return () => {
    if (launchHandlersByWorkspaceId.get(normalizedWorkspaceId) === handler) {
      launchHandlersByWorkspaceId.delete(normalizedWorkspaceId);
    }
  };
}

export async function requestWorkspaceAgentGuiLaunch(
  request: WorkspaceAgentGuiLaunchRequest
): Promise<boolean> {
  const handler = launchHandlersByWorkspaceId.get(request.workspaceId.trim());
  if (!handler) {
    return false;
  }

  await handler(request);
  return true;
}

function noop(): void {}
