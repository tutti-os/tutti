import type {
  DesktopWorkbenchContributionContext,
  DesktopWorkbenchContributionFactory
} from "../workspaceWorkbenchContributionFactory";
import { createWorkspaceAgentGuiContribution } from "../workspaceAgentGuiContribution.ts";

type AgentGuiWorkbenchContributionContext = Pick<
  DesktopWorkbenchContributionContext,
  | "agentProviderStatusService"
  | "agentsService"
  | "appCenterService"
  | "appI18n"
  | "comingSoonAgentProviders"
  | "computerUseApi"
  | "defaultAgentProvider"
  | "dockIcons"
  | "dockPreviewCache"
  | "hostFilesApi"
  | "hostWindowApi"
  | "i18n"
  | "onCapabilitySettingsRequest"
  | "platformApi"
  | "renderAgentsEmpty"
  | "reporterService"
  | "richTextAtService"
  | "runtimeApi"
  | "tuttidClient"
  | "workspaceAgentActivityService"
  | "workspaceFileManagerService"
  | "workspaceId"
  | "workspaceUserProjectService"
>;

export const agentGuiWorkbenchContributionFactory: DesktopWorkbenchContributionFactory<AgentGuiWorkbenchContributionContext> =
  {
    id: "workspace-agent-gui",
    order: 25,
    create(context) {
      return createWorkspaceAgentGuiContribution({
        agentProviderStatusService: context.agentProviderStatusService,
        appCenterService: context.appCenterService,
        appI18n: context.appI18n,
        computerUseApi: context.computerUseApi,
        dockIconUrls: context.dockIcons.agents,
        unifiedDockIconUrl: context.dockIcons.agentUnified,
        dockPreviewCache: context.dockPreviewCache,
        defaultAgentProvider: context.defaultAgentProvider,
        hostFilesApi: context.hostFilesApi,
        hostWindowApi: context.hostWindowApi,
        i18n: context.i18n,
        onCapabilitySettingsRequest: context.onCapabilitySettingsRequest,
        agentsService: context.agentsService,
        renderAgentsEmpty: context.renderAgentsEmpty,
        comingSoonAgentProviders: context.comingSoonAgentProviders,
        tuttidClient: context.tuttidClient,
        platformApi: context.platformApi,
        reporterService: context.reporterService,
        richTextAtService: context.richTextAtService,
        runtimeApi: context.runtimeApi,
        workspaceAgentActivityService: context.workspaceAgentActivityService,
        workspaceFileManagerService: context.workspaceFileManagerService,
        workspaceUserProjectService: context.workspaceUserProjectService,
        workspaceId: context.workspaceId
      });
    }
  };
