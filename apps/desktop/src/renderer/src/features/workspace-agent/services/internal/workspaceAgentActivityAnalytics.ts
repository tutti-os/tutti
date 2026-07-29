import type { AgentActivityRuntime } from "@tutti-os/agent-gui";
import type {
  AgentProviderStatusListResponse,
  WorkspaceAgentProvider
} from "@tutti-os/client-tuttid-ts";
import type { IReporterService } from "../../../analytics/services/reporterService.interface.ts";
import type { IWorkspaceUserProjectService } from "../../../workspace-user-project/index.ts";
import type { IWorkspaceAgentActivityService } from "../workspaceAgentActivityService.interface.ts";
import { promptContentDisplayText } from "../desktopAgentRuntimeSubmitDiagnostics.ts";
import { createAgentMessageSentTracker } from "./agentMessageSentAnalytics.ts";
import {
  createAgentSessionStartedTracker,
  resolveAgentSessionSource
} from "./agentSessionStartedAnalytics.ts";
import { resolveComposerPermissionMode } from "./desktopAgentHostProjection.ts";
import { AgentAvailabilitySnapshotTelemetry } from "./agentAvailabilitySnapshotTelemetry.ts";

interface WorkspaceAgentActivityAnalyticsDependencies {
  forceRefreshAgentProviderStatuses?: (
    providers: WorkspaceAgentProvider[]
  ) => Promise<AgentProviderStatusListResponse | null>;
  reporterNow?: () => number;
  reporterService?: Pick<IReporterService, "trackEvents">;
  resolveAgentTargetProvider?: (
    agentTargetId: string
  ) => WorkspaceAgentProvider | null;
  workspaceUserProjectService?: Pick<
    IWorkspaceUserProjectService,
    "isNoProjectPath"
  >;
}

export class WorkspaceAgentActivityAnalytics {
  private readonly availabilitySnapshotTelemetry: AgentAvailabilitySnapshotTelemetry;
  private readonly dependencies: WorkspaceAgentActivityAnalyticsDependencies;
  private readonly messageSentTracker: ReturnType<
    typeof createAgentMessageSentTracker
  >;
  private readonly sessionStartedTracker: ReturnType<
    typeof createAgentSessionStartedTracker
  >;

  constructor(dependencies: WorkspaceAgentActivityAnalyticsDependencies) {
    this.dependencies = dependencies;
    this.availabilitySnapshotTelemetry = new AgentAvailabilitySnapshotTelemetry(
      {
        now: dependencies.reporterNow,
        reporterService: dependencies.reporterService
      }
    );
    this.messageSentTracker = createAgentMessageSentTracker(dependencies);
    this.sessionStartedTracker = createAgentSessionStartedTracker(dependencies);
  }

  trackSessionCreateFailure(input: { agentTargetId?: string | null }): void {
    const agentTargetId = input.agentTargetId?.trim() ?? "";
    const provider = agentTargetId
      ? this.dependencies.resolveAgentTargetProvider?.(agentTargetId)
      : null;
    const forceRefresh = this.dependencies.forceRefreshAgentProviderStatuses;
    if (!provider || !forceRefresh) {
      return;
    }
    runBestEffortAnalytics(async () => {
      const response = await forceRefresh([provider]);
      const freshStatus = response?.providers.find(
        (status) => status.provider === provider
      );
      if (freshStatus) {
        this.availabilitySnapshotTelemetry.reportStatus(
          freshStatus,
          "conversation_start_failed"
        );
      }
    });
  }

  trackEngineActivation(
    input: Parameters<AgentActivityRuntime["activateSession"]>[0],
    activation: Awaited<
      ReturnType<IWorkspaceAgentActivityService["activateSession"]>
    >
  ): void {
    if (input.mode !== "new" || activation.activation.status === "failed") {
      return;
    }
    runBestEffortAnalytics(() =>
      this.sessionStartedTracker.track({
        agentSessionId: activation.session.agentSessionId,
        clientSubmitId: input.clientSubmitId,
        hasProject:
          Boolean(activation.session.cwd?.trim()) &&
          !(
            activation.session.cwd &&
            this.dependencies.workspaceUserProjectService?.isNoProjectPath(
              activation.session.cwd
            )
          ),
        model: input.settings?.model,
        permissionMode: resolveComposerPermissionMode(input.settings),
        provider: activation.session.provider,
        source: resolveAgentSessionSource({ mode: input.mode })
      })
    );
    const initialPrompt =
      input.initialDisplayPrompt?.trim() ||
      promptContentDisplayText(input.initialContent ?? []);
    if (initialPrompt) {
      runBestEffortAnalytics(() =>
        this.messageSentTracker.track({
          agentSessionId: activation.session.agentSessionId,
          clientSubmitId: input.clientSubmitId,
          prompt: initialPrompt,
          provider: activation.session.provider
        })
      );
    }
  }

  trackEngineSend(
    input: Parameters<AgentActivityRuntime["sendInput"]>[0],
    result: Awaited<ReturnType<IWorkspaceAgentActivityService["sendInput"]>>
  ): void {
    runBestEffortAnalytics(() =>
      this.messageSentTracker.track({
        agentSessionId: result.session.agentSessionId,
        clientSubmitId: input.clientSubmitId,
        isQueued: input.submitDiagnostics?.queued,
        prompt:
          input.displayPrompt?.trim() ||
          promptContentDisplayText(input.content),
        provider: result.session.provider
      })
    );
  }
}

function runBestEffortAnalytics(task: () => Promise<void>): void {
  try {
    void task().catch(() => {
      // Analytics is observational and must never fail an agent command.
    });
  } catch {
    // Keep synchronous reporter failures isolated from the command path too.
  }
}
