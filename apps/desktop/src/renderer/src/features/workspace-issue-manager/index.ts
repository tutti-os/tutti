import type {
  TuttidClient,
  TuttidEventStreamClient
} from "@tutti-os/client-tuttid-ts";
import type {
  IssueManagerAgentTargetOptionsAdapter,
  IssueManagerFileReference,
  IssueManagerModelPlanOptionsAdapter
} from "@tutti-os/workspace-issue-manager/contracts";
import type { I18nRuntime } from "@tutti-os/ui-i18n-runtime";
import {
  createIssueManagerFeature,
  type CreateIssueManagerFeatureInput
} from "@tutti-os/workspace-issue-manager";
import {
  createReferenceSourceAggregator,
  createStaticReferenceSourceRegistry
} from "@tutti-os/workspace-file-reference/core";
import type { DesktopHostFilesApi } from "@preload/types";
import { createDesktopWorkspaceFileReferenceAdapter } from "../workspace-file-manager/services/createDesktopWorkspaceFileReferenceAdapter.ts";
import {
  createAppArtifactReferenceSource,
  createIssueReferenceSource,
  createWorkspaceFileReferenceSource
} from "../agent-reference-sources/index.ts";
import { translate } from "../../i18n/appRuntime.ts";
import {
  createDesktopIssueManagerAgentBreakdownLauncher,
  createDesktopIssueManagerAgentRunner,
  type DesktopIssueManagerAgentGuiLaunchInput,
  type DesktopIssueManagerAgentSessionCreator
} from "./internal/adapters/desktopIssueManagerAgentRunner.ts";
import { createDesktopIssueManagerAnalytics } from "./internal/desktopIssueManagerAnalytics.ts";
import { createDesktopIssueManagerBackend } from "./internal/adapters/desktopIssueManagerBackend.ts";
import { createDesktopIssueManagerEventSource } from "./internal/adapters/desktopIssueManagerEventSource.ts";
import { createDesktopIssueManagerFileAdapter } from "./internal/adapters/desktopIssueManagerFileAdapter.ts";
import { createDesktopIssueManagerIdentityAdapter } from "./internal/adapters/desktopIssueManagerIdentityAdapter.ts";
import { createDesktopIssueManagerShareAdapter } from "./internal/adapters/desktopIssueManagerShareAdapter.ts";
import type { IReporterService } from "../analytics/services/reporterService.interface.ts";
import type { IWorkspaceUserProjectService } from "../workspace-user-project";
export { createDesktopIssueManagerNodeStateSource } from "./internal/desktopIssueManagerNodeState.ts";
export { createDesktopIssueManagerIdentityAdapter };

export function createDesktopIssueManagerFeature(input: {
  agentTargetOptions?: IssueManagerAgentTargetOptionsAdapter;
  modelPlanOptions?: IssueManagerModelPlanOptionsAdapter;
  agentSessionCreator?: DesktopIssueManagerAgentSessionCreator;
  hostFilesApi: DesktopHostFilesApi;
  i18n: I18nRuntime<string>;
  eventStreamClient?: TuttidEventStreamClient;
  launchAgentGui?: (
    input: DesktopIssueManagerAgentGuiLaunchInput
  ) => Promise<void> | void;
  tuttidClient: TuttidClient;
  openWorkspaceFileManager?: (
    reference: IssueManagerFileReference
  ) => Promise<boolean> | boolean;
  mentionActionHandler?: CreateIssueManagerFeatureInput["mentionActionHandler"];
  reporterNow?: () => number;
  reporterService?: Pick<IReporterService, "trackEvents">;
  workspaceUserProjectService: IWorkspaceUserProjectService;
  workspaceId: string;
}) {
  const fileAdapter = createDesktopIssueManagerFileAdapter({
    hostFilesApi: input.hostFilesApi,
    tuttidClient: input.tuttidClient,
    openWorkspaceFileManager: input.openWorkspaceFileManager,
    workspaceId: input.workspaceId
  });

  // 多源引用聚合(本地文件 + 应用产物 + Issue 引用),与 agent 对话框同一套源,
  // 让任务/事项创建编辑的引用按钮也展开统一的 ReferenceSourcePicker 面板。
  const workspaceFileReferenceAdapter =
    createDesktopWorkspaceFileReferenceAdapter({
      hostFilesApi: input.hostFilesApi,
      tuttidClient: input.tuttidClient,
      workspaceId: input.workspaceId
    });
  const referenceSourceAggregator = createReferenceSourceAggregator(
    createStaticReferenceSourceRegistry([
      createWorkspaceFileReferenceSource({
        adapter: workspaceFileReferenceAdapter,
        label: translate("workspace.referenceSources.localSourceLabel"),
        order: 0
      }),
      createAppArtifactReferenceSource({
        tuttidClient: input.tuttidClient,
        adapter: workspaceFileReferenceAdapter,
        label: translate("workspace.referenceSources.appSourceLabel"),
        order: 1
      }),
      createIssueReferenceSource({
        tuttidClient: input.tuttidClient,
        adapter: workspaceFileReferenceAdapter,
        label: translate("workspace.referenceSources.issueSourceLabel"),
        order: 2
      })
    ])
  );

  return createIssueManagerFeature({
    agentBreakdownLauncher: createDesktopIssueManagerAgentBreakdownLauncher({
      agentSessionCreator: input.agentSessionCreator,
      i18n: input.i18n,
      launchAgentGui: input.launchAgentGui,
      workspaceId: input.workspaceId
    }),
    analytics: createDesktopIssueManagerAnalytics({
      reporterNow: input.reporterNow,
      reporterService: input.reporterService
    }),
    agentTargetOptions: input.agentTargetOptions,
    modelPlanOptions: input.modelPlanOptions,
    agentRunner: createDesktopIssueManagerAgentRunner({
      agentSessionCreator: input.agentSessionCreator,
      i18n: input.i18n,
      launchAgentGui: input.launchAgentGui,
      workspaceId: input.workspaceId
    }),
    agentSessionOpener: input.launchAgentGui
      ? {
          openSession: (request) =>
            input.launchAgentGui?.({
              agentSessionId: request.agentSessionId,
              agentTargetId: request.agentTargetId,
              provider: request.provider?.trim() || "codex",
              workspaceId: request.workspaceId
            })
        }
      : undefined,
    backend: createDesktopIssueManagerBackend(input.tuttidClient),
    eventSource: input.eventStreamClient
      ? createDesktopIssueManagerEventSource(input.eventStreamClient)
      : undefined,
    executionDirectoryPicker: {
      selectDirectory: () =>
        input.workspaceUserProjectService.selectDirectory(),
      service: input.workspaceUserProjectService,
      use: (payload) =>
        input.workspaceUserProjectService.registerProjectPath(payload.path)
    },
    fileAdapter,
    i18n: input.i18n,
    identityAdapter: createDesktopIssueManagerIdentityAdapter(),
    mentionActionHandler: input.mentionActionHandler,
    referenceSourceAggregator,
    shareAdapter: createDesktopIssueManagerShareAdapter(),
    ui: {
      showInviteCollaborator: false
    }
  });
}
