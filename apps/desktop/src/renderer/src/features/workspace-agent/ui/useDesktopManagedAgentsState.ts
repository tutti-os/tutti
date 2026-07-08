import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { AgentHostManagedAgentsState } from "@shared/contracts/dto";
import type {
  AgentProviderStatusSnapshot,
  IAgentProviderStatusService
} from "../services/agentProviderStatusService.interface";
import type { WorkspaceAgentProvider } from "@tutti-os/client-tuttid-ts";
import {
  ensureDesktopManagedAgentProviderStatuses,
  hasRequiredDesktopManagedAgentProviderStatuses,
  projectDesktopManagedAgentsStateForAgentGUI
} from "../services/internal/desktopManagedAgentProviders.ts";

const EMPTY_AGENT_PROVIDER_STATUS_SNAPSHOT: AgentProviderStatusSnapshot = {
  capturedAt: null,
  defaultProvider: null,
  error: null,
  isLoading: false,
  pendingActions: [],
  statuses: []
};

export function useDesktopManagedAgentsState(
  agentProviderStatusService: IAgentProviderStatusService | undefined,
  options?: {
    ensureLoaded?: boolean;
    requiredProviders?: readonly WorkspaceAgentProvider[];
  }
): AgentHostManagedAgentsState | null {
  const shouldEnsureLoaded = options?.ensureLoaded !== false;
  const requiredProviders = options?.requiredProviders;
  const snapshot = useSyncExternalStore(
    agentProviderStatusService
      ? (listener) => agentProviderStatusService.subscribe(listener)
      : noopSubscribe,
    agentProviderStatusService
      ? () => agentProviderStatusService.getSnapshot()
      : getEmptyAgentProviderStatusSnapshot,
    getEmptyAgentProviderStatusSnapshot
  );

  useEffect(() => {
    if (!agentProviderStatusService || !shouldEnsureLoaded) {
      return;
    }

    void ensureDesktopManagedAgentProviderStatuses(agentProviderStatusService);
  }, [agentProviderStatusService, shouldEnsureLoaded]);

  return useMemo(
    () =>
      agentProviderStatusService &&
      hasRequiredDesktopManagedAgentProviderStatuses(
        snapshot,
        requiredProviders
      )
        ? projectDesktopManagedAgentsStateForAgentGUI(snapshot)
        : null,
    [agentProviderStatusService, requiredProviders, snapshot]
  );
}

function getEmptyAgentProviderStatusSnapshot(): AgentProviderStatusSnapshot {
  return EMPTY_AGENT_PROVIDER_STATUS_SNAPSHOT;
}

function noopSubscribe(): () => void {
  return () => {};
}
