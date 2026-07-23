import type { ServiceRegistry } from "@tutti-os/infra/di";
import type {
  AgentProviderStatus,
  TuttidClient,
  TuttidEventStreamClient,
  WorkspaceAgentProvider
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
import type { WorkspaceWindowLifecycle } from "../../../lib/workspaceWindowLifecycle.ts";
import { IAgentEnvService } from "./agentEnvService.interface.ts";
import { IAgentProviderStatusService } from "./agentProviderStatusService.interface";
import type { AgentProviderTerminalCommandRunner } from "./agentProviderStatusService.interface";
import { bindDesktopManagedAgentProviderVisibilityRefresh } from "./internal/desktopAgentProviderVisibilityRefresh.ts";
import { bindDesktopAgentsEarlyAccessSync } from "./internal/desktopAgentsEarlyAccessSync.ts";
import { DesktopAgentProviderStatusService } from "./internal/desktopAgentProviderStatusService";
import { desktopManagedAgentProviders } from "./internal/desktopManagedAgentProviders.ts";
import { startManagedAgentInstallBootstraps } from "./internal/tuttiAgentInstallBootstrap.ts";
import { DesktopAgentsService } from "./internal/desktopAgentsService";
import { WorkspaceAgentActivityService } from "./internal/workspaceAgentActivityService";
import { WorkspaceAgentPromptSessionService } from "./internal/workspaceAgentPromptSessionService";
import { IAgentsService } from "./agentsService.interface";
import { IWorkspaceAgentActivityService } from "./workspaceAgentActivityService.interface";
import { IWorkspaceAgentPromptSessionService } from "./workspaceAgentPromptSessionService.interface";
import { AgentEnvService } from "./internal/agentEnvService.ts";
import { DesktopAgentQuickPromptService } from "./internal/desktopAgentQuickPromptService.ts";
import {
  IAgentQuickPromptService,
  type IAgentQuickPromptService as AgentQuickPromptService
} from "./agentQuickPromptService.interface.ts";

export interface WorkspaceAgentServiceRegistrationInput {
  accountLogin: { startLogin(): Promise<void> };
  clipboard: { writeText(text: string): Promise<void> };
  desktopPreferencesService: IDesktopPreferencesService;
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
  > &
    // Collaboration-run/model-plan requests resolve the daemon endpoint
    // per-call; older hosts/tests may omit the resolver and those optional
    // commands then fail at call time instead of registration time.
    Partial<Pick<DesktopRuntimeApi, "getBackendConfig">>;
  resolveAgentTargetIconUrl?: (identity: {
    iconKey: string | null;
    provider: string;
  }) => string;
  terminalCommandRunner: AgentProviderTerminalCommandRunner;
  windowLifecycle: WorkspaceWindowLifecycle;
  workspaceId: string;
  workspaceUserProjectService?: IWorkspaceUserProjectService;
}

export interface WorkspaceAgentServiceRegistrationResult {
  agentEnvService: IAgentEnvService;
  agentsService: IAgentsService;
  agentProviderStatusService: IAgentProviderStatusService;
  readManagedAgentProviderStatuses(): readonly AgentProviderStatus[] | null;
  subscribeManagedAgentProviderStatuses(listener: () => void): () => void;
  agentQuickPromptService: AgentQuickPromptService;
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
      agentProviderStatusService,
      input.windowLifecycle
    );
  const managedProviderSet = new Set<WorkspaceAgentProvider>(
    desktopManagedAgentProviders
  );
  const readManagedAgentProviderStatuses = () => {
    const snapshot = agentProviderStatusService.getSnapshot();
    if (!snapshot.capturedAt) {
      return null;
    }
    return snapshot.statuses.filter((status) =>
      managedProviderSet.has(status.provider)
    );
  };
  startManagedAgentInstallBootstraps(agentProviderStatusService);
  const preferencesStore = input.desktopPreferencesService.store;
  const agentsService = new DesktopAgentsService({
    earlyAccessEnabled: isFeatureEnabled(
      preferencesStore.featureFlags,
      EARLY_ACCESS_AGENT_INTEGRATIONS_FLAG
    ),
    resolveAgentTargetIconUrl: input.resolveAgentTargetIconUrl,
    tuttidClient: input.tuttidClient,
    workspaceId: input.workspaceId
  });
  registry.registerInstance(IAgentsService, agentsService);
  const disposeAgentsEarlyAccessSync = bindDesktopAgentsEarlyAccessSync({
    agentsService,
    preferencesStore
  });
  const agentQuickPromptService = new DesktopAgentQuickPromptService({
    desktopPreferencesService: input.desktopPreferencesService,
    eventStreamClient: input.eventStreamClient,
    tuttidClient: input.tuttidClient
  });
  registry.registerInstance(IAgentQuickPromptService, agentQuickPromptService);
  const workspaceAgentActivityService = new WorkspaceAgentActivityService({
    ...input,
    forceRefreshAgentProviderStatuses: (providers) =>
      agentProviderStatusService.refreshStatuses(providers),
    resolveAgentTargetProvider: (agentTargetId) =>
      agentsService.getAgentTarget({ agentTargetId })?.provider ?? null
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
    readManagedAgentProviderStatuses,
    subscribeManagedAgentProviderStatuses: (listener) =>
      agentProviderStatusService.subscribe(listener),
    agentQuickPromptService,
    workspaceAgentActivityService,
    dispose() {
      disposeAgentsEarlyAccessSync();
      disposeManagedAgentProviderVisibilityRefresh();
      agentEnvService.dispose();
      agentProviderStatusService.dispose();
      agentQuickPromptService.dispose();
    }
  };
}
