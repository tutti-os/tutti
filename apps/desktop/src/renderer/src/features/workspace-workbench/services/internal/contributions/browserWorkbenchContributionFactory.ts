import { createElement } from "react";
import type {
  DesktopWorkbenchContributionContext,
  DesktopWorkbenchContributionFactory
} from "../workspaceWorkbenchContributionFactory";
import { createWorkspaceBrowserContribution } from "../workspaceBrowserContribution.ts";
import { WorkspaceWorkbenchTrafficLights } from "../../../ui/WorkspaceWorkbenchTrafficLights.ts";

type BrowserWorkbenchContributionContext = Pick<
  DesktopWorkbenchContributionContext,
  | "appI18n"
  | "browserApi"
  | "browserService"
  | "dockIcons"
  | "i18n"
  | "reporterService"
  | "runtimeApi"
  | "workspaceId"
>;

export const browserWorkbenchContributionFactory: DesktopWorkbenchContributionFactory<BrowserWorkbenchContributionContext> =
  {
    id: "workspace-browser",
    order: 20,
    create(context) {
      return context.browserApi
        ? createWorkspaceBrowserContribution({
            browserApi: context.browserApi,
            browserService: context.browserService,
            dockIconUrl: context.dockIcons.browser,
            i18n: context.appI18n,
            renderTrafficLights: (headerContext) =>
              createElement(WorkspaceWorkbenchTrafficLights, {
                className: "nodrag",
                displayMode: headerContext.displayMode,
                i18n: context.i18n,
                windowActions: headerContext.windowActions
              }),
            runtimeApi: context.runtimeApi,
            reporterService: context.reporterService,
            workspaceId: context.workspaceId
          })
        : null;
    }
  };
