import type {
  DesktopWorkbenchContributionContext,
  DesktopWorkbenchContributionFactory
} from "../workspaceWorkbenchContributionFactory";
import { createWorkspaceFilePreviewContribution } from "../workspaceFilePreviewContribution.ts";

type FilePreviewWorkbenchContributionContext = Pick<
  DesktopWorkbenchContributionContext,
  | "appI18n"
  | "hostFilesApi"
  | "i18n"
  | "reporterService"
  | "tuttidClient"
  | "workspaceId"
>;

export const filePreviewWorkbenchContributionFactory: DesktopWorkbenchContributionFactory<FilePreviewWorkbenchContributionContext> =
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
