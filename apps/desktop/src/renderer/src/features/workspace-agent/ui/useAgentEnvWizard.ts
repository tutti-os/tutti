import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { WorkspaceAgentProvider } from "@tutti-os/client-tuttid-ts";
import {
  buildAgentEnvWizardViewModel,
  readCodexSetupActiveAction,
  useAgentEnvPanelRequest,
  type AgentEnvWizardViewModel,
  type StageActionId
} from "@tutti-os/agent-gui/agent-env";
import { useTranslation } from "@renderer/i18n";
import type { IAgentProviderStatusService } from "../services/agentProviderStatusService.interface";
import {
  desktopManagedAgentDefaultProvider,
  isDesktopManagedAgentProvider
} from "../services/internal/desktopManagedAgentProviders.ts";
import {
  attachAgentEnvWizard,
  restartAgentEnvWizardDetection
} from "../services/internal/agentEnvWizardController.ts";
import {
  setWizardCopied,
  setWizardReportState,
  toggleWizardLog,
  useAgentEnvWizardState,
  type WizardReportState
} from "../services/internal/agentEnvWizardStore.ts";
import { useAccountService } from "../../workspace-workbench/ui/useAccountService.ts";
import { isDesktopAgentAccountLoginAction } from "./desktopAgentAccountLoginAction.ts";

function useStatusSnapshot(service: IAgentProviderStatusService) {
  return useSyncExternalStore(
    (l) => service.subscribe(l),
    () => service.getSnapshot()
  );
}

// Fire-and-forget service calls (runAction, reportEnvIssue) reject on failure;
// the service already surfaces a user-facing notification, so here we only log
// for diagnostics to avoid an unhandled promise rejection in the renderer.
function logDetachedActionError(
  action: string,
  provider: string,
  err: unknown
): void {
  console.warn(`[agent-env] ${action} failed`, provider, err);
}

function resolveActiveProvider(
  requested: string | null,
  defaultProvider: WorkspaceAgentProvider | null
): { provider: WorkspaceAgentProvider; isSupported: boolean } {
  // An explicit request is honored as-is — even when it names an unmanaged
  // provider — so the panel can tell the user it is unsupported rather than
  // silently switching them to a different agent (and running detect/install/
  // login against the wrong provider). Only fall back to a managed default when
  // no provider was requested at all (a casual "智能体环境" open).
  if (requested) {
    return {
      provider: requested as WorkspaceAgentProvider,
      isSupported: isDesktopManagedAgentProvider(requested)
    };
  }
  if (defaultProvider && isDesktopManagedAgentProvider(defaultProvider)) {
    return { provider: defaultProvider, isSupported: true };
  }
  return {
    provider: desktopManagedAgentDefaultProvider,
    isSupported: true
  };
}

export interface AgentEnvWizardActions {
  redetect(): void;
  runStageAction(actionId: StageActionId): void;
  confirmReport(): void;
  dismissReport(): void;
  copyManual(command: string): void;
  toggleLog(): void;
}

