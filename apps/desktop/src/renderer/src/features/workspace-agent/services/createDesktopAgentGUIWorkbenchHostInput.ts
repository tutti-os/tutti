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
import { createDesktopWorkspaceFileReferenceAdapter } from "../../workspace-file-manager/services/createDesktopWorkspaceFileReferenceAdapter.ts";
import { createDesktopAgentActivityRuntime } from "./createDesktopAgentActivityRuntime.ts";
import { createDesktopAgentHostApi } from "./createDesktopAgentHostApi.ts";
import { createAgentWorkspaceFileReferenceTracker } from "./internal/agentWorkspaceFileReferenceAnalytics.ts";
import type { IWorkspaceAgentActivityService } from "./workspaceAgentActivityService.interface";
import type { IWorkspaceUserProjectService } from "../../workspace-user-project/index.ts";

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
    workspaceFileReferenceAdapter: createDesktopWorkspaceFileReferenceAdapter({
      hostFilesApi,
      tuttidClient,
      workspaceId
    }),
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
    }
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
