import type { AgentHostInputApi } from "@tutti-os/agent-gui";
import type { AgentActivitySendInput } from "@tutti-os/agent-activity-core";
import type { DesktopRuntimeApi } from "@preload/types";
import {
  normalizeComposerSettings,
  resolveComposerPermissionMode,
  resolveDesktopAgentGUIProvider,
  stringifyError,
  toAgentHostAgentSessionFromCore,
  toAgentHostAgentSessionStatus,
  type AgentHostAgentSessionComposerSettings
} from "./desktopAgentHostProjection.ts";
import {
  resolveAgentSessionStateDefaults,
  type DesktopAgentHostWorkspaceState
} from "./desktopAgentHostWorkspaceState.ts";
import {
  createAgentMessageSentTracker,
  createOptionalReporterService
} from "./agentMessageSentAnalytics.ts";
import { createAgentMessageStoppedTracker } from "./agentMessageStoppedAnalytics.ts";
import {
  createAgentSessionStartedTracker,
  resolveAgentSessionSource
} from "./agentSessionStartedAnalytics.ts";
import { AgentConversationPinnedReporter } from "../../../analytics/reporters/agent-conversation-pinned/agentConversationPinnedReporter.ts";
import { AgentConversationUnpinnedReporter } from "../../../analytics/reporters/agent-conversation-unpinned/agentConversationUnpinnedReporter.ts";
import { AgentSettingsProjectChangedReporter } from "../../../analytics/reporters/agent-settings-project-changed/agentSettingsProjectChangedReporter.ts";
import { ErrorAgentSessionFailedReporter } from "../../../analytics/reporters/error-agent-session-failed/errorAgentSessionFailedReporter.ts";
import {
  agentAnalyticsErrorFields,
  AgentAnalyticsErrorCode
} from "../../../analytics/reporters/agent-error-fields.ts";
import type { IReporterService } from "../../../analytics/services/reporterService.interface.ts";
import type { IWorkspaceAgentActivityService } from "../workspaceAgentActivityService.interface.ts";
import { reportAgentSessionSettingsChanges } from "./agentSessionSettingsAnalytics.ts";
import type { IWorkspaceUserProjectService } from "../../../workspace-user-project/index.ts";
import {
  createAgentNodeResultTracker,
  safeTrackAgentNodeResult
} from "./agentNodeResultAnalytics.ts";

export type AgentSessionEventListener = (event: unknown) => void;

interface CreateDesktopAgentHostAgentSessionsApiInput {
  agentActivityService: IWorkspaceAgentActivityService;
  reporterNow?: () => number;
  reporterService?: Pick<IReporterService, "trackEvents">;
  runtimeApi: DesktopRuntimeApi;
  sessionEventListeners: Set<AgentSessionEventListener>;
  workspaceUserProjectService: IWorkspaceUserProjectService;
  workspaceId: string;
  workspaceState: DesktopAgentHostWorkspaceState;
}

export function createDesktopAgentHostAgentSessionsApi({
  agentActivityService,
  reporterNow,
  reporterService,
  runtimeApi,
  sessionEventListeners,
  workspaceUserProjectService,
  workspaceId,
  workspaceState
}: CreateDesktopAgentHostAgentSessionsApiInput): NonNullable<
  AgentHostInputApi["agentSessions"]
