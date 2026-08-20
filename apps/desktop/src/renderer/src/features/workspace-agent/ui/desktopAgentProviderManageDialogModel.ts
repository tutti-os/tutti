import type {
  AgentProviderActionId,
  AgentProviderStatus,
  WorkspaceAgentProvider
} from "@tutti-os/client-tuttid-ts";
import type { AgentProviderStatusPendingAction } from "../services/agentProviderStatusService.interface";
import { desktopManagedAgentProviders } from "../services/internal/desktopManagedAgentProviders.ts";

export const desktopAgentProviderManageDialogProviders = [
  ...desktopManagedAgentProviders
] as const satisfies readonly WorkspaceAgentProvider[];

export type DesktopAgentProviderManageRowStatus =
  | "auth_required"
  | "available"
  | "checking"
  | "configured"
  | "connected"
  | "temporarily_unsupported"
  | "unknown"
  | "unsupported";

export type DesktopAgentProviderManageRowAction = Extract<
  AgentProviderActionId,
  "install" | "login"
>;

export interface DesktopAgentProviderManageRow {
  actionDisabled: boolean;
  configDetected: boolean;
  pending: boolean;
  primaryActionId: DesktopAgentProviderManageRowAction | null;
  provider: (typeof desktopAgentProviderManageDialogProviders)[number];
  // True when the provider is blocked purely because several working local
  // runtimes were found and the user must choose one. It stays additive to the
  // status enum so callers that do not care keep treating the row as "unknown".
  runtimeSelectionRequired: boolean;
  status: DesktopAgentProviderManageRowStatus;
}

export function canConfigureDesktopAgentProvider(
  status: DesktopAgentProviderManageRowStatus
): boolean {
  return status !== "temporarily_unsupported";
}

// The daemon reports availability "unknown" with one of these reason codes when
// it refuses to auto-pick between multiple healthy Codex installations.
const runtimeSelectionReasonCodes = new Set<string>([
  "codex_runtime_selection_required",
  "codex_runtime_selection_stale"
]);

export function projectDesktopAgentProviderManageRows(input: {
  isLoading: boolean;
  pendingActions: readonly AgentProviderStatusPendingAction[];
  statuses: readonly AgentProviderStatus[];
}): DesktopAgentProviderManageRow[] {
  const statusByProvider = new Map<WorkspaceAgentProvider, AgentProviderStatus>(
    input.statuses.map((status) => [status.provider, status])
  );

  return desktopAgentProviderManageDialogProviders.map((provider) =>
    projectDesktopAgentProviderManageRow({
      isLoading: input.isLoading,
      pendingActions: input.pendingActions,
      provider,
      status: statusByProvider.get(provider) ?? null
    })
  );
}

export function projectDesktopAgentProviderManageRow(input: {
  isLoading: boolean;
  pendingActions: readonly AgentProviderStatusPendingAction[];
  provider: (typeof desktopAgentProviderManageDialogProviders)[number];
  status: AgentProviderStatus | null;
}): DesktopAgentProviderManageRow {
  const status = resolveDesktopAgentProviderManageRowStatus(
    input.status,
    input.isLoading
  );
  const primaryActionId = resolveDesktopAgentProviderManageRowAction(
    input.status
  );
  const pending =
    primaryActionId !== null &&
    input.pendingActions.some(
      (action) =>
        action.provider === input.provider &&
        action.actionId === primaryActionId
    );

  return {
    actionDisabled: primaryActionId === null || pending,
    configDetected: input.status?.adapter.installed ?? false,
    pending,
    primaryActionId,
    provider: input.provider,
    runtimeSelectionRequired: resolveRuntimeSelectionRequired(input.status),
    status
  };
}

function resolveRuntimeSelectionRequired(
  status: AgentProviderStatus | null
): boolean {
  return (
    status?.availability.status === "unknown" &&
    runtimeSelectionReasonCodes.has(status.availability.reasonCode ?? "")
  );
}

function resolveDesktopAgentProviderManageRowStatus(
  status: AgentProviderStatus | null,
  isLoading: boolean
): DesktopAgentProviderManageRowStatus {
  if (!status) {
    return isLoading ? "checking" : "unknown";
  }

  switch (status.availability.status) {
    case "ready":
      return status.auth.status === "configured" ? "configured" : "connected";
    case "not_installed":
      return "available";
    case "auth_required":
      return "auth_required";
    case "unsupported":
      return status.availability.reasonCode ===
        "provider_temporarily_unsupported"
        ? "temporarily_unsupported"
        : "unsupported";
    case "unknown":
      return "unknown";
  }
}

function resolveDesktopAgentProviderManageRowAction(
  status: AgentProviderStatus | null
): DesktopAgentProviderManageRowAction | null {
  if (!status) {
    return null;
  }

  if (status.availability.status === "not_installed") {
    return status.actions.some((action) => action.id === "install")
      ? "install"
      : null;
  }

  if (status.availability.status === "auth_required") {
    return status.actions.some((action) => action.id === "login")
      ? "login"
      : null;
  }

  return null;
}
