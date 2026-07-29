import { useMemo, useSyncExternalStore } from "react";
import {
  buildAgentEnvWizardViewModel,
  readCodexSetupActiveAction,
  type AgentEnvWizardViewModel,
  type StageActionId
} from "@tutti-os/agent-gui/agent-env";
import { useService } from "@tutti-os/infra/di";
import type { WorkspaceAgentProvider } from "@tutti-os/client-tuttid-ts";
import type { AgentProviderRuntimeCatalogResponse } from "@tutti-os/client-tuttid-ts";
import { useTranslation } from "@renderer/i18n";
import {
  IAgentEnvService,
  type AgentEnvReportState
} from "../services/agentEnvService.interface.ts";
import { supportsRuntimeCandidateCatalog } from "../services/internal/desktopManagedAgentProviders.ts";

export interface AgentEnvWizardActions {
  redetect(): void;
  selectCodexRuntime(candidateId: string): void;
  runStageAction(actionId: StageActionId): void;
  confirmReport(): void;
  dismissReport(): void;
  copyManual(command: string): void;
  toggleLog(): void;
  close(): void;
}

export function useAgentEnvWizard(): {
  open: boolean;
  provider: WorkspaceAgentProvider;
  isSupported: boolean;
  viewModel: AgentEnvWizardViewModel;
  reportState: AgentEnvReportState;
  copied: boolean;
  logExpanded: boolean;
  runtimeCatalog: AgentProviderRuntimeCatalogResponse | null;
  runtimeCatalogLoading: boolean;
  runtimeSelectionNeeded: boolean;
  runtimeSelectionError: string | null;
  runtimeSelectionPendingId: string | null;
  actions: AgentEnvWizardActions;
} {
  const service = useService(IAgentEnvService);
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(
    (listener) => service.subscribe(listener),
    () => service.getSnapshot(),
    () => service.getSnapshot()
  );
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
        provider: snapshot.provider,
        status: snapshot.status,
        isLoading: snapshot.isLoading,
        activeAction: readCodexSetupActiveAction(snapshot.status),
        installActionPending: snapshot.installPending,
        updateActionPending: snapshot.updatePending,
        loginPending: snapshot.loginPending,
        revealIndex: snapshot.revealIndex,
        stageLabels
      }),
    [snapshot, stageLabels]
  );

  return {
    open: snapshot.open,
    provider: snapshot.provider,
    isSupported: snapshot.isSupported,
    viewModel,
    reportState: snapshot.reportState,
    copied: snapshot.copied,
    logExpanded: snapshot.logExpanded,
    runtimeCatalog: snapshot.runtimeCatalog,
    runtimeCatalogLoading: snapshot.runtimeCatalogLoading,
    runtimeSelectionNeeded:
      supportsRuntimeCandidateCatalog(snapshot.provider) &&
      (snapshot.status?.availability.reasonCode ===
        "codex_runtime_selection_required" ||
        snapshot.status?.availability.reasonCode ===
          "codex_runtime_selection_stale"),
    runtimeSelectionError: snapshot.runtimeSelectionError,
    runtimeSelectionPendingId: snapshot.runtimeSelectionPendingId,
    actions: {
      redetect: () => service.redetect(),
      selectCodexRuntime: (candidateId) => {
        void service.selectCodexRuntime(candidateId).catch((error) => {
          console.warn(
            `[agent-env] selectCodexRuntime(${candidateId}) failed`,
            error
          );
        });
      },
      runStageAction: (actionId) => {
        void service.runStageAction(actionId).catch((error) => {
          console.warn(
            `[agent-env] runAction(${actionId}) failed`,
            snapshot.provider,
            error
          );
        });
      },
      confirmReport: () => service.confirmReport(),
      dismissReport: () => service.dismissReport(),
      copyManual: (command) => {
        void service.copyManual(command);
      },
      toggleLog: () => service.toggleLog(),
      close: () => service.close()
    }
  };
}
