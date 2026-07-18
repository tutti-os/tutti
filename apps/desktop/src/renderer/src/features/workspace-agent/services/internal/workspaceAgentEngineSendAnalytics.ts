import type { AgentActivityRuntime } from "@tutti-os/agent-gui";
import type { IReporterService } from "../../../analytics/services/reporterService.interface.ts";
import type { IWorkspaceUserProjectService } from "../../../workspace-user-project/index.ts";
import type { IWorkspaceAgentActivityService } from "../workspaceAgentActivityService.interface.ts";
import { promptContentDisplayText } from "../desktopAgentRuntimeSubmitDiagnostics.ts";
import { createAgentMessageSentTracker } from "./agentMessageSentAnalytics.ts";
import { createAgentMessageStoppedTracker } from "./agentMessageStoppedAnalytics.ts";
import {
  createAgentSessionStartedTracker,
  resolveAgentSessionSource
} from "./agentSessionStartedAnalytics.ts";
import {
  AgentAnalyticsErrorCode,
  createAgentNodeResultTracker,
  safeTrackAgentNodeResult
} from "./agentNodeResultAnalytics.ts";
import { resolveComposerPermissionMode } from "./desktopAgentHostProjection.ts";

type ActivateSessionInput = Parameters<
  AgentActivityRuntime["activateSession"]
>[0];
type ActivateSessionResult = Awaited<
  ReturnType<IWorkspaceAgentActivityService["activateSession"]>
>;
type SendInputInput = Parameters<
  IWorkspaceAgentActivityService["sendInput"]
>[0];
type SendInputResult = Awaited<
  ReturnType<IWorkspaceAgentActivityService["sendInput"]>
>;

export interface WorkspaceAgentEngineSendAnalytics {
  trackSessionActivateFailed(
    input: ActivateSessionInput,
    error: unknown
  ): Promise<void>;
  trackSessionActivated(
    input: ActivateSessionInput,
    activation: ActivateSessionResult
  ): Promise<void>;
  trackSendInputFailed(input: SendInputInput, error: unknown): Promise<void>;
  trackSendInputResolved(
    input: SendInputInput,
    result: SendInputResult
  ): Promise<void>;
  trackTurnCanceled(input: {
    agentSessionId: string;
    provider: string | null | undefined;
  }): Promise<void>;
}

/**
 * Business-funnel analytics for the session-engine send boundary. The engine
 * command port dispatches session/activate and queue/sendPrompt straight to
 * WorkspaceAgentActivityService, bypassing createDesktopAgentActivityRuntime
 * where agent.session_started / agent.message_sent were historically reported,
 * so those events (and their renderer node_result probes) must be reported
 * here to keep parity with the pre-engine funnel.
 */
export function createWorkspaceAgentEngineSendAnalytics(input: {
  reporterNow?: () => number;
  reporterService?: Pick<IReporterService, "trackEvents">;
  workspaceUserProjectService?: Pick<
    IWorkspaceUserProjectService,
    "isNoProjectPath"
  >;
}): WorkspaceAgentEngineSendAnalytics {
  const messageSentTracker = createAgentMessageSentTracker({
    reporterNow: input.reporterNow,
    reporterService: input.reporterService
  });
  const messageStoppedTracker = createAgentMessageStoppedTracker({
    reporterNow: input.reporterNow,
    reporterService: input.reporterService
  });
  const sessionStartedTracker = createAgentSessionStartedTracker({
    reporterNow: input.reporterNow,
    reporterService: input.reporterService
  });
  const nodeResultTracker = createAgentNodeResultTracker({
    reporterNow: input.reporterNow,
    reporterService: input.reporterService
  });
  const sessionHasProject = (cwd: string | null | undefined): boolean =>
    Boolean(cwd?.trim()) &&
    !(cwd && input.workspaceUserProjectService?.isNoProjectPath(cwd));
  return {
    async trackSessionActivateFailed(activateInput, error) {
      await safeTrackAgentNodeResult(nodeResultTracker, {
        agentSessionId: activateInput.agentSessionId,
        error,
        fallbackErrorCode:
          activateInput.mode === "existing"
            ? AgentAnalyticsErrorCode.SessionResumeFailed
            : AgentAnalyticsErrorCode.SessionCreateFailed,
        flow: "session_create",
        node: "activate_session",
        provider: null,
        success: false
      });
    },
    async trackSessionActivated(activateInput, activation) {
      const activationFailed = activation.activation.status === "failed";
      await safeTrackAgentNodeResult(nodeResultTracker, {
        agentSessionId: activation.session.agentSessionId,
        error: activationFailed
          ? (activation.error?.message ??
            activation.error?.code ??
            "Agent session activation failed.")
          : undefined,
        fallbackErrorCode:
          activateInput.mode === "existing"
            ? AgentAnalyticsErrorCode.SessionResumeFailed
            : AgentAnalyticsErrorCode.SessionCreateFailed,
        flow: "session_create",
        node: "activate_session",
        provider: activation.session.provider,
        success: !activationFailed
      });
      if (activateInput.mode !== "new" || activationFailed) {
        return;
      }
      await sessionStartedTracker.track({
        agentSessionId: activation.session.agentSessionId,
        hasProject: sessionHasProject(activation.session.cwd),
        model: activateInput.settings?.model,
        permissionMode: resolveComposerPermissionMode(activateInput.settings),
        provider: activation.session.provider,
        source: resolveAgentSessionSource({ mode: activateInput.mode })
      });
      await safeTrackAgentNodeResult(nodeResultTracker, {
        agentSessionId: activation.session.agentSessionId,
        flow: "session_create",
        node: "session_started_reported",
        provider: activation.session.provider,
        success: true
      });
      const initialPrompt = promptContentDisplayText(
        activateInput.initialContent ?? []
      );
      if (!initialPrompt) {
        return;
      }
      await messageSentTracker.track({
        agentSessionId: activation.session.agentSessionId,
        prompt: initialPrompt,
        provider: activation.session.provider
      });
      await safeTrackAgentNodeResult(nodeResultTracker, {
        agentSessionId: activation.session.agentSessionId,
        flow: "session_create",
        node: "message_sent_reported",
        provider: activation.session.provider,
        success: true
      });
    },
    async trackSendInputFailed(sendInput, error) {
      await safeTrackAgentNodeResult(nodeResultTracker, {
        agentSessionId: sendInput.agentSessionId,
        error,
        fallbackErrorCode: AgentAnalyticsErrorCode.RuntimeExecFailed,
        flow: "message_send",
        node: "send_input_request",
        provider: null,
        success: false
      });
    },
    async trackSendInputResolved(sendInput, result) {
      await safeTrackAgentNodeResult(nodeResultTracker, {
        agentSessionId: result.session.agentSessionId,
        flow: "message_send",
        node: "send_input_request",
        provider: result.session.provider,
        success: true
      });
      await messageSentTracker.track({
        agentSessionId: result.session.agentSessionId,
        isQueued: sendInput.submitDiagnostics?.queued === true,
        prompt: promptContentDisplayText(sendInput.content),
        provider: result.session.provider
      });
      await safeTrackAgentNodeResult(nodeResultTracker, {
        agentSessionId: result.session.agentSessionId,
        flow: "message_send",
        node: "message_sent_reported",
        provider: result.session.provider,
        success: true
      });
    },
    async trackTurnCanceled(cancelInput) {
      await messageStoppedTracker.track({
        agentSessionId: cancelInput.agentSessionId,
        provider: cancelInput.provider ?? ""
      });
    }
  };
}
