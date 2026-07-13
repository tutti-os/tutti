import type { WorkbenchHostDockEntryStateSource } from "@tutti-os/workbench-surface";
import type { AgentGUIAgent } from "@tutti-os/agent-gui";
import { resolveAgentGUIProviderCatalogIdentity } from "@tutti-os/agent-gui/provider-catalog";
import type { AgentProviderStatus } from "@tutti-os/client-tuttid-ts";
import type {
  AgentProviderStatusService,
  IAgentsService,
  IWorkspaceAgentActivityService
} from "@renderer/features/workspace-agent";
import {
  workspaceWorkbenchDesktopI18nKeys,
  type WorkspaceWorkbenchDesktopI18nRuntime
} from "../../../../../../shared/i18n/index.ts";
import { resolveAgentProviderDockStatusProps } from "./workspaceAgentProviderDockStatus.ts";
import {
  workspaceAgentGuiProviderFromIdentifier,
  type WorkspaceAgentGuiProvider
} from "./workspaceWorkbenchComposition.ts";
import {
  isWorkspaceAgentGuiDockSuppressedProvider,
  isWorkspaceAgentGuiDefaultDockProvider,
  workspaceAgentGuiProviders
} from "./workspaceAgentProviderCatalog.ts";

const installedDockOrderOffset = 0;
const pendingInstallDockOrderOffset = 100;

const agentProviderDockBaseOrder = new Map<WorkspaceAgentGuiProvider, number>(
  workspaceAgentGuiProviders.map((provider, index) => [provider, index])
);

export function createWorkspaceAgentProviderDockStateSource(input: {
  agentProviderStatusService: AgentProviderStatusService;
  agentsService: Pick<IAgentsService, "getSnapshot" | "subscribe">;
  i18n: WorkspaceWorkbenchDesktopI18nRuntime;
  /** Feature gate: providers reported hidden never render a dock entry. */
  isAgentProviderHidden?: (provider: WorkspaceAgentGuiProvider) => boolean;
  subscribeAgentProviderVisibility?: (listener: () => void) => () => void;
  workspaceAgentActivityService?: Pick<
    IWorkspaceAgentActivityService,
    "subscribe"
  >;
  workspaceId?: string;
}): WorkbenchHostDockEntryStateSource {
  return {
    getEntryState(entryId) {
      const provider = workspaceAgentGuiProviderFromIdentifier(entryId);
      if (!provider) {
        return null;
      }
      if (
        isAgentProviderHiddenByTargets(
          provider,
          input.agentsService.getSnapshot().agents
        )
      ) {
        return {
          visibility: "never"
        };
      }
      const snapshot = input.agentProviderStatusService.getSnapshot();
      const status = input.agentProviderStatusService.getStatus(provider);
      const isInitialProviderStatusLoad =
        !status && !snapshot.capturedAt && !snapshot.error;
      const state = resolveAgentProviderDockStatusProps({
        copy: {
          checking: input.i18n.t(
            workspaceWorkbenchDesktopI18nKeys.agentProviders.checking
          ),
          install: input.i18n.t(
            workspaceWorkbenchDesktopI18nKeys.agentProviders.install
          ),
          installing: input.i18n.t(
            workspaceWorkbenchDesktopI18nKeys.agentProviders.installing
          ),
          installRequired: input.i18n.t(
            workspaceWorkbenchDesktopI18nKeys.agentProviders.installRequired
          ),
          login: input.i18n.t(
            workspaceWorkbenchDesktopI18nKeys.agentProviders.login
          ),
          loginRequired: input.i18n.t(
            workspaceWorkbenchDesktopI18nKeys.agentProviders.loginRequired
          ),
          refresh: input.i18n.t(
            workspaceWorkbenchDesktopI18nKeys.agentProviders.refresh
          ),
          unsupported: input.i18n.t(
            workspaceWorkbenchDesktopI18nKeys.agentProviders.comingSoon
          ),
          unknown: input.i18n.t(
            workspaceWorkbenchDesktopI18nKeys.agentProviders.unknown
          )
        },
        isLoading: snapshot.isLoading || isInitialProviderStatusLoad,
        pendingActionIds: new Set(
          snapshot.pendingActions
            .filter((action) => action.provider === provider)
            .map((action) => action.actionId)
        ),
        order: resolveAgentProviderDockOrder(provider, status),
        status
      });
      return {
        ...state,
        diagnostics: createAgentProviderDockDiagnostics({
          isLoading: snapshot.isLoading,
          pendingActionIds: snapshot.pendingActions
            .filter((action) => action.provider === provider)
            .map((action) => action.actionId),
          provider,
          snapshotError: snapshot.error,
          status
        }),
        visibility:
          input.isAgentProviderHidden?.(provider) !== true &&
          shouldShowAgentProviderInDock(provider, status)
            ? "always"
            : "never"
      };
    },
    subscribe(listener) {
      void input.agentProviderStatusService.ensureLoaded().catch(() => {});
      const unsubscribeProviderStatus =
        input.agentProviderStatusService.subscribe(listener);
      const unsubscribeAgents = input.agentsService.subscribe(listener);
      const unsubscribeAgentActivity =
        input.workspaceAgentActivityService && input.workspaceId
          ? input.workspaceAgentActivityService.subscribe(
              input.workspaceId,
              () => {
                listener();
              }
            )
          : undefined;
      const unsubscribeProviderVisibility =
        input.subscribeAgentProviderVisibility?.(listener);
      return () => {
        unsubscribeProviderStatus();
        unsubscribeAgents();
        unsubscribeAgentActivity?.();
        unsubscribeProviderVisibility?.();
      };
    }
  };
}

