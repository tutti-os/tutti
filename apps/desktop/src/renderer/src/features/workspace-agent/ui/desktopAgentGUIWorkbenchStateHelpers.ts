import { type DesktopAgentGUIProvider } from "../desktopAgentGUINodeState.ts";

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
