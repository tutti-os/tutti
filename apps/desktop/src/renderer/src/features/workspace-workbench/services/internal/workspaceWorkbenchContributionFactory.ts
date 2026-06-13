import type { ReactNode } from "react";
import type {
  TuttidClient,
  TuttidEventStreamClient
} from "@tutti-os/client-tuttid-ts";
import type { I18nRuntime } from "@tutti-os/ui-i18n-runtime";
import type {
  WorkbenchContribution,
  WorkbenchDockPreviewCache,
  WorkbenchHostCloseDialogRequest
} from "@tutti-os/workbench-surface";
import type {
  DesktopBrowserApi,
  DesktopHostFilesApi,
  DesktopPlatformApi,
  DesktopRuntimeApi
} from "@preload/types";
import type { IDesktopRichTextAtService } from "@renderer/features/rich-text-at";
import type {
  AgentProviderStatusService,
  IWorkspaceAgentActivityService,
  WorkspaceAgentPromptSessionService
} from "@renderer/features/workspace-agent";
import type { IWorkspaceAppCenterService } from "@renderer/features/workspace-app-center";
import type { IWorkspaceFileManagerService } from "@renderer/features/workspace-file-manager";
import type { IWorkspaceUserProjectService } from "@renderer/features/workspace-user-project";
import type { IReporterService } from "@renderer/features/analytics";
import type { WorkspaceWorkbenchDesktopI18nRuntime } from "@shared/i18n";
import type { WorkspaceWorkbenchBodyRendererContext } from "../workspaceWorkbenchHostService.interface";
import type { WorkspaceBrowserService } from "./workspaceBrowserService.ts";

export interface DesktopWorkbenchContributionContext {
  appI18n: I18nRuntime<string>;
  appCenterService: IWorkspaceAppCenterService;
  browserApi?: DesktopBrowserApi;
  browserService: WorkspaceBrowserService;
  confirmCloseGuard: (
    request: WorkbenchHostCloseDialogRequest
  ) => Promise<boolean> | boolean;
  dockPreviewCache: WorkbenchDockPreviewCache;
  defaultAgentProvider?: string | null;
  dockIcons: {
    agents: Record<string, string>;
    applications: string;
    appIconUrl: (appId: string) => string | null;
    browser: string;
    files: ReactNode;
    issue: string;
    terminal: ReactNode;
  };
  hostFilesApi: DesktopHostFilesApi;
  i18n: WorkspaceWorkbenchDesktopI18nRuntime;
  agentProviderStatusService: AgentProviderStatusService;
  workspaceFileManagerService: IWorkspaceFileManagerService;
  workspaceUserProjectService: IWorkspaceUserProjectService;
  workspaceAgentActivityService: IWorkspaceAgentActivityService;
  workspaceAgentPromptSessionService: WorkspaceAgentPromptSessionService;
  eventStreamClient?: TuttidEventStreamClient;
  tuttidClient: TuttidClient;
  platformApi: Pick<
    DesktopPlatformApi,
    "homeDirectory" | "os" | "resolveDroppedPaths"
  >;
  reporterService?: Pick<IReporterService, "trackEvents">;
  renderFilesNodeBody: (
    context: WorkspaceWorkbenchBodyRendererContext
  ) => ReactNode;
  richTextAtService: IDesktopRichTextAtService;
  runtimeApi: DesktopRuntimeApi;
  workspaceId: string;
}

export interface DesktopWorkbenchContributionFactory {
  create(
    context: DesktopWorkbenchContributionContext
  ): WorkbenchContribution | null;
  id: string;
  order: number;
}
