import type { DesktopWorkbenchContributionFactory } from "../workspaceWorkbenchContributionFactory";
import { createWorkspaceFilePreviewContribution } from "../workspaceFilePreviewContribution.ts";

export const filePreviewWorkbenchContributionFactory: DesktopWorkbenchContributionFactory =
  {
    id: "workspace-file-preview",
    order: 15,
    create(context) {
      return createWorkspaceFilePreviewContribution({
        appI18n: context.appI18n,
        hostFilesApi: context.hostFilesApi,
        i18n: context.i18n,
        tuttidClient: context.tuttidClient,
        reporterService: context.reporterService,
        workspaceId: context.workspaceId
      });
    }
  };
