import type { WorkspaceAgentProvider } from "@tutti-os/client-tuttid-ts";
import {
  selectFocusedWorkbenchNode,
  type WorkbenchHostHandle
} from "@tutti-os/workbench-surface";
import {
  AGENT_GUI_WORKBENCH_NEW_CONVERSATION_EVENT,
  type AgentGuiWorkbenchNewConversationDetail
} from "@tutti-os/agent-gui/workbench/contribution";
import { requestWorkspaceAgentGuiLaunch } from "@renderer/features/workspace-agent/services/workspaceAgentGuiLaunchCoordinator.ts";
import { normalizeDesktopAgentGUIProvider } from "@renderer/features/workspace-agent/desktopAgentGUINodeState";
import {
  createWorkspaceAgentGuiSessionLaunchRequest,
  workspaceAgentGuiNodeID,
  workspaceAgentGuiProviderFromIdentifier
} from "./workspaceAgentGuiLaunch.ts";

type WorkspaceWorkbenchNode = ReturnType<
  WorkbenchHostHandle["getSnapshot"]
>["nodes"][number];

export function resolveActiveWorkspaceWorkbenchNode(
  host: WorkbenchHostHandle
): WorkspaceWorkbenchNode | null {
  return selectFocusedWorkbenchNode(host.getSnapshot());
}

export function isWorkspaceAgentGuiWorkbenchNode(
  node: WorkspaceWorkbenchNode
): boolean {
  return (
    node.data.typeId === workspaceAgentGuiNodeID ||
    workspaceAgentGuiProviderFromIdentifier(node.data.instanceId) !== null ||
    workspaceAgentGuiProviderFromIdentifier(node.data.dockEntryId ?? "") !==
      null
  );
}

export function resolveWorkspaceAgentGuiNodeProvider(
  node: WorkspaceWorkbenchNode,
  fallback: WorkspaceAgentProvider
): WorkspaceAgentProvider {
  return (
    workspaceAgentGuiProviderFromIdentifier(node.data.instanceId) ??
    workspaceAgentGuiProviderFromIdentifier(node.data.dockEntryId ?? "") ??
    workspaceAgentGuiProviderFromIdentifier(node.data.typeId) ??
    workspaceAgentGuiProviderFromState(node.data.snapshotNodeState) ??
    workspaceAgentGuiProviderFromState(node.data.runtimeNodeState) ??
    fallback
  );
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

export async function openWorkspaceWorkbenchAgentConversationShortcut(input: {
  defaultProvider: WorkspaceAgentProvider;
  host: WorkbenchHostHandle;
  workspaceId: string;
}): Promise<void> {
  const activeNode = resolveActiveWorkspaceWorkbenchNode(input.host);
  if (activeNode && isWorkspaceAgentGuiWorkbenchNode(activeNode)) {
    input.host.focusNode(activeNode.id);
    window.dispatchEvent(
      new CustomEvent<AgentGuiWorkbenchNewConversationDetail>(
        AGENT_GUI_WORKBENCH_NEW_CONVERSATION_EVENT,
        {
          detail: {
            instanceId: activeNode.data.instanceId
          }
        }
      )
    );
    return;
  }
  await requestWorkspaceAgentGuiLaunch({
    provider: input.defaultProvider,
    workspaceId: input.workspaceId
  });
}

export async function openWorkspaceWorkbenchSameTypeWindowShortcut(input: {
  defaultProvider: WorkspaceAgentProvider;
  host: WorkbenchHostHandle;
}): Promise<void> {
  const activeNode = resolveActiveWorkspaceWorkbenchNode(input.host);
  if (!activeNode) {
    return;
  }
  if (isWorkspaceAgentGuiWorkbenchNode(activeNode)) {
    await input.host.launchNode(
      createWorkspaceAgentGuiSessionLaunchRequest({
        openInNewWindow: true,
        provider: resolveWorkspaceAgentGuiNodeProvider(
          activeNode,
          input.defaultProvider
        )
      })
    );
    return;
  }
  await input.host.launchNode({
    ...(activeNode.data.dockEntryId
      ? { dockEntryId: activeNode.data.dockEntryId }
      : {}),
    payload: activeNode.data.snapshotNodeState,
    reason: "host",
    typeId: activeNode.data.typeId
  });
}
