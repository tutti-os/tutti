export interface WorkspaceTerminalLoginLaunchRequest {
  command: string;
  cwd?: string;
  workspaceId: string;
}

export interface WorkspaceTerminalLoginLaunchHandle {
  close(): void;
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
