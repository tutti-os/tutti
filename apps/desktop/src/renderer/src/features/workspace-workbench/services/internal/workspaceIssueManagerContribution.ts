import { createElement } from "react";
import { agentGuiDockIconUrls } from "@tutti-os/agent-gui";
import type {
  AgentProviderStatus,
  TuttidClient,
  TuttidEventStreamClient,
  WorkspaceAgentProvider
} from "@tutti-os/client-tuttid-ts";
import type { I18nRuntime } from "@tutti-os/ui-i18n-runtime";
import issueManagerDockIconUrl from "@tutti-os/workspace-issue-manager/assets/workspace-dock-task.png";
import {
  createIssueManagerDockIconImage,
  createIssueManagerWorkbenchContribution,
  defaultIssueManagerWorkbenchTypeId
} from "@tutti-os/workspace-issue-manager/workbench";
import { resolveDefaultAppFactoryProvider } from "@tutti-os/workspace-app-center/core";
import type { WorkbenchContribution } from "@tutti-os/workbench-surface";
import type {
  DesktopHostFilesApi,
  DesktopPlatformApi,
  DesktopRuntimeApi
} from "@preload/types";
import {
  createDesktopIssueManagerFeature,
  createDesktopIssueManagerNodeStateSource
} from "@renderer/features/workspace-issue-manager";
import type { IReporterService } from "../../../analytics/services/reporterService.interface.ts";
import {
  requestWorkspaceAgentGuiLaunch,
  type AgentProviderStatusService,
  type IWorkspaceAgentActivityService,
  type WorkspaceAgentPromptSessionService
} from "@renderer/features/workspace-agent";
import { runDesktopAgentGUILinkAction } from "@renderer/features/workspace-agent/services/desktopAgentGUILinkActions.ts";
import { normalizeDesktopAgentGUIProvider } from "@renderer/features/workspace-agent/desktopAgentGUINodeState";
import type { IDesktopRichTextAtService } from "@renderer/features/rich-text-at";
import type { IWorkspaceUserProjectService } from "@renderer/features/workspace-user-project";
import { requestWorkspaceBrowserLaunch } from "../workspaceBrowserLaunchCoordinator.ts";
import { requestWorkspaceFilesLaunch } from "../workspaceFilesLaunchCoordinator.ts";
import { requestWorkspaceIssueManagerLaunch } from "../workspaceIssueManagerLaunchCoordinator.ts";
import {
  resolveWorkspaceAgentGuiLabel,
  workspaceAgentGuiProviders
} from "./workspaceAgentProviderCatalog.ts";
import { renderIssueManagerLatestRunMessageCenterCard } from "../../ui/IssueManagerLatestRunMessageCenterCard.tsx";
import { workspaceTaskDockSectionId } from "./workspaceDockSections.ts";

