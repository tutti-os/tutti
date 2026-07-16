import type { IReporterService } from "@renderer/features/analytics";
import type { IDesktopRichTextAtService } from "@renderer/features/rich-text-at";
import type { IAgentProviderStatusService as AgentProviderStatusService } from "@renderer/features/workspace-agent/services/agentProviderStatusService.interface.ts";
import type { IWorkspaceAgentActivityService as WorkspaceAgentActivityService } from "@renderer/features/workspace-agent/services/workspaceAgentActivityService.interface.ts";
import type { DesktopAgentGUIProvider } from "@renderer/features/workspace-agent/desktopAgentGUINodeState.ts";
import type { IWorkspaceAppCenterService } from "@renderer/features/workspace-app-center";
import type { IWorkspaceUserProjectService } from "@renderer/features/workspace-user-project";
import type {
  DesktopApi,
  DesktopHostWindowApi,
  DesktopWorkspaceAppExternalHostApi
} from "@preload/types";
import type {
  TuttidClient,
  TuttidEventStreamClient,
  WorkspaceSummary
} from "@tutti-os/client-tuttid-ts";
import type { I18nRuntime } from "@tutti-os/ui-i18n-runtime";
import type {
  WorkbenchContribution,
  WorkbenchHostHandle
} from "@tutti-os/workbench-surface";

export interface StandaloneAgentWindowProps {
  agentProviderStatusService: AgentProviderStatusService;
  defaultAgentProvider: DesktopAgentGUIProvider;
  desktopApi: DesktopApi;
  eventStreamClient: TuttidEventStreamClient;
  hostWindowApi: Pick<
    DesktopHostWindowApi,
    | "approveClose"
    | "minimize"
    | "openAgentWindow"
    | "resizeContentWidth"
    | "toggleMaximize"
  >;
  reporterService: Pick<IReporterService, "trackEvents">;
  richTextAtService: IDesktopRichTextAtService;
  tuttidClient: TuttidClient;
  workspaceAgentActivityService: WorkspaceAgentActivityService;
  workspaceAppCenterService: IWorkspaceAppCenterService;
  workspaceAppExternalApi?: DesktopWorkspaceAppExternalHostApi;
  toolWorkbench: {
    appI18n: I18nRuntime<string>;
    contributions: readonly WorkbenchContribution[] | undefined;
    onHostReady(host: WorkbenchHostHandle | null): void;
    requestWindowClose(): Promise<"approved" | "blocked">;
  };
  workspace: WorkspaceSummary;
  workspaceUserProjectService: IWorkspaceUserProjectService;
}
