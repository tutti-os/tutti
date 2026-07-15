import type {
  AgentGUIProvider,
  AgentGUIProviderReadinessGate,
  AgentGUIProviderReadinessGateAction
} from "../../../types";

export interface AgentGUIProviderReadinessLabels {
  providerGateCheckingTitle: string;
  providerGateCheckingDescription: string;
  providerGateCheckingAgentsDescription: string;
  providerGateInstallTitle: string;
  providerGateInstallDescription: string;
  providerGateInstallAction: string;
  providerGateLoginTitle: string;
  providerGateLoginDescription: string;
  providerGateLoginAction: string;
  providerGateComingSoonTitle: string;
  providerGateComingSoonDescription: string;
  providerGateComingSoonAction: string;
  providerGateUnavailableTitle: string;
  providerGateUnavailableDescription: string;
  providerGateRetryAction: string;
}

export function resolveAgentGUIProviderReadinessGateForView(input: {
  activeConversationId: string | null;
  providerReadinessGates:
    | Partial<Record<AgentGUIProvider, AgentGUIProviderReadinessGate | null>>
    | null
    | undefined;
  selectedProvider: AgentGUIProvider;
}): AgentGUIProviderReadinessGate | null {
  if (input.activeConversationId !== null) {
    return null;
  }
  return input.providerReadinessGates?.[input.selectedProvider] ?? null;
}

export function isAgentGUIProviderReady(
  gate: AgentGUIProviderReadinessGate | null
): boolean {
  return gate === null;
}

export function resolveAgentGUIProviderReadinessContent(
  status: AgentGUIProviderReadinessGate["status"],
  labels: AgentGUIProviderReadinessLabels,
  options: { showAllProviders?: boolean } = {}
): { title: string; description: string; actionLabel?: string } {
  switch (status) {
    case "checking":
      return {
        title: labels.providerGateCheckingTitle,
        description:
          options.showAllProviders === true
            ? labels.providerGateCheckingAgentsDescription
            : labels.providerGateCheckingDescription
      };
    case "not_installed":
      return {
        title: labels.providerGateInstallTitle,
        description: labels.providerGateInstallDescription,
        actionLabel: labels.providerGateInstallAction
      };
    case "auth_required":
      return {
        title: labels.providerGateLoginTitle,
        description: labels.providerGateLoginDescription,
        actionLabel: labels.providerGateLoginAction
      };
    case "coming_soon":
      return {
        title: labels.providerGateComingSoonTitle,
        description: labels.providerGateComingSoonDescription,
        actionLabel: labels.providerGateComingSoonAction
      };
    case "unavailable":
      return {
        title: labels.providerGateUnavailableTitle,
        description: labels.providerGateUnavailableDescription,
        actionLabel: labels.providerGateRetryAction
      };
  }
}

export function resolveAgentGUIProviderReadinessAction(
  status: AgentGUIProviderReadinessGate["status"]
): AgentGUIProviderReadinessGateAction | null {
  switch (status) {
    case "not_installed":
      return "install";
    case "auth_required":
      return "login";
    case "unavailable":
      return "refresh";
    case "coming_soon":
    case "checking":
      return null;
  }
}
