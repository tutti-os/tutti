import type {
  AgentProviderActionId,
  AgentProviderStatus,
  WorkspaceAgentProvider
} from "@tutti-os/client-tuttid-ts";
import { projectAgentEnvProvider } from "@tutti-os/agent-gui/agent-env";
import type { WorkbenchHostDockEntry } from "@tutti-os/workbench-surface";

export interface WorkspaceAgentProviderDockStatusCopy {
  checking: string;
  install: string;
  installing: string;
  installRequired: string;
  login: string;
  loginRequired: string;
  refresh: string;
  unsupported: string;
  unknown: string;
}

export function resolveAgentProviderDockStatusProps(input: {
  copy: WorkspaceAgentProviderDockStatusCopy;
  isLoading: boolean;
  order?: number;
  pendingActionIds?: ReadonlySet<string>;
  provider: WorkspaceAgentProvider;
  status: AgentProviderStatus | null;
}): Pick<WorkbenchHostDockEntry, "hoverActions" | "order" | "state"> {
  const projection = projectAgentEnvProvider({
    isLoading: input.isLoading,
    pendingActionIds: input.pendingActionIds,
    provider: input.provider,
    status: input.status
  });

  switch (projection.status) {
    case "checking":
      return {
        ...dockOrderProp(input.order),
        state: {
          kind: "loading",
          reason: input.copy.checking
        }
      };
    case "connected":
      return {
        ...dockOrderProp(input.order),
        state: {
          kind: "enabled"
        }
      };
    case "available":
      const isInstallPending = input.pendingActionIds?.has("install") === true;
      return {
        hoverActions: agentProviderDockActions(
          projection.actionIds,
          input.copy,
          input.pendingActionIds
        ),
        ...dockOrderProp(input.order),
        state: {
          kind: isInstallPending ? "loading" : "disabled",
          reason: isInstallPending
            ? input.copy.installing
            : input.copy.installRequired
        }
      };
    case "auth_required":
      const isLoginPending = input.pendingActionIds?.has("login") === true;
      return {
        hoverActions: agentProviderDockActions(
          projection.actionIds,
          input.copy,
          input.pendingActionIds
        ),
        ...dockOrderProp(input.order),
        state: {
          kind: isLoginPending ? "loading" : "disabled",
          reason: isLoginPending
            ? input.copy.installing
            : input.copy.loginRequired
        }
      };
    case "unsupported":
      return {
        ...dockOrderProp(input.order),
        state: {
          kind: "unavailable",
          reason: input.copy.unsupported
        }
      };
    case "unknown":
      return {
        hoverActions: agentProviderDockActions(
          projection.actionIds.length > 0
            ? projection.actionIds
            : (["refresh"] satisfies AgentProviderActionId[]),
          input.copy,
          input.pendingActionIds
        ),
        ...dockOrderProp(input.order),
        state: {
          kind: "unavailable",
          reason: input.copy.unknown
        }
      };
  }
}

function dockOrderProp(
  order: number | undefined
): Pick<WorkbenchHostDockEntry, "order"> {
  return order === undefined ? {} : { order };
}

function agentProviderDockActions(
  actionIds: readonly AgentProviderActionId[],
  copy: WorkspaceAgentProviderDockStatusCopy,
  pendingActionIds: ReadonlySet<string> | undefined
) {
  return actionIds.map((actionId) => {
    const isPending = pendingActionIds?.has(actionId) === true;
    const pendingProps =
      isPending && actionId === "install"
        ? { disabled: true, pendingLabel: copy.installing }
        : isPending
          ? { disabled: true }
          : {};
    return {
      ...pendingProps,
      id: actionId,
      label: agentProviderDockActionLabel(actionId, copy)
    };
  });
}

function agentProviderDockActionLabel(
  actionId: AgentProviderActionId,
  copy: WorkspaceAgentProviderDockStatusCopy
): string {
  switch (actionId) {
    case "install":
      return copy.install;
    case "login":
      return copy.login;
    default:
      return copy.refresh;
  }
}
