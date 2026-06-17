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
import type { IDesktopRichTextAtService } from "@renderer/features/rich-text-at";
import type { IReporterService } from "@renderer/features/analytics";
import type { WorkspaceFileReference } from "@tutti-os/workspace-file-reference/contracts";
import {
  createReferenceSourceAggregator,
  createStaticReferenceSourceRegistry,
  type ReferenceSourceAggregator
} from "@tutti-os/workspace-file-reference/core";
import { createDesktopWorkspaceFileReferenceAdapter } from "../../workspace-file-manager/services/createDesktopWorkspaceFileReferenceAdapter.ts";
import {
  createAppArtifactReferenceSource,
  createIssueReferenceSource,
  createWorkspaceFileReferenceSource
} from "../../agent-reference-sources/index.ts";
import { createDesktopAgentActivityRuntime } from "./createDesktopAgentActivityRuntime.ts";
import { createDesktopAgentHostApi } from "./createDesktopAgentHostApi.ts";
import { createAgentWorkspaceFileReferenceTracker } from "./internal/agentWorkspaceFileReferenceAnalytics.ts";
import type { IWorkspaceAgentActivityService } from "./workspaceAgentActivityService.interface";
import type { IWorkspaceUserProjectService } from "../../workspace-user-project/index.ts";
import { translate } from "../../../i18n/appRuntime.ts";

export interface DesktopAgentGUIWorkbenchHostInput {
  agentActivityRuntime: AgentActivityRuntime;
  agentHostApi: AgentHostInputApi;
  contextMentionProviders: NonNullable<
    AgentGUIProps["contextMentionProviders"]
  >;
  trackWorkspaceFileReferences: (input: {
    provider?: string | null;
    references: readonly WorkspaceFileReference[];
  }) => Promise<void>;
  workspaceFileReferenceAdapter: NonNullable<
    AgentGUIProps["workspaceFileReferenceAdapter"]
  >;
  onRequestGitBranches: NonNullable<AgentGUIProps["onRequestGitBranches"]>;
  referenceSourceAggregator: ReferenceSourceAggregator;
}

export interface CreateDesktopAgentGUIWorkbenchHostInputInput {
  agentHostApi?: AgentHostInputApi | null;
  hostFilesApi: DesktopHostFilesApi;
  tuttidClient: TuttidClient;
  platformApi: Pick<
    DesktopPlatformApi,
    "homeDirectory" | "os" | "resolveDroppedPaths"
  >;
  reporterNow?: () => number;
  reporterService?: Pick<IReporterService, "trackEvents">;
  richTextAtService: IDesktopRichTextAtService;
  runtimeApi: DesktopRuntimeApi;
  workspaceAgentActivityService: IWorkspaceAgentActivityService;
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
  const workspaceFileReferenceTracker =
    createAgentWorkspaceFileReferenceTracker({
      reporterNow,
      reporterService
    });
  const workspaceFileReferenceAdapter =
    createDesktopWorkspaceFileReferenceAdapter({
      hostFilesApi,
      tuttidClient,
      workspaceId
    });
  // 多源引用聚合:本地文件 + 应用产物(任务产物为将来一个新源)。
  // 应用源的 open/preview 复用本地 adapter 同一条 host 链路。
  const referenceSourceAggregator = createReferenceSourceAggregator(
    createStaticReferenceSourceRegistry([
      createWorkspaceFileReferenceSource({
        adapter: workspaceFileReferenceAdapter,
        label: translate("workspace.referenceSources.localSourceLabel"),
        order: 0
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
    referenceSourceAggregator
  };
}

function richTextTriggerProviderToContextMentionProvider(
  provider: RichTextTriggerProvider
): AgentContextMentionProvider {
  return {
    ...provider,
    trigger: "@"
  };
}
