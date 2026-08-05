import { WorkspaceScopedRegistrationRegistry } from "./internal/workspaceScopedRegistrationRegistry.ts";

export interface WorkspaceBrowserOpenRequest {
  reuseIfOpen?: boolean;
  source?:
    | "agent_command"
    | "browser"
    | "file_manager"
    | "terminal"
    | "workspace_app";
  sourceNodeId?: string;
  url: string;
  workspaceId: string;
}

interface WorkspaceBrowserOpenLaunchRequest extends WorkspaceBrowserOpenRequest {
  kind: "open";
}

interface WorkspaceBrowserFocusRequest {
  kind: "focus";
  preferredNodeId?: string;
  workspaceId: string;
}

export type WorkspaceBrowserLaunchRequest =
  | WorkspaceBrowserFocusRequest
  | WorkspaceBrowserOpenLaunchRequest;

export type WorkspaceBrowserLaunchHandler = (
  request: WorkspaceBrowserLaunchRequest
) => Promise<string | null> | string | null;

const launchHandlers =
  new WorkspaceScopedRegistrationRegistry<WorkspaceBrowserLaunchHandler>();
const allowedBrowserLaunchProtocols = new Set(["http:", "https:"]);

export function registerWorkspaceBrowserLaunchHandler(
  workspaceId: string,
  handler: WorkspaceBrowserLaunchHandler
): () => void {
  return launchHandlers.register(workspaceId, handler);
}

export async function requestWorkspaceBrowserLaunch(
  request: WorkspaceBrowserOpenRequest
): Promise<boolean> {
  const normalizedWorkspaceId = request.workspaceId.trim();
  const normalizedUrl = normalizeWorkspaceBrowserLaunchUrl(request.url);
  if (!normalizedWorkspaceId || !normalizedUrl) {
    return false;
  }

  return Boolean(
    await dispatchWorkspaceBrowserLaunch({
      handler: launchHandlers.get(normalizedWorkspaceId),
      request: {
        kind: "open",
        reuseIfOpen: request.reuseIfOpen,
        ...(request.source ? { source: request.source } : {}),
        ...(request.sourceNodeId?.trim()
          ? { sourceNodeId: request.sourceNodeId.trim() }
          : {}),
        url: normalizedUrl,
        workspaceId: normalizedWorkspaceId
      }
    })
  );
}

export async function requestWorkspaceBrowserSurfaceFocus(request: {
  preferredNodeId?: string | null;
  workspaceId: string;
}): Promise<string | null> {
  const normalizedWorkspaceId = request.workspaceId.trim();
  if (!normalizedWorkspaceId) {
    return null;
  }

  const preferredNodeId = request.preferredNodeId?.trim() ?? "";
  const result = await dispatchWorkspaceBrowserLaunch({
    handler: launchHandlers.get(normalizedWorkspaceId),
    request: {
      kind: "focus",
      ...(preferredNodeId ? { preferredNodeId } : {}),
      workspaceId: normalizedWorkspaceId
    }
  });
  return typeof result === "string" && result.trim() ? result.trim() : null;
}

export async function requestWorkspaceBrowserHostFileLaunch(
  request: WorkspaceBrowserOpenRequest
): Promise<boolean> {
  const normalizedWorkspaceId = request.workspaceId.trim();
  const normalizedUrl = normalizeWorkspaceBrowserHostFileLaunchUrl(request.url);
  if (!normalizedWorkspaceId || !normalizedUrl) {
    return false;
  }

  return Boolean(
    await dispatchWorkspaceBrowserLaunch({
      handler: launchHandlers.get(normalizedWorkspaceId),
      request: {
        kind: "open",
        reuseIfOpen: request.reuseIfOpen,
        source: request.source ?? "file_manager",
        ...(request.sourceNodeId?.trim()
          ? { sourceNodeId: request.sourceNodeId.trim() }
          : {}),
        url: normalizedUrl,
        workspaceId: normalizedWorkspaceId
      }
    })
  );
}

function dispatchWorkspaceBrowserLaunch(input: {
  handler: WorkspaceBrowserLaunchHandler | undefined;
  request: WorkspaceBrowserLaunchRequest;
}): Promise<string | null> | string | null {
  if (!input.handler) {
    return null;
  }

  return input.handler(input.request);
}

function normalizeWorkspaceBrowserLaunchUrl(url: string): string | null {
  try {
    const parsed = new URL(url.trim());
    return allowedBrowserLaunchProtocols.has(parsed.protocol)
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}

function normalizeWorkspaceBrowserHostFileLaunchUrl(
  url: string
): string | null {
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol === "file:") {
      return parsed.toString();
    }
    return normalizeWorkspaceBrowserLaunchUrl(url);
  } catch {
    return null;
  }
}
