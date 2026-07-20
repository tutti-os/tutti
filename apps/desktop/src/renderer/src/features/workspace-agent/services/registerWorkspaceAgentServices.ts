import type { ServiceRegistry } from "@tutti-os/infra/di";
import type {
  TuttidClient,
  TuttidEventStreamClient
} from "@tutti-os/client-tuttid-ts";
import type { DesktopHostFilesApi, DesktopRuntimeApi } from "@preload/types";
import type { IReporterService } from "../../analytics/services/reporterService.interface.ts";
import type { IWorkspaceUserProjectService } from "../../workspace-user-project/index.ts";
import type { IDesktopPreferencesService } from "../../desktop-preferences/services/desktopPreferencesService.interface.ts";
import type { NotificationService } from "@tutti-os/ui-notifications";
import {
  EARLY_ACCESS_AGENT_INTEGRATIONS_FLAG,
  isFeatureEnabled
} from "../../../../../shared/featureFlags/catalog.ts";
import { IAgentEnvService } from "./agentEnvService.interface.ts";
import { IAgentProviderStatusService } from "./agentProviderStatusService.interface";
import type { AgentProviderTerminalCommandRunner } from "./agentProviderStatusService.interface";
import { bindDesktopManagedAgentProviderVisibilityRefresh } from "./internal/desktopAgentProviderVisibilityRefresh.ts";
import { bindDesktopAgentsEarlyAccessSync } from "./internal/desktopAgentsEarlyAccessSync.ts";
import { DesktopAgentProviderStatusService } from "./internal/desktopAgentProviderStatusService";
import { startManagedAgentInstallBootstraps } from "./internal/tuttiAgentInstallBootstrap.ts";
import { DesktopAgentsService } from "./internal/desktopAgentsService";
import { WorkspaceAgentActivityService } from "./internal/workspaceAgentActivityService";
import { WorkspaceAgentPromptSessionService } from "./internal/workspaceAgentPromptSessionService";
import { IAgentsService } from "./agentsService.interface";
import { IWorkspaceAgentActivityService } from "./workspaceAgentActivityService.interface";
import { IWorkspaceAgentPromptSessionService } from "./workspaceAgentPromptSessionService.interface";
import { AgentEnvService } from "./internal/agentEnvService.ts";

export interface WorkspaceAgentServiceRegistrationInput {
  accountLogin: { startLogin(): Promise<void> };
  clipboard: { writeText(text: string): Promise<void> };
  desktopPreferencesService?: Pick<IDesktopPreferencesService, "store">;
  eventStreamClient?: TuttidEventStreamClient;
  hostFilesApi: Pick<
    DesktopHostFilesApi,
    "createUserDocumentsProjectDirectory" | "selectAppArchive"
  >;
  tuttidClient: TuttidClient;
  reporterService?: Pick<IReporterService, "trackEvents">;
  notifications?: NotificationService;
  runtimeApi: Pick<
    DesktopRuntimeApi,
    "logRendererDiagnostic" | "logTerminalDiagnostic"
  >;
  terminalCommandRunner: AgentProviderTerminalCommandRunner;
  workspaceId: string;
  workspaceUserProjectService?: IWorkspaceUserProjectService;
}

export interface WorkspaceAgentServiceRegistrationResult {
  agentEnvService: IAgentEnvService;
  agentsService: IAgentsService;
  agentProviderStatusService: IAgentProviderStatusService;
  workspaceAgentActivityService: IWorkspaceAgentActivityService;
  dispose(): void;
}

export function registerWorkspaceAgentServices(
  registry: ServiceRegistry,
  input: WorkspaceAgentServiceRegistrationInput
): WorkspaceAgentServiceRegistrationResult {
  const agentProviderStatusService = new DesktopAgentProviderStatusService(
    {
      tuttidClient: input.tuttidClient,
      accountLogin: input.accountLogin,
      reporterService: input.reporterService,
      runtimeApi: input.runtimeApi,
      terminalCommandRunner: input.terminalCommandRunner
    },
    input.notifications
  );
  registry.registerInstance(
    IAgentProviderStatusService,
    agentProviderStatusService
  );
  const agentEnvService = new AgentEnvService({
    clipboard: input.clipboard,
    providerStatusService: agentProviderStatusService,
    workspaceId: input.workspaceId
  });
  registry.registerInstance(IAgentEnvService, agentEnvService);
  const disposeManagedAgentProviderVisibilityRefresh =
    bindDesktopManagedAgentProviderVisibilityRefresh(
      agentProviderStatusService
    );
  startManagedAgentInstallBootstraps(agentProviderStatusService);
  const preferencesStore = input.desktopPreferencesService?.store;
  const agentsService = new DesktopAgentsService({
    earlyAccessEnabled: preferencesStore
      ? isFeatureEnabled(
          preferencesStore.featureFlags,
          EARLY_ACCESS_AGENT_INTEGRATIONS_FLAG
        )
      : undefined,
    tuttidClient: input.tuttidClient
  });
  registry.registerInstance(IAgentsService, agentsService);
  const disposeAgentsEarlyAccessSync = preferencesStore
    ? bindDesktopAgentsEarlyAccessSync({ agentsService, preferencesStore })
    : () => {};
  const workspaceAgentActivityService = new WorkspaceAgentActivityService({
    ...input,
    agentProviderStatusService
  });
  registry.registerInstance(
    IWorkspaceAgentActivityService,
    workspaceAgentActivityService
  );
  registry.registerInstance(
    IWorkspaceAgentPromptSessionService,
    new WorkspaceAgentPromptSessionService({
      reporterService: input.reporterService,
      workspaceAgentActivityService,
      workspaceUserProjectService: input.workspaceUserProjectService
    })
  );
  return {
    agentEnvService,
    agentsService,
    agentProviderStatusService,
    workspaceAgentActivityService,
    dispose() {
      disposeAgentsEarlyAccessSync();
      disposeManagedAgentProviderVisibilityRefresh();
      agentEnvService.dispose();
      agentProviderStatusService.dispose();
    }
  };
}
