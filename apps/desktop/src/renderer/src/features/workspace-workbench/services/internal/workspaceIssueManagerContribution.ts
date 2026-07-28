import { createElement } from "react";
import type { AgentGUIAgent } from "@tutti-os/agent-gui";
import { agentGuiDockIconUrls } from "@tutti-os/agent-gui/dock-icons";
import { resolveAgentGUIProviderCatalogIdentity } from "@tutti-os/agent-gui/provider-catalog";
import { createRichTextMentionHref } from "@tutti-os/ui-rich-text/core";
import type {
  AgentProviderStatus,
  TuttidClient,
  TuttidEventStreamClient,
  WorkspaceAgentProvider
} from "@tutti-os/client-tuttid-ts";
import type { I18nRuntime } from "@tutti-os/ui-i18n-runtime";
import type { DesktopLocale } from "@shared/i18n";
import issueManagerDockIconUrl from "@tutti-os/workspace-issue-manager/assets/workspace-dock-task.png";
import {
  createIssueManagerDockIconImage,
  createIssueManagerWorkbenchContribution,
  defaultIssueManagerWorkbenchTypeId
} from "@tutti-os/workspace-issue-manager/workbench";
import { resolveDefaultAppFactoryProvider } from "@tutti-os/workspace-app-center/core";
import type { IWorkspaceAppCenterService } from "@renderer/features/workspace-app-center";
import type { WorkbenchContribution } from "@tutti-os/workbench-surface";
import type {
  DesktopHostFilesApi,
  DesktopPlatformApi,
  DesktopRuntimeApi
} from "@preload/types";
import {
  createDesktopIssueManagerIdentityAdapter,
  createDesktopIssueManagerFeature,
  createDesktopIssueManagerNodeStateSource
} from "@renderer/features/workspace-issue-manager";
import type { IReporterService } from "../../../analytics/services/reporterService.interface.ts";
import {
  type AgentProviderStatusService,
  type IAgentsService,
  type IWorkspaceAgentActivityService,
  type WorkspaceAgentPromptSessionService
} from "@renderer/features/workspace-agent";
import { requestWorkspaceAgentGuiLaunch } from "@renderer/features/workspace-agent/services/workspaceAgentGuiLaunchCoordinator.ts";
import { runDesktopAgentGUILinkAction } from "@renderer/features/workspace-agent/services/desktopAgentGUILinkActions.ts";
import { normalizeDesktopAgentGUIProvider } from "@renderer/features/workspace-agent/desktopAgentGUINodeState";
import { type IDesktopRichTextAtService } from "@renderer/features/rich-text-at";
import type { IWorkspaceUserProjectService } from "@renderer/features/workspace-user-project";
import { resolveWorkspaceLinkAction } from "@contexts/workspace/presentation/renderer/actions/workspaceLinkActions.ts";
import { requestWorkspaceBrowserLaunch } from "../workspaceBrowserLaunchCoordinator.ts";
import { requestWorkspaceFilesLaunch } from "../workspaceFilesLaunchCoordinator.ts";
import { requestWorkspaceIssueManagerLaunch } from "../workspaceIssueManagerLaunchCoordinator.ts";
import { createWorkspaceIssueManagerRichTextTriggerProviderRequestFromIdentity } from "./workspaceIssueManagerRichTextTriggerProviderRequest.ts";
import { resolveWorkspaceAgentGuiLabel } from "./workspaceAgentProviderCatalog.ts";
import { renderIssueManagerLatestRunMessageCenterCard } from "../../ui/IssueManagerLatestRunMessageCenterCard.tsx";
import { workspaceTaskDockSectionId } from "./workspaceDockSections.ts";
import { registerWorkspaceIssueManagerSurfaceRuntime } from "../workspaceIssueManagerSurfaceRuntime.ts";

