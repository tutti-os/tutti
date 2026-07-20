import type { ServiceRegistry } from "@tutti-os/infra/di";
import type {
  TuttidClient,
  TuttidEventStreamClient
} from "@tutti-os/client-tuttid-ts";
import type { DesktopHostFilesApi, DesktopRuntimeApi } from "@preload/types";
import type { IReporterService } from "../../analytics/services/reporterService.interface.ts";
import type { IWorkspaceUserProjectService } from "../../workspace-user-project/index.ts";
import type { NotificationService } from "@tutti-os/ui-notifications";
import { IAgentEnvService } from "./agentEnvService.interface.ts";
import { IAgentProviderStatusService } from "./agentProviderStatusService.interface";
import type { AgentProviderTerminalCommandRunner } from "./agentProviderStatusService.interface";
import { bindDesktopManagedAgentProviderVisibilityRefresh } from "./internal/desktopAgentProviderVisibilityRefresh.ts";
import { createDesktopAgentAvailabilitySnapshotPageviewReport } from "./internal/desktopAgentAvailabilitySnapshotPageviewReport.ts";
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
  bindProviderVisibilityRefresh?: boolean;
  clipboard: { writeText(text: string): Promise<void> };
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
  resolveAgentTargetIconUrl?: (identity: {
    iconKey: string | null;
    provider: string;
  }) => string;
  terminalCommandRunner: AgentProviderTerminalCommandRunner;
  workspaceId: string;
  workspaceUserProjectService?: IWorkspaceUserProjectService;
}

export interface WorkspaceAgentServiceRegistrationResult {
  agentEnvService: IAgentEnvService;
  agentsService: IAgentsService;
  agentProviderStatusService: IAgentProviderStatusService;
  reportAgentAvailabilitySnapshot(): Promise<void>;
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
    input.bindProviderVisibilityRefresh === false
      ? () => {}
      : bindDesktopManagedAgentProviderVisibilityRefresh(
          agentProviderStatusService
        );
  const reportAgentAvailabilitySnapshot =
    createDesktopAgentAvailabilitySnapshotPageviewReport(
      agentProviderStatusService,
      { reporterService: input.reporterService }
    );
  startManagedAgentInstallBootstraps(agentProviderStatusService);
  const agentsService = new DesktopAgentsService({
    resolveAgentTargetIconUrl: input.resolveAgentTargetIconUrl,
    tuttidClient: input.tuttidClient
  });
  registry.registerInstance(IAgentsService, agentsService);
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
    reportAgentAvailabilitySnapshot,
    workspaceAgentActivityService,
    dispose() {
      disposeManagedAgentProviderVisibilityRefresh();
      agentEnvService.dispose();
      agentProviderStatusService.dispose();
    }
  };
}
