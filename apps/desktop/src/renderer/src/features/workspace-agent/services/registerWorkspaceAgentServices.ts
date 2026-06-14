import { SyncDescriptor, type ServiceRegistry } from "@tutti-os/infra/di";
import type {
  TuttidClient,
  TuttidEventStreamClient
} from "@tutti-os/client-tuttid-ts";
import type { DesktopHostFilesApi, DesktopRuntimeApi } from "@preload/types";
import type { IReporterService } from "../../analytics/services/reporterService.interface.ts";
import type { IWorkspaceUserProjectService } from "../../workspace-user-project/index.ts";
import { IAgentProviderStatusService } from "./agentProviderStatusService.interface";
import type { AgentProviderTerminalCommandRunner } from "./agentProviderStatusService.interface";
import { DesktopAgentProviderStatusService } from "./internal/desktopAgentProviderStatusService";
import { WorkspaceAgentActivityService } from "./internal/workspaceAgentActivityService";
import { WorkspaceAgentPromptSessionService } from "./internal/workspaceAgentPromptSessionService";
import { IWorkspaceAgentActivityService } from "./workspaceAgentActivityService.interface";
import { IWorkspaceAgentPromptSessionService } from "./workspaceAgentPromptSessionService.interface";

export interface WorkspaceAgentServiceRegistrationInput {
  eventStreamClient?: TuttidEventStreamClient;
  hostFilesApi: Pick<
    DesktopHostFilesApi,
    "createUserDocumentsProjectDirectory"
  >;
  tuttidClient: TuttidClient;
  reporterService?: Pick<IReporterService, "trackEvents">;
  runtimeApi: Pick<DesktopRuntimeApi, "logTerminalDiagnostic">;
  terminalCommandRunner: AgentProviderTerminalCommandRunner;
  workspaceUserProjectService?: IWorkspaceUserProjectService;
}

export function registerWorkspaceAgentServices(
  registry: ServiceRegistry,
  input: WorkspaceAgentServiceRegistrationInput
): void {
  const workspaceAgentActivityService = new WorkspaceAgentActivityService(
    input
  );
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

  registry.register(
    IAgentProviderStatusService,
    new SyncDescriptor(DesktopAgentProviderStatusService, [
      {
        tuttidClient: input.tuttidClient,
        reporterService: input.reporterService,
        terminalCommandRunner: input.terminalCommandRunner
      }
    ])
  );
}