> {
  interface RetainedAgentSessionEventStreamLease {
    refCount: number;
    release: () => void;
  }

  const retainedEventStreamLeases = new Map<
    string,
    RetainedAgentSessionEventStreamLease
  >();
  const messageSentTracker = createAgentMessageSentTracker({
    reporterNow,
    reporterService
  });
  const messageStoppedTracker = createAgentMessageStoppedTracker({
    reporterNow,
    reporterService
  });
  const sessionStartedTracker = createAgentSessionStartedTracker({
    reporterNow,
    reporterService
  });
  const nodeResultTracker = createAgentNodeResultTracker({
    reporterNow,
    reporterService
  });

  const agentSessions = {
    async activate(payload: {
      agentSessionId: string;
      agentTargetId?: string | null;
      cwd?: string;
      initialContent?: AgentActivitySendInput["content"];
      metadata?: Record<string, unknown>;
      mode: "existing" | "new";
      provider?: string;
      settings?: {
        model?: string | null;
        permissionModeId?: string | null;
        planMode?: boolean | null;
        reasoningEffort?: string | null;
        speed?: string | null;
      };
      source?: string;
      title?: string;
      visible?: boolean;
    }) {
      const flow = "session_create" as const;
      const node = "activate_session" as const;
      const fallbackErrorCode =
        payload.mode === "existing"
          ? AgentAnalyticsErrorCode.SessionResumeFailed
          : AgentAnalyticsErrorCode.SessionCreateFailed;
      let activation: Awaited<
        ReturnType<IWorkspaceAgentActivityService["activateSession"]>
      >;
      const provider = resolveDesktopAgentGUIProvider(payload.provider);
      const agentTargetId =
        normalizeAgentTargetId(payload.agentTargetId) ??
        (payload.mode === "new"
          ? localAgentTargetIdForProvider(provider)
          : null);
      try {
        activation = await agentActivityService.activateSession({
          ...payload,
          ...(agentTargetId ? { agentTargetId } : {}),
          provider,
          settings: payload.settings
            ? normalizeComposerSettings(payload.settings)
            : undefined,
          workspaceId
        });
      } catch (error) {
        await safeTrackAgentNodeResult(nodeResultTracker, {
          agentSessionId: payload.agentSessionId,
          error,
          fallbackErrorCode,
          flow,
          node,
          provider,
          success: false
        });
        throw error;
      }
      const activationFailed = activation.activation.status === "failed";
      if (activationFailed) {
        const activationError = activation.error?.message
          ? activation.error.message
          : activation.error?.code
            ? activation.error.code
            : "Agent session activation failed.";
        const errorFields = agentAnalyticsErrorFields(
          activationError,
          fallbackErrorCode
        );
        await safeTrackAgentNodeResult(nodeResultTracker, {
          agentSessionId: activation.session.agentSessionId,
          error: activationError,
          fallbackErrorCode,
          flow,
          node,
          provider: activation.session.provider,
          success: false
        });
        await new ErrorAgentSessionFailedReporter(
          {
            agentSessionId: activation.session.agentSessionId,
            ...errorFields,
            isRetryable: false,
            provider: activation.session.provider
          },
          {
            reporterService: createOptionalReporterService(reporterService),
            now: reporterNow
          }
        ).report();
      }
      if (payload.mode === "new" && !activationFailed) {
        await safeTrackAgentNodeResult(nodeResultTracker, {
          agentSessionId: activation.session.agentSessionId,
          flow,
          node,
          provider: activation.session.provider,
          success: true
        });
        const activationCwd = activation.session.cwd?.trim() ?? "";
        await sessionStartedTracker.track({
          agentSessionId: activation.session.agentSessionId,
          hasProject:
            Boolean(activationCwd) &&
            !workspaceUserProjectService.isNoProjectPath(activationCwd),
          model: payload.settings?.model,
          permissionMode: resolveComposerPermissionMode(payload.settings),
          provider: activation.session.provider,
          source: resolveAgentSessionSource(payload)
        });
        await safeTrackAgentNodeResult(nodeResultTracker, {
          agentSessionId: activation.session.agentSessionId,
          flow,
          node: "session_started_reported",
          provider: activation.session.provider,
          success: true
        });
        const initialPrompt = promptContentDisplayText(
          payload.initialContent ?? []
        );
        if (initialPrompt) {
          await messageSentTracker.track({
            agentSessionId: activation.session.agentSessionId,
            prompt: initialPrompt,
            provider: activation.session.provider
          });
          await safeTrackAgentNodeResult(nodeResultTracker, {
            agentSessionId: activation.session.agentSessionId,
            flow,
            node: "message_sent_reported",
            provider: activation.session.provider,
            success: true
          });
        }
      } else if (!activationFailed) {
        await safeTrackAgentNodeResult(nodeResultTracker, {
          agentSessionId: activation.session.agentSessionId,
          flow,
          node,
          provider: activation.session.provider,
          success: true
        });
      }
      return activation;
    },
    unactivate(payload: { agentSessionId: string }) {
      return agentActivityService.unactivateSession({
        ...payload,
        workspaceId
      });
    },
    async exec(payload: {
      agentSessionId: string;
      content: AgentActivitySendInput["content"];
      metadata?: Record<string, unknown>;
    }) {
      const tuttidSessionId = resolveTuttidSessionId(payload.agentSessionId);
      let result: Awaited<
        ReturnType<IWorkspaceAgentActivityService["sendInput"]>
      >;
      try {
        result = await agentActivityService.sendInput({
          workspaceId,
          agentSessionId: tuttidSessionId,
          content: [...payload.content],
          ...(payload.metadata ? { metadata: payload.metadata } : {})
        });
      } catch (error) {
        await safeTrackAgentNodeResult(nodeResultTracker, {
          agentSessionId: tuttidSessionId,
          error,
          fallbackErrorCode: AgentAnalyticsErrorCode.RuntimeExecFailed,
          flow: "message_send",
          node: "send_input_request",
          provider: null,
          success: false
        });
        throw error;
      }
      await safeTrackAgentNodeResult(nodeResultTracker, {
        agentSessionId: result.session.agentSessionId,
        flow: "message_send",
        node: "send_input_request",
        provider: result.session.provider,
        success: true
      });
      await messageSentTracker.track({
        agentSessionId: result.session.agentSessionId,
        prompt: promptContentDisplayText(payload.content),
        provider: result.session.provider
      });
      await safeTrackAgentNodeResult(nodeResultTracker, {
        agentSessionId: result.session.agentSessionId,
        flow: "message_send",
        node: "message_sent_reported",
        provider: result.session.provider,
        success: true
      });
      return {
        accepted: true,
        agentSessionId: result.session.agentSessionId,
        sessionStatus: toAgentHostAgentSessionStatus(result.session.status),
        status: "started"
      };
    },
    async cancel(payload: { agentSessionId: string }) {
      const tuttidSessionId = resolveTuttidSessionId(payload.agentSessionId);
      const result = await agentActivityService.cancelSession({
        workspaceId,
        agentSessionId: tuttidSessionId
      });
      if (result.canceled) {
        await messageStoppedTracker.track({
          agentSessionId: result.session.agentSessionId,
          provider: result.session.provider
        });
      }
      return {
        agentSessionId: result.session.agentSessionId,
        canceled: result.canceled,
        reason: result.reason,
        sessionStatus: toAgentHostAgentSessionStatus(result.session.status)
      };
    },
    async updateSettings(payload: {
      agentSessionId: string;
      settings: AgentHostAgentSessionComposerSettings;
    }) {
      const previousSettings = resolveAgentSessionStateDefaults(
        workspaceState,
        payload.agentSessionId
      )?.settings;
      const tuttidSessionId = resolveTuttidSessionId(payload.agentSessionId);
      const previousState = await agentActivityService.getSessionControlState({
        workspaceId,
        agentSessionId: tuttidSessionId
      });
      const result = await agentActivityService.updateSessionSettings({
        workspaceId,
        agentSessionId: tuttidSessionId,
        settings: payload.settings
      });
      await reportAgentSessionSettingsChanges({
        agentSessionId: result.agentSessionId,
        nextSettings: result.settings,
        previousSettings,
        provider: previousState.provider,
        reporterNow,
        reporterService
      });
      return result;
    },
    async pinSession(payload: { agentSessionId: string; pinned: boolean }) {
      const tuttidSessionId = resolveTuttidSessionId(payload.agentSessionId);
      const session = await agentActivityService.setSessionPinned({
        workspaceId,
        agentSessionId: tuttidSessionId,
        pinned: payload.pinned
      });
      const reporter = payload.pinned
        ? AgentConversationPinnedReporter
        : AgentConversationUnpinnedReporter;
      await new reporter(
        {
          agentSessionId: session.agentSessionId,
          provider: session.provider
        },
        {
          reporterService: createOptionalReporterService(reporterService),
          now: reporterNow
        }
      ).report();
      return toAgentHostAgentSessionFromCore(workspaceId, session);
    },
    async getComposerOptions(payload: {
      agentTargetId?: string | null;
      cwd?: string | null;
      provider?: string;
      settings?: AgentHostAgentSessionComposerSettings | null;
    }) {
      return agentActivityService.getComposerOptions({
        workspaceId,
        agentTargetId: payload.agentTargetId,
        cwd: payload.cwd,
        provider: payload.provider,
        settings: payload.settings
      });
    },
    async getState(payload: { agentSessionId: string }) {
      return agentActivityService.getSessionControlState({
        workspaceId,
        agentSessionId: resolveTuttidSessionId(payload.agentSessionId)
      });
    },
    async submitInteractive(payload: {
      action?: string;
      agentSessionId: string;
      requestId: string;
      optionId?: string;
      payload?: Record<string, unknown>;
    }) {
      const tuttidSessionId = resolveTuttidSessionId(payload.agentSessionId);
      await agentActivityService.submitInteractive({
        workspaceId,
        action: payload.action ?? null,
        agentSessionId: tuttidSessionId,
        optionId: payload.optionId ?? null,
        payload: payload.payload ?? null,
        requestId: payload.requestId
      });
      return {
        accepted: true,
        agentSessionId: payload.agentSessionId,
        events: [],
        requestId: payload.requestId
      };
    },
    async trackSettingsProjectChange(payload: {
      action: "clear" | "create_new" | "select_existing";
      agentSessionId: string;
      provider?: string | null;
    }) {
      await new AgentSettingsProjectChangedReporter(
        {
          action: payload.action,
          agentSessionId: payload.agentSessionId,
          provider: resolveDesktopAgentGUIProvider(payload.provider)
        },
        {
          reporterService: createOptionalReporterService(reporterService),
          now: reporterNow
        }
      ).report();
    },
    retainEventStream(payload: { agentSessionId: string }) {
      retainAgentSessionEventStream(payload.agentSessionId);
      return Promise.resolve({
        leaseId: `${workspaceId}:${payload.agentSessionId}`,
        retained: true
      });
    },
    releaseEventStream(payload?: { leaseId?: string }) {
      releaseAgentSessionEventStream(payload?.leaseId);
      return Promise.resolve({ released: true });
    },
    onEvent(listener: AgentSessionEventListener) {
      sessionEventListeners.add(listener);
      return () => sessionEventListeners.delete(listener);
    },
    subscribeEvents(
      payload: { agentSessionId: string },
      listener: AgentSessionEventListener
    ) {
      sessionEventListeners.add(listener);
      try {
        retainAgentSessionEventStream(payload.agentSessionId);
      } catch (error: unknown) {
        void runtimeApi.logTerminalDiagnostic({
          details: { error: stringifyError(error) },
          event: "agent.gui.sse.subscribe.failed",
          level: "warn",
          workspaceId
        });
      }
      return () => {
        sessionEventListeners.delete(listener);
        releaseAgentSessionEventStream(
          `${workspaceId}:${payload.agentSessionId}`
        );
      };
    }
  } satisfies NonNullable<AgentHostInputApi["agentSessions"]>;

  return agentSessions;

  function retainAgentSessionEventStream(agentSessionId: string): string {
    const leaseId = `${workspaceId}:${agentSessionId}`;
    const tuttidSessionId = resolveTuttidSessionId(agentSessionId);
    const existingLease = retainedEventStreamLeases.get(leaseId);
    if (existingLease) {
      existingLease.refCount += 1;
      return leaseId;
    }
    const release = agentActivityService.retainSessionEvents({
      workspaceId,
      agentSessionId: tuttidSessionId,
      onError: (error: unknown) => {
        void runtimeApi.logTerminalDiagnostic({
          details: { error: stringifyError(error) },
          event: "agent.gui.sse.subscribe.failed",
          level: "warn",
          workspaceId
        });
      }
    });
    retainedEventStreamLeases.set(leaseId, {
      refCount: 1,
      release
    });
    return leaseId;
  }

  function releaseAgentSessionEventStream(leaseId?: string): void {
    if (!leaseId) {
      return;
    }
    const lease = retainedEventStreamLeases.get(leaseId);
    if (!lease) {
      return;
    }
    lease.refCount -= 1;
    if (lease.refCount > 0) {
      return;
    }
    lease.release();
    retainedEventStreamLeases.delete(leaseId);
  }
}

function promptContentDisplayText(
  content: readonly { type: string; text?: string }[]
): string {
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text?.trim() ?? "")
    .filter(Boolean)
    .join("\n");
}

function resolveTuttidSessionId(agentSessionId: string): string {
  return agentSessionId.trim();
}

function normalizeAgentTargetId(
  value: string | null | undefined
): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function localAgentTargetIdForProvider(provider: string): string | null {
  switch (provider) {
    case "claude-code":
      return "local:claude-code";
    case "codex":
      return "local:codex";
    default:
      return null;
  }
}
