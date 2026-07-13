import type {
  DesktopWorkbenchContributionContext,
  DesktopWorkbenchContributionFactory
} from "../workspaceWorkbenchContributionFactory";
import { createWorkspaceIssueManagerContribution } from "../workspaceIssueManagerContribution.ts";

type IssueManagerWorkbenchContributionContext = Pick<
  DesktopWorkbenchContributionContext,
  | "agentProviderStatusService"
  | "agents"
  | "appCenterService"
  | "appI18n"
  | "appLocale"
  | "defaultAgentProvider"
  | "dockIcons"
  | "eventStreamClient"
  | "hostFilesApi"
  | "platformApi"
  | "reporterService"
  | "richTextAtService"
  | "runtimeApi"
  | "tuttidClient"
  | "workspaceAgentActivityService"
  | "workspaceAgentPromptSessionService"
  | "workspaceId"
  | "workspaceUserProjectService"
>;

export const issueManagerWorkbenchContributionFactory: DesktopWorkbenchContributionFactory<IssueManagerWorkbenchContributionContext> =
  {
    id: "workspace-issue-manager",
    order: 0,
    create(context) {
      return createWorkspaceIssueManagerContribution({
        agentProviderStatusService: context.agentProviderStatusService,
        appCenterService: context.appCenterService,
        defaultAgentProvider: context.defaultAgentProvider,
        dockIconUrl: context.dockIcons.issue,
        hostFilesApi: context.hostFilesApi,
        i18n: context.appI18n,
        locale: context.appLocale,
        eventStreamClient: context.eventStreamClient,
        tuttidClient: context.tuttidClient,
        platformApi: context.platformApi,
        agents: context.agents,
        reporterService: context.reporterService,
        richTextAtService: context.richTextAtService,
        runtimeApi: context.runtimeApi,
        workspaceAgentActivityService: context.workspaceAgentActivityService,
        workspaceAgentPromptSessionService:
          context.workspaceAgentPromptSessionService,
        workspaceUserProjectService: context.workspaceUserProjectService,
        workspaceId: context.workspaceId
      });
    }
  };
