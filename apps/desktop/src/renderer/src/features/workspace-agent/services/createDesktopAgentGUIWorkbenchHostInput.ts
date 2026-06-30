import type {
  AgentActivityRuntime,
  AgentQueuedPromptRuntime,
  AgentGUIProps,
  AgentHostInputApi
} from "@tutti-os/agent-gui";
import { createAgentQueuedPromptRuntime } from "@tutti-os/agent-gui/queued-prompt-runtime";
import type { AgentContextMentionProvider } from "@tutti-os/agent-gui/context-mention-provider";
import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import type { RichTextTriggerProvider } from "@tutti-os/ui-rich-text/types";
import type {
  DesktopHostFilesApi,
  DesktopPlatformApi,
  DesktopRuntimeApi
} from "@preload/types";
import type { IDesktopRichTextAtService } from "@renderer/features/rich-text-at";
import type { IReporterService } from "@renderer/features/analytics";
import type { IWorkspaceFileManagerService } from "@renderer/features/workspace-file-manager";
import type { WorkspaceFileReference } from "@tutti-os/workspace-file-reference/contracts";
import {
  createReferenceSourceAggregator,
  createStaticReferenceSourceRegistry,
  type ReferenceSourceAggregator
} from "@tutti-os/workspace-file-reference/core";
import { createDesktopWorkspaceFileReferenceAdapter } from "../../workspace-file-manager/services/createDesktopWorkspaceFileReferenceAdapter.ts";
import {
  USER_PROJECT_REFERENCE_SOURCE_ID,
  createAppArtifactReferenceSource,
  createIssueReferenceSource,
  WORKSPACE_FILE_SOURCE_ID,
  createWorkspaceFileLocationReferenceSources,
  resolveMentionReferenceTarget
} from "../../agent-reference-sources/index.ts";
import {
  DESKTOP_WORKSPACE_FILE_HOME_LOCATION_ID,
  getCurrentDesktopWorkspaceFileLocationSections,
  resolveDesktopWorkspaceFileDefaultLocationId
} from "../../workspace-file-manager/services/desktopWorkspaceFileLocations.ts";
import { createDesktopAgentActivityRuntime } from "./createDesktopAgentActivityRuntime.ts";
import { createDesktopAgentHostApi } from "./createDesktopAgentHostApi.ts";
import { createAgentChatReadyTracker } from "./internal/agentChatReadyAnalytics.ts";
import { createAgentWorkspaceFileReferenceTracker } from "./internal/agentWorkspaceFileReferenceAnalytics.ts";
import type { IWorkspaceAgentActivityService } from "./workspaceAgentActivityService.interface";
import type { IWorkspaceUserProjectService } from "../../workspace-user-project/index.ts";
import { translate } from "../../../i18n/appRuntime.ts";

export interface DesktopAgentGUIWorkbenchHostInput {
  agentActivityRuntime: AgentActivityRuntime;
  agentQueuedPromptRuntime: AgentQueuedPromptRuntime;
  agentHostApi: AgentHostInputApi;
  contextMentionProviders: NonNullable<
    AgentGUIProps["contextMentionProviders"]
  >;
  trackAgentProviderChatReady: (input: { provider: string }) => Promise<void>;
  trackWorkspaceFileReferences: (input: {
    provider?: string | null;
    references: readonly WorkspaceFileReference[];
  }) => Promise<void>;
  workspaceFileReferenceAdapter: NonNullable<
    AgentGUIProps["workspaceFileReferenceAdapter"]
  >;
  onRequestGitBranches: NonNullable<AgentGUIProps["onRequestGitBranches"]>;
  referenceSourceAggregator: ReferenceSourceAggregator;
  resolveMentionReferenceTarget: NonNullable<
    AgentGUIProps["resolveMentionReferenceTarget"]
  >;
  resolveWorkspaceReferenceInitialTarget: NonNullable<
    AgentGUIProps["resolveWorkspaceReferenceInitialTarget"]
  >;
}

