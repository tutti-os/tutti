import { createElement } from "react";
import { workspaceWorkbenchDesktopI18nKeys } from "@shared/i18n";
import type {
  DesktopWorkbenchContributionContext,
  DesktopWorkbenchContributionFactory
} from "../workspaceWorkbenchContributionFactory";
import { createWorkspaceFilesContribution } from "../workspaceFilesContribution.ts";
import { WorkspaceWorkbenchTrafficLights } from "../../../ui/WorkspaceWorkbenchTrafficLights.ts";

type FilesWorkbenchContributionContext = Pick<
  DesktopWorkbenchContributionContext,
  | "dockIcons"
  | "i18n"
  | "renderFilesNodeBody"
  | "reporterService"
  | "workspaceFileManagerService"
  | "workspaceId"
>;

export const filesWorkbenchContributionFactory: DesktopWorkbenchContributionFactory<FilesWorkbenchContributionContext> =
  {
    id: "workspace-files",
    order: 10,
    create(context) {
      const filesLabel = context.i18n.t(
        workspaceWorkbenchDesktopI18nKeys.nodes.files
      );

      return createWorkspaceFilesContribution({
        filesLabel,
        icon: context.dockIcons.files,
        renderFilesNodeBody: context.renderFilesNodeBody,
        renderTrafficLights: (headerContext) =>
          createElement(WorkspaceWorkbenchTrafficLights, {
            className: "nodrag",
            displayMode: headerContext.displayMode,
            i18n: context.i18n,
            windowActions: headerContext.windowActions
          }),
        reporterService: context.reporterService,
        workspaceFileManagerService: context.workspaceFileManagerService,
        workspaceId: context.workspaceId
      });
    }
  };
