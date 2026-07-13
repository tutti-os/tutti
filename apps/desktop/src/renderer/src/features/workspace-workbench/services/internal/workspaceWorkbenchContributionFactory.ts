import type { ReactNode } from "react";
import type {
  AgentGUIProvider,
  AgentGUIAgentsEmptyRenderer,
  AgentGUIAgent
} from "@tutti-os/agent-gui";
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
  DesktopComputerUseApi,
  DesktopHostFilesApi,
  DesktopHostWindowApi,
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
import type {
  DesktopLocale,
  WorkspaceWorkbenchDesktopI18nRuntime
} from "@shared/i18n";
import type {
  WorkspaceWorkbenchBodyRendererContext,
  WorkspaceWorkbenchCapabilitySettingsTarget
} from "../workspaceWorkbenchHostService.interface";
import type { WorkspaceBrowserService } from "./workspaceBrowserService.ts";
import type { WorkbenchCapabilityFactoryDescriptor } from "./workbenchProductProfile.ts";

export interface DesktopWorkbenchContributionContext {
  appI18n: I18nRuntime<string>;
  appLocale: DesktopLocale;
  appCenterService: IWorkspaceAppCenterService;
  browserApi?: DesktopBrowserApi;
  browserService: WorkspaceBrowserService;
  computerUseApi: DesktopComputerUseApi;
  confirmCloseGuard: (
    request: WorkbenchHostCloseDialogRequest
  ) => Promise<boolean> | boolean;
  dockPreviewCache: WorkbenchDockPreviewCache;
  defaultAgentProvider?: string | null;
  defaultAgentTargetId?: string | null;
  dockIcons: {
    agentUnified: string;
    agents: Record<string, string>;
    applications: string;
    browser: string;
    files: ReactNode;
    issue: string;
    terminal: ReactNode;
  };
  hostFilesApi: DesktopHostFilesApi;
  hostWindowApi: Pick<DesktopHostWindowApi, "openAgentWindow">;
  i18n: WorkspaceWorkbenchDesktopI18nRuntime;
  onCapabilitySettingsRequest?: (
    target: WorkspaceWorkbenchCapabilitySettingsTarget
  ) => void;
  agents: readonly AgentGUIAgent[];
  agentsLoading?: boolean;
  renderAgentsEmpty?: AgentGUIAgentsEmptyRenderer;
  comingSoonAgentProviders?: readonly AgentGUIProvider[];
  agentProviderStatusService: AgentProviderStatusService;
  workspaceFileManagerService: IWorkspaceFileManagerService;
  workspaceUserProjectService: IWorkspaceUserProjectService;
  workspaceAgentActivityService: IWorkspaceAgentActivityService;
  workspaceAgentPromptSessionService: WorkspaceAgentPromptSessionService;
  eventStreamClient?: TuttidEventStreamClient;
  tuttidClient: TuttidClient;
  platformApi: Pick<
    DesktopPlatformApi,
    "homeDirectory" | "os" | "resolveDroppedEntries" | "resolveDroppedPaths"
  >;
  reporterService?: Pick<IReporterService, "trackEvents">;
  renderFilesNodeBody: (
    context: WorkspaceWorkbenchBodyRendererContext
  ) => ReactNode;
  richTextAtService: IDesktopRichTextAtService;
  runtimeApi: DesktopRuntimeApi;
  workspaceId: string;
}

export interface DesktopWorkbenchContributionFactory<TContext> {
  create(context: TContext): WorkbenchContribution | null;
  id: string;
  order: number;
}

export function bindDesktopWorkbenchContributionFactory<TContext>(
  factory: DesktopWorkbenchContributionFactory<TContext>,
  context: TContext
): WorkbenchCapabilityFactoryDescriptor {
  return {
    create: () => factory.create(context),
    id: factory.id,
    order: factory.order
  };
}