function createAgentProviderDockDiagnostics(input: {
  isLoading: boolean;
  pendingActionIds: readonly string[];
  provider: WorkspaceAgentGuiProvider;
  snapshotError: string | null;
  status: AgentProviderStatus | null;
}): Record<string, unknown> {
  return {
    actions:
      input.status?.actions.map((action) => ({
        id: action.id,
        kind: action.kind
      })) ?? [],
    adapterInstalled: input.status?.adapter.installed ?? null,
    authStatus: input.status?.auth.status ?? null,
    availabilityStatus: input.status?.availability.status ?? null,
    cliInstalled: input.status?.cli.installed ?? null,
    isDefaultDockProvider: isWorkspaceAgentGuiDefaultDockProvider(
      input.provider
    ),
    isLoading: input.isLoading,
    pendingActionIds: input.pendingActionIds,
    provider: input.provider,
    snapshotError: input.snapshotError
  };
}

function shouldShowAgentProviderInDock(
  provider: WorkspaceAgentGuiProvider,
  status: AgentProviderStatus | null
): boolean {
  return (
    !isWorkspaceAgentGuiDockSuppressedProvider(provider) &&
    (isWorkspaceAgentGuiDefaultDockProvider(provider) ||
      status?.availability.status === "ready")
  );
}

function isAgentProviderHiddenByTargets(
  provider: WorkspaceAgentGuiProvider,
  agents: readonly AgentGUIAgent[] | null | undefined
): boolean {
  if (
    resolveAgentGUIProviderCatalogIdentity(provider)?.desktop.visibilityGate !==
    "tutti_agent"
  ) {
    return false;
  }
  return !agents?.some(
    (agent) =>
      agent.provider === provider && agent.availability.status === "ready"
  );
}

function resolveAgentProviderDockOrder(
  provider: WorkspaceAgentGuiProvider,
  status: AgentProviderStatus | null
): number {
  const baseOrder = agentProviderDockBaseOrder.get(provider) ?? 0;
  const unavailableOffset =
    resolveAgentGUIProviderCatalogIdentity(provider)?.desktop
      .unavailableDockOrderOffset ?? 0;
  if (unavailableOffset > 0 && status?.availability.status !== "ready") {
    return unavailableOffset + baseOrder;
  }
  const statusOffset =
    status &&
    status.availability.status !== "not_installed" &&
    status.availability.status !== "unsupported"
      ? installedDockOrderOffset
      : pendingInstallDockOrderOffset;
  return statusOffset + baseOrder;
}
