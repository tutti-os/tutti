import { createElement } from "react";
import type {
  DesktopWorkbenchContributionContext,
  DesktopWorkbenchContributionFactory
} from "../workspaceWorkbenchContributionFactory";
import { createWorkspaceTerminalContribution } from "../workspaceTerminalContribution.ts";
import { WorkspaceWorkbenchTrafficLights } from "../../../ui/WorkspaceWorkbenchTrafficLights.ts";

type TerminalWorkbenchContributionContext = Pick<
  DesktopWorkbenchContributionContext,
  | "appI18n"
  | "confirmCloseGuard"
  | "dockIcons"
  | "hostFilesApi"
  | "i18n"
  | "platformApi"
  | "reporterService"
  | "runtimeApi"
  | "tuttidClient"
  | "workspaceId"
>;

export const terminalWorkbenchContributionFactory: DesktopWorkbenchContributionFactory<TerminalWorkbenchContributionContext> =
  {
    id: "workspace-terminal",
    order: 40,
    create(context) {
      return createWorkspaceTerminalContribution({
        appI18n: context.appI18n,
        confirmCloseGuard: context.confirmCloseGuard,
        dockIcon: context.dockIcons.terminal,
        hostFilesApi: context.hostFilesApi,
        i18n: context.i18n,
        tuttidClient: context.tuttidClient,
        platformApi: context.platformApi,
        reporterService: context.reporterService,
        renderTrafficLights: (headerContext) =>
          createElement(WorkspaceWorkbenchTrafficLights, {
            className: "nodrag",
            displayMode: headerContext.displayMode,
            i18n: context.i18n,
            windowActions: headerContext.windowActions
          }),
        runtimeApi: context.runtimeApi,
        workspaceId: context.workspaceId
      });
    }
  };
