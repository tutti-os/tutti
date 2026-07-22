import type {
  AgentActivityRuntime,
  AgentGUIProps,
  AgentHostInputApi
} from "@tutti-os/agent-gui";
import type { AgentContextMentionProvider } from "@tutti-os/agent-gui/context-mention-provider";
import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import type { RichTextTriggerProvider } from "@tutti-os/ui-rich-text/types";
import type {
  DesktopHostFilesApi,
  DesktopPlatformApi,
  DesktopRuntimeApi
} from "@preload/types";
import type { WorkspaceFileEntry } from "@tutti-os/workspace-file-manager/services";
import type { IDesktopRichTextAtService } from "@renderer/features/rich-text-at";
import type { IReporterService } from "@renderer/features/analytics";
import type { IWorkspaceFileManagerService } from "@renderer/features/workspace-file-manager";
import type { IWorkspaceFilePreviewSurfaceHost } from "@renderer/features/workspace-file-preview";
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
import { createDesktopAgentHostApi } from "./createDesktopAgentHostApi.ts";
import { createAgentChatReadyTracker } from "./internal/agentChatReadyAnalytics.ts";
import {
  createAgentGUIEngagementEventSink,
  type AgentGUIAnalyticsSurface
} from "./internal/agentGUIEngagementAnalytics.ts";
import { createAgentWorkspaceFileReferenceTracker } from "./internal/agentWorkspaceFileReferenceAnalytics.ts";
import { getDesktopAgentActivityRuntimeServices } from "./internal/desktopAgentActivityRuntimeServices.ts";
import type { IWorkspaceAgentActivityService } from "./workspaceAgentActivityService.interface";
import type { IAgentQuickPromptService } from "./agentQuickPromptService.interface.ts";
import type { IWorkspaceUserProjectService } from "../../workspace-user-project/index.ts";
import { translate } from "../../../i18n/appRuntime.ts";
import { createDesktopAgentGeneratedFileMentionProvider } from "./internal/createDesktopAgentGeneratedFileMentionProvider.ts";
import { createDesktopAgentExternalPromptFilePreparer } from "./internal/prepareDesktopAgentExternalPromptFiles.ts";
import { createDesktopAgentExternalPromptEntryResolver } from "./internal/resolveDesktopAgentExternalPromptEntries.ts";

export interface DesktopAgentGUIWorkbenchHostInput {
  agentActivityRuntime: AgentActivityRuntime;
  agentHostApi: AgentHostInputApi;
  contextMentionProviders: readonly AgentContextMentionProvider[];
  trackAgentProviderChatReady: (input: { provider: string }) => Promise<void>;
  createAgentGUIEngagementEventSink: (
    surface: AgentGUIAnalyticsSurface
  ) => NonNullable<AgentGUIProps["hostActions"]["onEngagementEvent"]>;
  trackWorkspaceFileReferences: (input: {
    provider?: string | null;
    references: readonly WorkspaceFileReference[];
  }) => Promise<void>;
  workspaceFileReferenceAdapter: NonNullable<
    AgentGUIProps["workspace"]["fileReferenceAdapter"]
  >;
  resolveExternalPromptEntries: NonNullable<
    AgentGUIProps["workspace"]["resolveExternalPromptEntries"]
  >;
  prepareExternalPromptFiles: NonNullable<
    AgentGUIProps["workspace"]["prepareExternalPromptFiles"]
  >;
  onRequestGitBranches: NonNullable<
    AgentGUIProps["workspace"]["onRequestGitBranches"]
  >;
  referenceSourceAggregator: ReferenceSourceAggregator;
  resolveWorkspaceReferenceEntryIconUrl: NonNullable<
    AgentGUIProps["workspace"]["resolveReferenceEntryIconUrl"]
  >;
  resolveMentionReferenceTarget: NonNullable<
    AgentGUIProps["workspace"]["resolveMentionReferenceTarget"]
  >;
  resolveWorkspaceReferenceInitialTarget: NonNullable<
    AgentGUIProps["workspace"]["resolveReferenceInitialTarget"]
  >;
}

export interface CreateDesktopAgentGUIWorkbenchHostInputInput {
  agentQuickPromptService?: IAgentQuickPromptService;
  agentHostApi?: AgentHostInputApi | null;
  hostFilesApi: DesktopHostFilesApi;
  tuttidClient: TuttidClient;
  platformApi: Pick<
    DesktopPlatformApi,
    "homeDirectory" | "os" | "resolveDroppedEntries"
  >;
  reporterNow?: () => number;
  reporterService?: Pick<IReporterService, "trackEvents">;
  richTextAtService: IDesktopRichTextAtService;
  runtimeApi: DesktopRuntimeApi;
  workspaceAgentActivityService: IWorkspaceAgentActivityService;
  workspaceFileManagerService?: Pick<
    IWorkspaceFileManagerService,
    "resolveEntryIconUrl"
  >;
  workspaceFilePreviewSurfaceHost?: Pick<
    IWorkspaceFilePreviewSurfaceHost,
    "present"
  >;
  workspaceUserProjectService?: IWorkspaceUserProjectService;
  workspaceId: string;
}

