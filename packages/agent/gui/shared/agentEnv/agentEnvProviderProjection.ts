import type {
  AgentProviderAction,
  AgentProviderActionId,
  AgentProviderStatus,
  WorkspaceAgentProvider
} from "@tutti-os/client-tuttid-ts";

export type AgentEnvProviderStatusKind =
  | "auth_required"
  | "available"
  | "checking"
  | "connected"
  | "unknown"
  | "unsupported";

export type AgentEnvProviderPrimaryAction = Extract<
  AgentProviderActionId,
  "install" | "login"
>;

export interface AgentEnvProviderProjection {
  actionIds: AgentProviderActionId[];
  configDetected: boolean;
  pending: boolean;
  primaryActionId: AgentEnvProviderPrimaryAction | null;
  provider: WorkspaceAgentProvider;
  status: AgentEnvProviderStatusKind;
}

export function projectAgentEnvProvider(input: {
  isLoading: boolean;
  pendingActionIds?: ReadonlySet<string>;
  provider: WorkspaceAgentProvider;
  status: AgentProviderStatus | null;
}): AgentEnvProviderProjection {
  const status = resolveAgentEnvProviderStatus(input.status, input.isLoading);
  const actionIds = resolveAgentEnvProviderActionIds(input.status, status);
  const primaryActionId = resolveAgentEnvProviderPrimaryAction(actionIds);

  return {
    actionIds,
    configDetected: input.status?.adapter.installed ?? false,
    pending:
      primaryActionId !== null &&
      input.pendingActionIds?.has(primaryActionId) === true,
    primaryActionId,
    provider: input.provider,
    status
  };
}

export function resolveAgentEnvProviderStatus(
  status: AgentProviderStatus | null,
  isLoading: boolean
): AgentEnvProviderStatusKind {
  if (!status) {
    return isLoading ? "checking" : "unknown";
  }

  switch (status.availability.status) {
    case "ready":
      return "connected";
    case "not_installed":
      return "available";
    case "auth_required":
      return "auth_required";
    case "unsupported":
      return "unsupported";
    case "unknown":
      return "unknown";
  }
}

function resolveAgentEnvProviderActionIds(
  providerStatus: AgentProviderStatus | null,
  status: AgentEnvProviderStatusKind
): AgentProviderActionId[] {
  if (!providerStatus || status === "connected" || status === "unsupported") {
    return [];
  }

  const allowed =
    status === "available"
      ? new Set<AgentProviderAction["id"]>(["install", "refresh"])
      : status === "auth_required"
        ? new Set<AgentProviderAction["id"]>(["login", "refresh"])
        : null;

  return providerStatus.actions
    .filter((action) => allowed?.has(action.id) ?? true)
    .map((action) => action.id);
}

function resolveAgentEnvProviderPrimaryAction(
  actionIds: readonly AgentProviderActionId[]
): AgentEnvProviderPrimaryAction | null {
  if (actionIds.includes("install")) {
    return "install";
  }
  if (actionIds.includes("login")) {
    return "login";
  }
  return null;
}
