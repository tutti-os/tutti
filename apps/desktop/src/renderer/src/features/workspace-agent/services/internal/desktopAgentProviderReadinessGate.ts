import type {
  AgentGUIProvider,
  AgentGUIAgentAvailabilityAction,
  AgentGUIProviderReadinessGate
} from "@tutti-os/agent-gui";
import type { WorkspaceAgentProvider } from "@tutti-os/client-tuttid-ts";
import type { AgentProviderStatusSnapshot } from "../agentProviderStatusService.interface";
import {
  desktopManagedAgentProviders,
  isDesktopManagedAgentProvider
} from "./desktopManagedAgentProviders.ts";

export type DesktopAgentProviderReadinessGateActionHandler = (
  provider: AgentGUIProvider,
  action: AgentGUIAgentAvailabilityAction
) => void;

export function projectDesktopAgentProviderReadinessGates(input: {
  onAction?: DesktopAgentProviderReadinessGateActionHandler;
  snapshot: AgentProviderStatusSnapshot;
}): Partial<Record<AgentGUIProvider, AgentGUIProviderReadinessGate | null>> {
  const statusByProvider = new Map(
    input.snapshot.statuses
      .filter((status) => isDesktopManagedAgentProvider(status.provider))
      .map((status) => [status.provider, status])
  );
  const gates: Partial<
    Record<AgentGUIProvider, AgentGUIProviderReadinessGate | null>
  > = {};

  for (const provider of desktopManagedAgentProviders) {
    const agentGuiProvider = provider as AgentGUIProvider;
    const gate = projectDesktopAgentProviderReadinessGate({
      hasError: Boolean(input.snapshot.error),
      isLoading: input.snapshot.isLoading,
      pendingActions: input.snapshot.pendingActions,
      provider,
      status: statusByProvider.get(provider) ?? null
    });
    gates[agentGuiProvider] = gate
      ? {
          ...gate,
          ...(input.onAction
            ? {
                onAction: (_provider, action) =>
                  input.onAction?.(agentGuiProvider, action)
              }
            : {})
        }
      : null;
  }

  return gates;
}

function projectDesktopAgentProviderReadinessGate(input: {
  hasError: boolean;
  isLoading: boolean;
  pendingActions: AgentProviderStatusSnapshot["pendingActions"];
  provider: WorkspaceAgentProvider;
  status: AgentProviderStatusSnapshot["statuses"][number] | null;
}): AgentGUIProviderReadinessGate | null {
  if (!input.status) {
    return {
      status: input.hasError && !input.isLoading ? "unavailable" : "checking",
      pendingAction: pendingActionForProvider(
        input.pendingActions,
        input.provider
      )
    };
  }

  switch (input.status.availability.status) {
    case "ready":
      return null;
    case "not_installed":
      return {
        status: "not_installed",
        pendingAction: pendingActionForProvider(
          input.pendingActions,
          input.provider
        )
      };
    case "auth_required":
      return {
        status: "auth_required",
        pendingAction: pendingActionForProvider(
          input.pendingActions,
          input.provider
        )
      };
    case "unsupported":
    case "unknown":
      return {
        status: "unavailable",
        pendingAction: pendingActionForProvider(
          input.pendingActions,
          input.provider
        )
      };
  }
}

function pendingActionForProvider(
  pendingActions: AgentProviderStatusSnapshot["pendingActions"],
  provider: WorkspaceAgentProvider
): AgentGUIAgentAvailabilityAction | null {
  const pendingAction = pendingActions.find(
    (action) => action.provider === provider
  )?.actionId;
  switch (pendingAction) {
    case "install":
    case "login":
    case "refresh":
      return pendingAction;
    default:
      return null;
  }
}
