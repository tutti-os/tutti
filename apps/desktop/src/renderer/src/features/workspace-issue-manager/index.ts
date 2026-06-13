import type {
  TuttidClient,
  TuttidEventStreamClient
} from "@tutti-os/client-tuttid-ts";
import type {
  IssueManagerAgentProviderOptionsAdapter,
  IssueManagerFileReference
} from "@tutti-os/workspace-issue-manager/contracts";
import type { I18nRuntime } from "@tutti-os/ui-i18n-runtime";
import { createIssueManagerFeature } from "@tutti-os/workspace-issue-manager";
import type { DesktopHostFilesApi } from "@preload/types";
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

export function createDesktopIssueManagerFeature(input: {
  agentProviderOptions?: IssueManagerAgentProviderOptionsAdapter;
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
    agentProviderOptions: input.agentProviderOptions,
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
    shareAdapter: createDesktopIssueManagerShareAdapter(),
    ui: {
      showInviteCollaborator: false
    }
  });
}
