import type {
  AgentGUIProvider,
  AgentGUIProviderReadinessGate,
  AgentGUIProviderReadinessGateAction
} from "@tutti-os/agent-gui";
import type { WorkspaceAgentProvider } from "@tutti-os/client-tuttid-ts";
import type { AgentProviderStatusSnapshot } from "../agentProviderStatusService.interface";
import {
  desktopManagedAgentProviders,
  isDesktopManagedAgentProvider
} from "./desktopManagedAgentProviders.ts";

export type DesktopAgentProviderReadinessGateActionHandler = (
  provider: AgentGUIProvider,
  action: AgentGUIProviderReadinessGateAction
) => void;

export function projectDesktopAgentProviderReadinessGates(input: {
  snapshot: AgentProviderStatusSnapshot;
  onAction?: DesktopAgentProviderReadinessGateActionHandler;
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
    gates[agentGuiProvider] = projectDesktopAgentProviderReadinessGate({
      captured: Boolean(input.snapshot.capturedAt),
      hasError: Boolean(input.snapshot.error),
      isLoading: input.snapshot.isLoading,
      onAction: input.onAction,
      pendingActions: input.snapshot.pendingActions,
      provider,
      status: statusByProvider.get(provider) ?? null
    });
  }

  return gates;
}

function projectDesktopAgentProviderReadinessGate(input: {
  captured: boolean;
  hasError: boolean;
  isLoading: boolean;
  onAction?: DesktopAgentProviderReadinessGateActionHandler;
  pendingActions: AgentProviderStatusSnapshot["pendingActions"];
  provider: WorkspaceAgentProvider;
  status: AgentProviderStatusSnapshot["statuses"][number] | null;
}): AgentGUIProviderReadinessGate | null {
  if (!input.status) {
    return {
      status:
        input.isLoading || (!input.captured && !input.hasError)
          ? "checking"
          : "unavailable",
      pendingAction: pendingActionForProvider(
        input.pendingActions,
        input.provider
      ),
      onAction: input.onAction
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
        ),
        onAction: input.onAction
      };
    case "auth_required":
      return {
        status: "auth_required",
        pendingAction: pendingActionForProvider(
          input.pendingActions,
          input.provider
        ),
        onAction: input.onAction
      };
    case "unsupported":
    case "unknown":
      return {
        status: "unavailable",
        pendingAction: pendingActionForProvider(
          input.pendingActions,
          input.provider
        ),
        onAction: input.onAction
      };
  }
}

function pendingActionForProvider(
  pendingActions: AgentProviderStatusSnapshot["pendingActions"],
  provider: WorkspaceAgentProvider
): AgentGUIProviderReadinessGateAction | null {
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
