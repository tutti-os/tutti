import type {
  AgentProviderAction,
  AgentProviderStatus
} from "@tutti-os/client-tuttid-ts";
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
  status: AgentProviderStatus | null;
}): Pick<WorkbenchHostDockEntry, "hoverActions" | "order" | "state"> {
  if (!input.status) {
    if (input.isLoading) {
      return {
        ...dockOrderProp(input.order),
        state: {
          kind: "loading",
          reason: input.copy.checking
        }
      };
    }
    return {
      hoverActions: agentProviderDockActions(
        [{ id: "refresh", kind: "refresh" }],
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

  switch (input.status.availability.status) {
    case "ready":
      return {
        ...dockOrderProp(input.order),
        state: {
          kind: "enabled"
        }
      };
    case "not_installed":
      const isInstallPending = input.pendingActionIds?.has("install") === true;
      return {
        hoverActions: agentProviderDockActions(
          input.status.actions,
          input.copy,
          input.pendingActionIds,
          new Set(["install", "refresh"])
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
      return {
        hoverActions: agentProviderDockActions(
          input.status.actions,
          input.copy,
          input.pendingActionIds,
          new Set(["login", "refresh"])
        ),
        ...dockOrderProp(input.order),
        state: {
          kind: "disabled",
          // Describe the problem ("sign in to use this agent"), not just the
          // action label — the hover action already carries the verb.
          reason: input.copy.loginRequired
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
    default:
      return {
        hoverActions: agentProviderDockActions(
          input.status.actions,
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
  actions: readonly AgentProviderAction[],
  copy: WorkspaceAgentProviderDockStatusCopy,
  pendingActionIds: ReadonlySet<string> | undefined,
  allowedActionIds?: ReadonlySet<AgentProviderAction["id"]>
) {
  return actions
    .filter((action) => allowedActionIds?.has(action.id) ?? true)
    .map((action) => {
      const isPending = pendingActionIds?.has(action.id) === true;
      const pendingProps =
        isPending && action.id === "install"
          ? { disabled: true, pendingLabel: copy.installing }
          : isPending
            ? { disabled: true }
            : {};
      return {
        ...pendingProps,
        id: action.id,
        label: agentProviderDockActionLabel(action.id, copy)
      };
    });
}

function agentProviderDockActionLabel(
  actionId: AgentProviderAction["id"],
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