export function createWorkspaceIssueManagerContribution(input: {
  agentProviderStatusService: AgentProviderStatusService;
  appCenterService: IWorkspaceAppCenterService;
  defaultAgentProvider?: string | null;
  dockIconUrl?: string;
  hostFilesApi: DesktopHostFilesApi;
  i18n: I18nRuntime<string>;
  locale: DesktopLocale;
  eventStreamClient?: TuttidEventStreamClient;
  tuttidClient: TuttidClient;
  platformApi: Pick<
    DesktopPlatformApi,
    "homeDirectory" | "os" | "resolveDroppedPaths"
  >;
  agentsService: Pick<IAgentsService, "getSnapshot" | "subscribe">;
  richTextAtService: IDesktopRichTextAtService;
  runtimeApi: DesktopRuntimeApi;
  reporterService?: Pick<IReporterService, "trackEvents">;
  workspaceAgentActivityService: IWorkspaceAgentActivityService;
  workspaceAgentPromptSessionService: WorkspaceAgentPromptSessionService;
  workspaceUserProjectService: IWorkspaceUserProjectService;
  workspaceId: string;
}): WorkbenchContribution {
  const feature = createDesktopIssueManagerFeature({
    agentTargetOptions: {
      getOptions: () =>
        resolveIssueManagerReadyAgentTargetOptions(
          input.agentProviderStatusService.getSnapshot().statuses,
          input.agentsService.getSnapshot().agents,
          input.defaultAgentProvider
        ),
      subscribe: (listener) => {
        const unsubscribeProviderStatuses =
          input.agentProviderStatusService.subscribe(listener);
        const unsubscribeAgents = input.agentsService.subscribe(listener);
        return () => {
          unsubscribeProviderStatuses();
          unsubscribeAgents();
        };
      }
    },
    modelPlanOptions: {
      loadOptions: async () => {
        const response = await input.tuttidClient.listModelPlans(
          input.workspaceId
        );
        return response.plans
          .filter((plan) => plan.enabled && plan.status === "ready")
          .map((plan) => ({
            id: plan.id,
            name: plan.name,
            protocol: plan.protocol,
            ...(plan.defaultModel?.trim()
              ? { defaultModel: plan.defaultModel.trim() }
              : {}),
            models: plan.models.map((model) => ({
              id: model.id,
              name: model.name
            }))
          }));
      }
    },
    agentSessionCreator: input.workspaceAgentPromptSessionService,
    eventStreamClient: input.eventStreamClient,
    hostFilesApi: input.hostFilesApi,
    i18n: input.i18n,
    launchAgentGui: async (request) => {
      const launched = await requestWorkspaceAgentGuiLaunch({
        agentSessionId: request.agentSessionId,
        draftPrompt: request.draftPrompt,
        agentTargetId: request.agentTargetId,
        openInNewWindow: request.openInNewWindow,
        provider: normalizeDesktopAgentGUIProvider(request.provider),
        userProjectPath: request.userProjectPath,
        workspaceId: request.workspaceId
      });
      if (!launched) {
        throw new Error("issue_manager.agent_gui_launch_unavailable");
      }
    },
    mentionActionHandler: {
      openMention: async ({ mention }) => {
        const href = createRichTextMentionHref({
          providerId: mention.providerId,
          entityId: mention.entityId,
          label: mention.label,
          scope: mention.scope
        });
        if (!href) {
          return;
        }
        const action = resolveWorkspaceLinkAction({
          href,
          source: "issue-manager-description"
        });
        if (!action) {
          return;
        }
        await runDesktopAgentGUILinkAction(action, {
          getAgentSession: ({ agentSessionId, workspaceId }) =>
            input.workspaceAgentActivityService.getSession(
              workspaceId,
              agentSessionId
            ),
          homeDirectory: input.platformApi.homeDirectory,
          launchAgentGui: requestWorkspaceAgentGuiLaunch,
          launchWorkspaceIssueManager: requestWorkspaceIssueManagerLaunch,
          launchWorkspaceFiles: requestWorkspaceFilesLaunch,
          launchWorkspaceApp: async ({ appId, workspaceId }) => {
            await input.appCenterService.openApp({ appId, workspaceId });
            return true;
          },
          openBrowserUrl: requestWorkspaceBrowserLaunch,
          workspaceId: input.workspaceId
        });
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
    workspaceId: input.workspaceId
  });
  const identityAdapter = createDesktopIssueManagerIdentityAdapter();
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
      diagnostics: {
        log: (event, details) => {
          void input.runtimeApi
            .logRendererDiagnostic({
              details,
              event: `issue_manager.${event}`,
              source: "issue-manager",
              workspaceId: input.workspaceId
            })
            .catch(() => undefined);
        }
      },
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
          locale: input.locale,
          onLinkAction: (action) => {
            void runDesktopAgentGUILinkAction(action, {
              getAgentSession: ({ agentSessionId, workspaceId }) =>
                input.workspaceAgentActivityService.getSession(
                  workspaceId,
                  agentSessionId
                ),
              homeDirectory: input.platformApi.homeDirectory,
              launchAgentGui: requestWorkspaceAgentGuiLaunch,
              launchWorkspaceIssueManager: requestWorkspaceIssueManagerLaunch,
              launchWorkspaceFiles: requestWorkspaceFilesLaunch,
              launchWorkspaceApp: async ({ appId, workspaceId }) => {
                await input.appCenterService.openApp({ appId, workspaceId });
                return true;
              },
              openBrowserUrl: requestWorkspaceBrowserLaunch,
              workspaceId: input.workspaceId
            });
          },
          workspaceAgentActivityService: input.workspaceAgentActivityService,
          workspaceId: input.workspaceId
        }),
      resolveRichTextTriggerProviders: ({ surface, workspaceId }) =>
        // The neutral `DesktopRichTextAtService` already emits the enriched
        // workspace-app (localized name/description + resolved icon) and
        // agent-target (provider icon + agent metadata) providers,
        // so the issue-manager `@`-mention rows render identically to the agent
        // without this package importing any agent/desktop mention resolvers.
        input.richTextAtService.getProviders(
          createWorkspaceIssueManagerRichTextTriggerProviderRequestFromIdentity(
            {
              currentUser: () => identityAdapter.currentUser(),
              surface,
              workspaceId
            }
          )
        )
    },
    typeId: defaultIssueManagerWorkbenchTypeId
  });

  registerWorkspaceIssueManagerSurfaceRuntime(contribution, { feature });

  return contribution;
}

