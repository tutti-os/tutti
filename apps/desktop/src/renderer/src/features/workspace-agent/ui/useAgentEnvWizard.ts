import { useMemo, useSyncExternalStore } from "react";
import {
  buildAgentEnvWizardViewModel,
  readCodexSetupActiveAction,
  type AgentEnvWizardViewModel,
  type StageActionId
} from "@tutti-os/agent-gui/agent-env";
import { useService } from "@tutti-os/infra/di";
import type { WorkspaceAgentProvider } from "@tutti-os/client-tuttid-ts";
import { useTranslation } from "@renderer/i18n";
import {
  IAgentEnvService,
  type AgentEnvReportState
} from "../services/agentEnvService.interface.ts";

export interface AgentEnvWizardActions {
  redetect(): void;
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
    actions: {
      redetect: () => service.redetect(),
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