export interface CreateDesktopAgentGUIWorkbenchHostInputInput {
  agentHostApi?: AgentHostInputApi | null;
  hostFilesApi: DesktopHostFilesApi;
  tuttidClient: TuttidClient;
  platformApi: Pick<
    DesktopPlatformApi,
    "homeDirectory" | "os" | "resolveDroppedEntries" | "resolveDroppedPaths"
  >;
  reporterNow?: () => number;
  reporterService?: Pick<IReporterService, "trackEvents">;
  richTextAtService: IDesktopRichTextAtService;
  runtimeApi: DesktopRuntimeApi;
  workspaceAgentActivityService: IWorkspaceAgentActivityService;
  workspaceFileManagerService?: Pick<
    IWorkspaceFileManagerService,
    "openCanvasFilePreview"
  >;
  workspaceUserProjectService?: IWorkspaceUserProjectService;
  workspaceId: string;
}

export function createDesktopAgentGUIWorkbenchHostInput({
  agentHostApi,
  hostFilesApi,
  tuttidClient,
  platformApi,
  reporterNow,
  reporterService,
  richTextAtService,
  runtimeApi,
  workspaceAgentActivityService,
  workspaceFileManagerService,
  workspaceUserProjectService,
  workspaceId
}: CreateDesktopAgentGUIWorkbenchHostInputInput): DesktopAgentGUIWorkbenchHostInput {
  const resolvedAgentHostApi =
    agentHostApi ??
    createDesktopAgentHostApi({
      hostFilesApi,
      tuttidClient,
      platformApi,
      reporterNow,
      reporterService,
      runtimeApi,
      workspaceAgentActivityService,
      workspaceUserProjectService,
      workspaceId
    });
  const warmupOpenclawGateway = resolvedAgentHostApi.runtime
    ?.warmupOpenclawGateway
    ? (
        input?: Parameters<
          NonNullable<AgentActivityRuntime["warmupOpenclawGateway"]>
        >[0]
      ) =>
        resolvedAgentHostApi.runtime?.warmupOpenclawGateway?.(
          input
        ) as ReturnType<
          NonNullable<AgentActivityRuntime["warmupOpenclawGateway"]>
        >
    : undefined;
  const agentActivityRuntime = createDesktopAgentActivityRuntime(
    workspaceAgentActivityService,
    {
      reporterNow,
      reporterService,
      runtimeApi,
      warmupOpenclawGateway,
      workspaceUserProjectService
    }
  );
  const agentQueuedPromptRuntime = createAgentQueuedPromptRuntime();
  const workspaceFileReferenceTracker =
    createAgentWorkspaceFileReferenceTracker({
      reporterNow,
      reporterService
    });
  const chatReadyTracker = createAgentChatReadyTracker({
    reporterNow,
    reporterService
  });
  const workspaceFileReferenceAdapter =
    createDesktopWorkspaceFileReferenceAdapter({
      hostFilesApi,
      openCanvasFilePreview: workspaceFileManagerService
        ? (target, workspaceId) =>
            workspaceFileManagerService.openCanvasFilePreview(
              workspaceId,
              target
            )
        : undefined,
      tuttidClient,
      workspaceId
    });
  const getLocationSections = () =>
    getCurrentDesktopWorkspaceFileLocationSections({
      homeDirectory: platformApi.homeDirectory,
      workspaceUserProjectService
    });
  // 多源引用聚合:项目快捷入口 + 本地文件 + 应用产物 + 任务产物。
  // 非本地源的 open/preview 复用本地 adapter 同一条 host 链路。
  const referenceSourceAggregator = createReferenceSourceAggregator(
    createStaticReferenceSourceRegistry([
      ...createWorkspaceFileLocationReferenceSources({
        adapter: workspaceFileReferenceAdapter,
        getLocationSections,
        localLabel: translate("workspace.referenceSources.localSourceLabel"),
        localOrder: 0,
        projectLabel: translate(
          "workspace.referenceSources.projectSourceLabel"
        ),
        projectOrder: -1
      }),
      createAppArtifactReferenceSource({
        tuttidClient,
        adapter: workspaceFileReferenceAdapter,
        label: translate("workspace.referenceSources.appSourceLabel"),
        order: 1
      }),
      createIssueReferenceSource({
        tuttidClient,
        adapter: workspaceFileReferenceAdapter,
        label: translate("workspace.referenceSources.issueSourceLabel"),
        order: 2
      })
    ])
  );
  return {
    agentActivityRuntime,
    agentQueuedPromptRuntime,
    agentHostApi: resolvedAgentHostApi,
    contextMentionProviders: richTextAtService
      .getProviders({
        capabilities: [
          "file",
          "workspace-issue",
          "agent-session",
          "workspace-app"
        ],
        surface: "composer",
        target: "agent-gui",
        workspaceId
      })
      .map(richTextTriggerProviderToContextMentionProvider),
    trackAgentProviderChatReady: (input) => chatReadyTracker.track(input),
    trackWorkspaceFileReferences: (input) =>
      workspaceFileReferenceTracker.track(input),
    workspaceFileReferenceAdapter,
    onRequestGitBranches: async ({ agentSessionId, workingDirectory }) => {
      const result = agentSessionId
        ? await tuttidClient.listWorkspaceAgentSessionGitBranches(
            workspaceId,
            agentSessionId
          )
        : workingDirectory
          ? await tuttidClient.listWorkspaceGitBranches(
              workspaceId,
              workingDirectory
            )
          : { branches: [] as string[], currentBranch: null };
      return {
        branches: result.branches,
        currentBranch: result.currentBranch ?? null
      };
    },
    referenceSourceAggregator,
    resolveMentionReferenceTarget,
    resolveWorkspaceReferenceInitialTarget
  };
}