function resolveIssueManagerReadyAgentTargetOptions(
  statuses: readonly AgentProviderStatus[],
  agents: readonly AgentGUIAgent[] | undefined,
  defaultAgentProvider?: string | null
) {
  const readyProviders = new Set<WorkspaceAgentProvider>(
    statuses
      .filter((status) => status.availability.status === "ready")
      .map((status) => status.provider)
  );

  const options = (agents ?? [])
    .filter(
      (agent) =>
        agent.availability.status === "ready" &&
        Boolean(agent.agentTargetId.trim()) &&
        readyProviders.has(agent.provider)
    )
    .map((agent) => ({
      agentTargetId: agent.agentTargetId.trim(),
      iconUrl: agent.iconUrl || agentGuiDockIconUrls[agent.provider],
      label: agent.name.trim() || resolveWorkspaceAgentGuiLabel(agent.provider),
      provider: agent.provider,
      modelPlanProtocol:
        resolveAgentGUIProviderCatalogIdentity(agent.provider)
          ?.modelPlanProtocol || undefined
    }));
  const defaultAgentTargetId = resolveDefaultAppFactoryProvider(
    options,
    defaultAgentProvider
  );
  if (!defaultAgentTargetId) {
    return options;
  }
  return [
    ...options.filter(
      (option) => option.agentTargetId === defaultAgentTargetId
    ),
    ...options.filter((option) => option.agentTargetId !== defaultAgentTargetId)
  ];
}
