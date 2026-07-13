import {
  bindDesktopWorkbenchContributionFactory,
  type DesktopWorkbenchContributionContext
} from "./workspaceWorkbenchContributionFactory.ts";
import type { WorkbenchProductProfile } from "./workbenchProductProfile.ts";
import { agentGuiWorkbenchContributionFactory } from "./contributions/agentGuiWorkbenchContributionFactory.ts";
import { appCenterWorkbenchContributionFactory } from "./contributions/appCenterWorkbenchContributionFactory.ts";
import { browserWorkbenchContributionFactory } from "./contributions/browserWorkbenchContributionFactory.ts";
import { filePreviewWorkbenchContributionFactory } from "./contributions/filePreviewWorkbenchContributionFactory.ts";
import { filesWorkbenchContributionFactory } from "./contributions/filesWorkbenchContributionFactory.ts";
import { issueManagerWorkbenchContributionFactory } from "./contributions/issueManagerWorkbenchContributionFactory.ts";
import { terminalWorkbenchContributionFactory } from "./contributions/terminalWorkbenchContributionFactory.ts";

export function createTuttiWorkbenchProductProfile(
  context: DesktopWorkbenchContributionContext
): WorkbenchProductProfile {
  return {
    productId: "tutti",
    scopeKind: "workspace",
    capabilityFactories: [
      bindDesktopWorkbenchContributionFactory(
        filesWorkbenchContributionFactory,
        pickDesktopWorkbenchContributionContext(context, [
          "dockIcons",
          "i18n",
          "renderFilesNodeBody",
          "reporterService",
          "workspaceFileManagerService",
          "workspaceId"
        ])
      ),
      bindDesktopWorkbenchContributionFactory(
        filePreviewWorkbenchContributionFactory,
        pickDesktopWorkbenchContributionContext(context, [
          "appI18n",
          "hostFilesApi",
          "i18n",
          "reporterService",
          "tuttidClient",
          "workspaceId"
        ])
      ),
      bindDesktopWorkbenchContributionFactory(
        appCenterWorkbenchContributionFactory,
        pickDesktopWorkbenchContributionContext(context, [
          "appCenterService",
          "appI18n",
          "browserApi",
          "browserService",
          "reporterService",
          "runtimeApi",
          "workspaceId"
        ])
      ),
      bindDesktopWorkbenchContributionFactory(
        browserWorkbenchContributionFactory,
        pickDesktopWorkbenchContributionContext(context, [
          "appI18n",
          "browserApi",
          "browserService",
          "dockIcons",
          "i18n",
          "reporterService",
          "runtimeApi",
          "workspaceId"
        ])
      ),
      bindDesktopWorkbenchContributionFactory(
        agentGuiWorkbenchContributionFactory,
        pickDesktopWorkbenchContributionContext(context, [
          "agentProviderStatusService",
          "agents",
          "agentsLoading",
          "appCenterService",
          "appI18n",
          "comingSoonAgentProviders",
          "computerUseApi",
          "defaultAgentProvider",
          "defaultAgentTargetId",
          "dockIcons",
          "dockPreviewCache",
          "hostFilesApi",
          "hostWindowApi",
          "i18n",
          "onCapabilitySettingsRequest",
          "platformApi",
          "renderAgentsEmpty",
          "reporterService",
          "richTextAtService",
          "runtimeApi",
          "tuttidClient",
          "workspaceAgentActivityService",
          "workspaceFileManagerService",
          "workspaceId",
          "workspaceUserProjectService"
        ])
      ),
      bindDesktopWorkbenchContributionFactory(
        issueManagerWorkbenchContributionFactory,
        pickDesktopWorkbenchContributionContext(context, [
          "agentProviderStatusService",
          "agents",
          "appCenterService",
          "appI18n",
          "appLocale",
          "defaultAgentProvider",
          "dockIcons",
          "eventStreamClient",
          "hostFilesApi",
          "platformApi",
          "reporterService",
          "richTextAtService",
          "runtimeApi",
          "tuttidClient",
          "workspaceAgentActivityService",
          "workspaceAgentPromptSessionService",
          "workspaceId",
          "workspaceUserProjectService"
        ])
      ),
      bindDesktopWorkbenchContributionFactory(
        terminalWorkbenchContributionFactory,
        pickDesktopWorkbenchContributionContext(context, [
          "appI18n",
          "confirmCloseGuard",
          "dockIcons",
          "hostFilesApi",
          "i18n",
          "platformApi",
          "reporterService",
          "runtimeApi",
          "tuttidClient",
          "workspaceId"
        ])
      )
    ]
  };
}

function pickDesktopWorkbenchContributionContext<
  TKey extends keyof DesktopWorkbenchContributionContext
>(
  context: DesktopWorkbenchContributionContext,
  keys: readonly TKey[]
): Pick<DesktopWorkbenchContributionContext, TKey> {
  return Object.fromEntries(keys.map((key) => [key, context[key]])) as Pick<
    DesktopWorkbenchContributionContext,
    TKey
  >;
}
