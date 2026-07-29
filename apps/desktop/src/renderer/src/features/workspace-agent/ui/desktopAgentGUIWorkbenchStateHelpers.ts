import { type DesktopAgentGUIProvider } from "../desktopAgentGUINodeState.ts";
import type {
  AgentProviderStatus,
  WorkspaceAgentProvider
} from "@tutti-os/client-tuttid-ts";

export function resolveDesktopAgentGUIProviderAuthAccountLabels(
  statuses: readonly AgentProviderStatus[]
): Partial<Record<WorkspaceAgentProvider, string>> {
  const labels: Partial<Record<WorkspaceAgentProvider, string>> = {};
  for (const status of statuses) {
    const accountLabel = status.auth.accountLabel?.trim();
    if (accountLabel) labels[status.provider] = accountLabel;
  }
  return labels;
}

export function resolveDesktopAgentGUIProviderForAgentTarget(
  agentTargetId: string | null,
  agents:
    | readonly {
        agentTargetId: string;
        provider: DesktopAgentGUIProvider;
      }[]
    | undefined,
  fallbackProvider: DesktopAgentGUIProvider
): DesktopAgentGUIProvider {
  if (!agentTargetId) {
    return fallbackProvider;
  }
  const target = agents?.find(
    (candidate) => candidate.agentTargetId === agentTargetId
  );
  if (target) {
    return target.provider;
  }
  return fallbackProvider;
}

export function hasDesktopAgentGUIConversationRailCollapsedState(
  value: unknown
): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { conversationRailCollapsed?: unknown })
      .conversationRailCollapsed === "boolean"
  );
}
