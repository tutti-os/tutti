import type { WorkspaceAgentProvider } from "@tutti-os/client-tuttid-ts";
import { normalizeDesktopAgentGUIProvider } from "../../workspace-agent/desktopAgentGUINodeState.ts";
import { createWorkspaceAgentGuiSessionLaunchRequest } from "./workspaceAgentGuiLaunch.ts";

interface WorkspaceAgentGuiShortcutNode {
  data: {
    instanceId: string;
    runtimeNodeState?: unknown;
    snapshotNodeState?: unknown;
  };
}

export function resolveWorkspaceAgentGuiNodeProvider(
  node: WorkspaceAgentGuiShortcutNode,
  fallback: WorkspaceAgentProvider
): WorkspaceAgentProvider {
  return (
    workspaceAgentGuiProviderFromState(node.data.snapshotNodeState) ??
    workspaceAgentGuiProviderFromState(node.data.runtimeNodeState) ??
    fallback
  );
}

export function resolveWorkspaceAgentGuiNodeAgentTargetId(
  node: WorkspaceAgentGuiShortcutNode
): string | null {
  return (
    workspaceAgentGuiAgentTargetIdFromState(node.data.runtimeNodeState) ??
    workspaceAgentGuiAgentTargetIdFromState(node.data.snapshotNodeState)
  );
}

export function createWorkspaceAgentGuiSameTypeWindowLaunchRequest(
  node: WorkspaceAgentGuiShortcutNode,
  fallback: WorkspaceAgentProvider
) {
  return createWorkspaceAgentGuiSessionLaunchRequest({
    agentTargetId: resolveWorkspaceAgentGuiNodeAgentTargetId(node),
    openInNewWindow: true,
    provider: resolveWorkspaceAgentGuiNodeProvider(node, fallback)
  });
}

function workspaceAgentGuiProviderFromState(
  state: unknown
): WorkspaceAgentProvider | null {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    return null;
  }
  const provider = (state as { provider?: unknown }).provider;
  return typeof provider === "string"
    ? normalizeDesktopAgentGUIProvider(provider)
    : null;
}

function workspaceAgentGuiAgentTargetIdFromState(
  state: unknown
): string | null {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    return null;
  }
  const agentTargetId = (state as { agentTargetId?: unknown }).agentTargetId;
  return typeof agentTargetId === "string" && agentTargetId.trim()
    ? agentTargetId.trim()
    : null;
}
