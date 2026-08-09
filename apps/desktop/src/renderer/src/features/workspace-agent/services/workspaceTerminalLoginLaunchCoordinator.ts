import type { AgentHostTerminalStartupAction } from "@tutti-os/agent-gui";

export interface WorkspaceTerminalLoginLaunchRequest {
  command: string;
  cwd?: string;
  startupAction?: AgentHostTerminalStartupAction;
  workspaceId: string;
}

export type WorkspaceTerminalLoginStartupResult =
  | "cancelled"
  | "not_required"
  | "submitted"
  | "timed_out"
  | "write_failed";

export interface WorkspaceTerminalLoginLaunchHandle {
  close(): void;
  startupCompletion: Promise<WorkspaceTerminalLoginStartupResult>;
}

export type WorkspaceTerminalLoginLaunchHandler = (
  request: WorkspaceTerminalLoginLaunchRequest
) => Promise<WorkspaceTerminalLoginLaunchHandle | void>;

const launchHandlersByWorkspaceId = new Map<
  string,
  WorkspaceTerminalLoginLaunchHandler
>();

export function registerWorkspaceTerminalLoginLaunchHandler(
  workspaceId: string,
  handler: WorkspaceTerminalLoginLaunchHandler
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

export async function requestWorkspaceTerminalLoginLaunch(
  request: WorkspaceTerminalLoginLaunchRequest
): Promise<WorkspaceTerminalLoginLaunchHandle | null> {
  const handler = launchHandlersByWorkspaceId.get(request.workspaceId.trim());
  if (!handler) {
    return null;
  }

  return (await handler(request)) ?? null;
}

function noop(): void {}