export function createWorkspaceIssueManagerContribution(input: {
  agentProviderStatusService: AgentProviderStatusService;
  defaultAgentProvider?: string | null;
  dockIconUrl?: string;
  hostFilesApi: DesktopHostFilesApi;
  i18n: I18nRuntime<string>;
  eventStreamClient?: TuttidEventStreamClient;
  tuttidClient: TuttidClient;
  platformApi: Pick<
    DesktopPlatformApi,
    "homeDirectory" | "os" | "resolveDroppedPaths"
  >;
  richTextAtService: IDesktopRichTextAtService;
  runtimeApi: DesktopRuntimeApi;
  reporterService?: Pick<IReporterService, "trackEvents">;
  workspaceAgentActivityService: IWorkspaceAgentActivityService;
  workspaceAgentPromptSessionService: WorkspaceAgentPromptSessionService;
  workspaceUserProjectService: IWorkspaceUserProjectService;
  workspaceId: string;
}): WorkbenchContribution {
  const feature = createDesktopIssueManagerFeature({
    agentProviderOptions: {
      getOptions: () =>
        resolveIssueManagerReadyAgentProviderOptions(
          input.agentProviderStatusService.getSnapshot().statuses,
          input.defaultAgentProvider
        ),
      subscribe: (listener) =>
        input.agentProviderStatusService.subscribe(listener)
    },
    agentSessionCreator: input.workspaceAgentPromptSessionService,
    eventStreamClient: input.eventStreamClient,
    hostFilesApi: input.hostFilesApi,
    i18n: input.i18n,
    launchAgentGui: async (request) => {
      const launched = await requestWorkspaceAgentGuiLaunch({
        agentSessionId: request.agentSessionId,
        provider: normalizeDesktopAgentGUIProvider(request.provider),
        workspaceId: request.workspaceId
      });
      if (!launched) {
        throw new Error("issue_manager.agent_gui_launch_unavailable");
      }
    },
    tuttidClient: input.tuttidClient,
    openWorkspaceFileManager: async (reference) =>
      requestWorkspaceFilesLaunch({
        homeDirectory: input.platformApi.homeDirectory,
        path: reference.path,
        source: "issue_manager",
        workspaceId: input.workspaceId
      }),
    reporterService: input.reporterService,
    workspaceUserProjectService: input.workspaceUserProjectService,
    workspaceId: input.workspaceId
  });
  const nodeStateSource = createDesktopIssueManagerNodeStateSource({
    defaultAgentProvider: input.defaultAgentProvider,
    workspaceId: input.workspaceId
  });
  const issueIconUrl = input.dockIconUrl ?? issueManagerDockIconUrl;

  const contribution = createIssueManagerWorkbenchContribution({
    contributionId: "workspace-issue-manager",
    dockEntry: {
      dockIcon: createIssueManagerDockIconImage(issueIconUrl),
      id: defaultIssueManagerWorkbenchTypeId,
      order: 0,
      sectionId: workspaceTaskDockSectionId
    },
    externalStateSource: nodeStateSource.externalStateSource,
    feature,
    node: {
      emptyIllustration: createElement("img", {
        alt: "",
        "aria-hidden": "true",
        className: "h-12 w-12 object-contain",
        decoding: "async",
        draggable: false,
        src: issueIconUrl
      }),
      onStateChange: ({ instanceId, state }) => {
        nodeStateSource.writeNodeState({
          instanceId,
          state,
          typeId: defaultIssueManagerWorkbenchTypeId
        });
      },
      renderLatestRunStatus: (renderInput) =>
        renderIssueManagerLatestRunMessageCenterCard(renderInput, {
          i18n: input.i18n,
          onLinkAction: (action) => {
            void runDesktopAgentGUILinkAction(action, {
              homeDirectory: input.platformApi.homeDirectory,
              launchAgentGui: requestWorkspaceAgentGuiLaunch,
              launchWorkspaceIssueManager: requestWorkspaceIssueManagerLaunch,
              launchWorkspaceFiles: requestWorkspaceFilesLaunch,
              openBrowserUrl: requestWorkspaceBrowserLaunch,
              workspaceId: input.workspaceId
            });
          },
          workspaceAgentActivityService: input.workspaceAgentActivityService,
          workspaceId: input.workspaceId
        }),
      resolveRichTextAtProviders: ({ surface, workspaceId }) =>
        input.richTextAtService.getProviders({
          capabilities: ["workspace-file"],
          surface,
          target: "issue-manager",
          workspaceId
        })
    },
    typeId: defaultIssueManagerWorkbenchTypeId
  });

  return contribution;
}

function resolveIssueManagerReadyAgentProviderOptions(
  statuses: readonly AgentProviderStatus[],
  defaultAgentProvider?: string | null
) {
  const readyProviders = new Set<WorkspaceAgentProvider>(
    statuses
      .filter((status) => status.availability.status === "ready")
      .map((status) => status.provider)
  );

  const options = workspaceAgentGuiProviders
    .filter((provider) => readyProviders.has(provider))
    .map((provider) => ({
      iconUrl: agentGuiDockIconUrls[provider],
      label: resolveWorkspaceAgentGuiLabel(provider),
      provider
    }));
  const defaultProvider = resolveDefaultAppFactoryProvider(
    options,
    defaultAgentProvider
  );
  if (!defaultProvider) {
    return options;
  }
  return [
    ...options.filter((option) => option.provider === defaultProvider),
    ...options.filter((option) => option.provider !== defaultProvider)
  ];
}
