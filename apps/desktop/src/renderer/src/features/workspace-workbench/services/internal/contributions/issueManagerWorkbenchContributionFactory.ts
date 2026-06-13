import type { DesktopWorkbenchContributionFactory } from "../workspaceWorkbenchContributionFactory";
import { createWorkspaceIssueManagerContribution } from "../workspaceIssueManagerContribution.ts";

export const issueManagerWorkbenchContributionFactory: DesktopWorkbenchContributionFactory =
  {
    id: "workspace-issue-manager",
    order: 0,
    create(context) {
      return createWorkspaceIssueManagerContribution({
        agentProviderStatusService: context.agentProviderStatusService,
        defaultAgentProvider: context.defaultAgentProvider,
        dockIconUrl: context.dockIcons.issue,
        hostFilesApi: context.hostFilesApi,
        i18n: context.appI18n,
        eventStreamClient: context.eventStreamClient,
        tuttidClient: context.tuttidClient,
        platformApi: context.platformApi,
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