export function useAgentEnvWizard(input: {
  service: IAgentProviderStatusService;
  workspaceId: string;
  workbenchHost?: unknown;
}): {
  open: boolean;
  provider: WorkspaceAgentProvider;
  isSupported: boolean;
  viewModel: AgentEnvWizardViewModel;
  reportState: WizardReportState;
  copied: boolean;
  logExpanded: boolean;
  actions: AgentEnvWizardActions;
} {
  const { service, workspaceId, workbenchHost } = input;
  const { t } = useTranslation();
  const { service: accountService } = useAccountService();
  const request = useAgentEnvPanelRequest();
  const snapshot = useStatusSnapshot(service);
  const wizard = useAgentEnvWizardState();

  const { provider, isSupported } = useMemo(
    () => resolveActiveProvider(request.provider, snapshot.defaultProvider),
    [request.provider, snapshot.defaultProvider]
  );

  const status = useMemo(
    () => snapshot.statuses.find((s) => s.provider === provider) ?? null,
    [snapshot.statuses, provider]
  );

  const runProviderAction = useCallback(
    async (actionId: "install" | "login") => {
      if (actionId === "login" && isDesktopAgentAccountLoginAction(status)) {
        await accountService.startLogin();
        return;
      }
      await service.runAction(provider, actionId, {
        workbenchHost,
        workspaceId
      });
    },
    [accountService, service, provider, status, workbenchHost, workspaceId]
  );

  const attachParams = useMemo(
    () => ({
      service,
      provider,
      focus: request.focus,
      requestSequence: request.requestSequence,
      context: { workspaceId, workbenchHost },
      runAction: runProviderAction
    }),
    [
      service,
      provider,
      request.focus,
      request.requestSequence,
      workspaceId,
      workbenchHost,
      runProviderAction
    ]
  );

  // Single lifecycle effect: synchronize the orchestrator with the open panel.
  // An unsupported (unmanaged) provider never attaches — no detection, no
  // auto-start — so the panel just shows the unsupported message.
  useEffect(() => {
    if (!request.open || !isSupported) {
      return;
    }
    return attachAgentEnvWizard(attachParams);
  }, [request.open, isSupported, attachParams]);

  const stageLabels = useMemo(
    () => ({
      detect: t("workspace.agentEnv.stageDetect"),
      network: t("workspace.agentEnv.stageNetwork"),
      install: t("workspace.agentEnv.stageInstall"),
      adapter: t("workspace.agentEnv.stageAdapter"),
      login: t("workspace.agentEnv.stageLogin"),
      ready: t("workspace.agentEnv.stageReady")
    }),
    [t]
  );

  const viewModel = useMemo(
    () =>
      buildAgentEnvWizardViewModel({
        provider,
        status,
        isLoading: snapshot.isLoading,
        activeAction: readCodexSetupActiveAction(status),
        installActionPending: service.isActionPending(provider, "install"),
        loginPending: service.isActionPending(provider, "login"),
        revealIndex: wizard.revealIndex,
        stageLabels
      }),
    [
      provider,
      status,
      snapshot.isLoading,
      snapshot.pendingActions,
      service,
      wizard.revealIndex,
      stageLabels
    ]
  );

  const redetect = useCallback(
    () => restartAgentEnvWizardDetection(attachParams),
    [attachParams]
  );
  const runStageAction = useCallback(
    (actionId: StageActionId) => {
      if (actionId === "redetect") {
        restartAgentEnvWizardDetection(attachParams);
        return;
      }
      void runProviderAction(actionId).catch((err) =>
        logDetachedActionError(`runAction(${actionId})`, provider, err)
      );
    },
    [attachParams, provider, runProviderAction]
  );
  const confirmReport = useCallback(() => {
    service.setDiagnosticsConsent(true);
    void service
      .reportEnvIssue(provider)
      .catch((err) => logDetachedActionError("reportEnvIssue", provider, err));
    setWizardReportState("reported");
  }, [service, provider]);
  const dismissReport = useCallback(
    () => setWizardReportState("dismissed"),
    []
  );
  const copyManual = useCallback(async (command: string) => {
    try {
      await navigator.clipboard?.writeText(command);
      setWizardCopied(true);
    } catch {
      setWizardCopied(false);
    }
  }, []);
  const copyManualSync = useCallback(
    (c: string) => void copyManual(c),
    [copyManual]
  );
  const toggleLog = useCallback(toggleWizardLog, []);

  return {
    open: request.open,
    provider,
    isSupported,
    viewModel,
    reportState: wizard.reportState,
    copied: wizard.copied,
    logExpanded: wizard.logExpanded,
    actions: {
      redetect,
      runStageAction,
      confirmReport,
      dismissReport,
      copyManual: copyManualSync,
      toggleLog
    }
  };
}