export function createDesktopAgentGUIWorkbenchHostInput({
  agentQuickPromptService,
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
  workspaceFilePreviewSurfaceHost,
  workspaceUserProjectService,
  workspaceId
}: CreateDesktopAgentGUIWorkbenchHostInputInput): DesktopAgentGUIWorkbenchHostInput {
  const resolvedAgentHostApi =
    agentHostApi ??
    createDesktopAgentHostApi({
      agentQuickPromptService,
      hostFilesApi,
      tuttidClient,
      platformApi,
      runtimeApi,
      workspaceAgentActivityService,
      workspaceUserProjectService,
      workspaceId
    });
  const { agentActivityRuntime } = getDesktopAgentActivityRuntimeServices({
    hostFilesApi,
    reporterNow,
    reporterService,
    runtimeApi,
    workspaceAgentActivityService,
    workspaceId,
    workspaceUserProjectService
  });
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
      presentFilePreview: workspaceFilePreviewSurfaceHost
        ? async (target, workspaceId) =>
            (await workspaceFilePreviewSurfaceHost.present(workspaceId, target))
              .presented
        : undefined,
      tuttidClient,
      workspaceId
    });
  const getLocationSections = () =>
    getCurrentDesktopWorkspaceFileLocationSections({
      homeDirectory: platformApi.homeDirectory,
      workspaceUserProjectService
    });
  const agentGeneratedFileMentionProvider =
    createDesktopAgentGeneratedFileMentionProvider({
      agentActivityRuntime,
      workspaceId
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
        projectOrder: -1,
        searchByProvenance: async (scope, searchInput) => {
          const sectionKey =
            workspaceUserProjectService
              ?.getSnapshot()
              .projects.find(
                (project) => project.path === searchInput.withinNodeId
              )
              ?.sectionKey?.trim() ?? "";
          const items = await agentGeneratedFileMentionProvider.query({
            abortSignal: searchInput.signal,
            context: {
              metadata: {
                referenceProvenanceFilter: searchInput.provenanceFilter,
                sectionKey,
                workspaceId: scope.workspaceId
              }
            },
            keyword: searchInput.query,
            trigger: "@"
          });
          return items.flatMap((item): WorkspaceFileReference[] => {
            const insert =
              agentGeneratedFileMentionProvider.toInsertResult(item);
            if (insert.kind !== "markdown-link") return [];
            return [
              {
                displayName: insert.label,
                kind: insert.href.endsWith("/") ? "folder" : "file",
                path: insert.href
              }
            ];
          });
        }
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
  const prepareExternalPromptFiles =
    createDesktopAgentExternalPromptFilePreparer({
      agentActivityRuntime,
      platformApi,
      workspaceId
    });
  const resolveExternalPromptEntries =
    createDesktopAgentExternalPromptEntryResolver({ platformApi });
  return {
    agentActivityRuntime,
    agentHostApi: resolvedAgentHostApi,
    contextMentionProviders: richTextAtService
      .getProviders({
        capabilities: [
          "file",
          "workspace-issue",
          "agent-session",
          "workspace-app",
          "agent-target"
        ],
        surface: "composer",
        target: "agent-gui",
        workspaceId
      })
      .map(richTextTriggerProviderToContextMentionProvider),
    trackAgentProviderChatReady: (input) => chatReadyTracker.track(input),
    createAgentGUIEngagementEventSink: (surface) =>
      createAgentGUIEngagementEventSink({
        reporterNow,
        reporterService,
        surface
      }),
    trackWorkspaceFileReferences: (input) =>
      workspaceFileReferenceTracker.track(input),
    workspaceFileReferenceAdapter,
    resolveExternalPromptEntries,
    prepareExternalPromptFiles,
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
    resolveWorkspaceReferenceEntryIconUrl: (entry: WorkspaceFileEntry) =>
      workspaceFileManagerService?.resolveEntryIconUrl(workspaceId, entry) ??
      Promise.resolve(null),
    resolveMentionReferenceTarget,
    resolveWorkspaceReferenceInitialTarget
  };
}

const resolveWorkspaceReferenceInitialTarget: NonNullable<
  AgentGUIProps["workspace"]["resolveReferenceInitialTarget"]
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