const resolveWorkspaceReferenceInitialTarget: NonNullable<
  AgentGUIProps["resolveWorkspaceReferenceInitialTarget"]
> = ({ activeConversation, composerSelectedProjectPath, userProjects }) => {
  const activeConversationProject = findUserProjectByIdentity(
    userProjects,
    activeConversation?.project
  );
  const locationId = resolveDesktopWorkspaceFileDefaultLocationId({
    composerSelectedProjectPath,
    preferredProject: activeConversationProject,
    projects: userProjects
  });
  if (locationId === DESKTOP_WORKSPACE_FILE_HOME_LOCATION_ID) {
    const params: Record<string, string> = { locationId };
    return {
      sourceId: WORKSPACE_FILE_SOURCE_ID,
      params
    };
  }
  const project =
    activeConversationProject ??
    findUserProjectByPath(userProjects, composerSelectedProjectPath) ??
    userProjects[0] ??
    null;
  const params: Record<string, string> = {
    projectId: project?.id ?? "",
    projectPath: project?.path ?? ""
  };
  return {
    sourceId: USER_PROJECT_REFERENCE_SOURCE_ID,
    params
  };
};

function findUserProjectByIdentity<
  T extends {
    id?: string | null;
    path: string;
  }
>(
  projects: readonly T[],
  project:
    | {
        id?: string | null;
        path?: string | null;
      }
    | null
    | undefined
): T | null {
  if (!project) {
    return null;
  }
  if (project.id) {
    const byId = projects.find((candidate) => candidate.id === project.id);
    if (byId) {
      return byId;
    }
  }
  return findUserProjectByPath(projects, project.path);
}

function findUserProjectByPath<
  T extends {
    path: string;
  }
>(projects: readonly T[], path: string | null | undefined): T | null {
  const normalizedPath = normalizeProjectPath(path);
  if (!normalizedPath) {
    return null;
  }
  return (
    projects.find(
      (project) => normalizeProjectPath(project.path) === normalizedPath
    ) ?? null
  );
}

function normalizeProjectPath(path: string | null | undefined): string {
  return path?.trim().replaceAll("\\", "/").replace(/\/+$/, "") ?? "";
}

function richTextTriggerProviderToContextMentionProvider(
  provider: RichTextTriggerProvider
): AgentContextMentionProvider {
  return {
    ...provider,
    trigger: "@"
  };
}
