import {
  workspaceAgentSessionStatus,
  type AgentActivityAdapter,
  type AgentActivityCreateSessionInput,
  type AgentActivityGoalControlInput,
  type AgentActivityGoalControlResult,
  type AgentActivitySendInput,
  type AgentActivitySendInputResult,
  type AgentActivitySession,
  type AgentActivitySessionDetailSnapshot,
  type AgentActivitySubmitInteractiveInput,
  type AgentActivitySubmitInteractiveResult,
  type EngineEffectOptions
} from "@tutti-os/agent-activity-core";
import {
  agentActivityGoalControlResultFromTuttid,
  agentActivityMessageFromTuttidMessage,
  agentActivitySessionDetailFromTuttid as mapAgentActivitySessionDetailFromTuttid,
  agentActivitySessionFromTuttidSession as mapAgentActivitySessionFromTuttidSession,
  agentActivityTurnFromTuttidTurn,
  agentActivityTuttiModeActivationFromTuttid,
  tuttiAgentSessionComposerSettingsFromActivity,
  tuttiCreateWorkspaceAgentSessionRequestFromActivity,
  tuttiSendWorkspaceAgentSessionInputRequestFromActivity
} from "@tutti-os/agent-activity-tuttid-adapter";
export {
  agentActivityMessageFromTuttidMessage,
  agentActivityTurnFromTuttidTurn
} from "@tutti-os/agent-activity-tuttid-adapter";
import type {
  TuttidClient,
  WorkspaceAgentSession,
  WorkspaceAgentSessionDetailResponse,
  WorkspaceAgentSessionForkOperation,
  WorkspaceAgentProvider
} from "@tutti-os/client-tuttid-ts";
import {
  isTuttidProtocolError,
  TuttidProtocolError
} from "@tutti-os/client-tuttid-ts";
import type { DesktopRuntimeApi } from "@preload/types";
import type { DesktopWorkspaceUiMode } from "@shared/preferences";
import { getActiveLocale } from "../../../i18n/runtime.ts";
import { wrapLocalizedTuttidErrorIfSpecific } from "../../../lib/desktopErrors.ts";
import { agentActivityComposerOptionsFromTuttidResult } from "../../../lib/agentComposerOptionsProjection.ts";
import { reportAgentSubmitTraceDiagnostic as reportDesktopAgentSubmitTrace } from "./desktopAgentRuntimeSubmitDiagnostics.ts";
import { DESKTOP_AGENT_GUI_CURRENT_USER_ID } from "./desktopAgentGuiIdentity.ts";

export interface CreateDesktopAgentActivityAdapterInput {
  composerOptionsRequestTimeoutMs?: number;
  tuttidClient: TuttidClient;
  runtimeApi: Pick<DesktopRuntimeApi, "logTerminalDiagnostic">;
  takePendingSessionRecording?: (workspaceId: string) => string | null;
  restorePendingSessionRecording?: (
    workspaceId: string,
    recordingId: string
  ) => void;
  uiMode?: DesktopWorkspaceUiMode;
}

function submitDiagnosticsWithUiMode<T extends { submitDiagnostics?: object }>(
  input: T,
  uiMode: DesktopWorkspaceUiMode | undefined
): T {
  if (!uiMode) return input;
  return {
    ...input,
    submitDiagnostics: {
      ...input.submitDiagnostics,
      uiMode
    }
  };
}

// Cold ACP/model discovery is materially slower on Windows (Cursor can take
// 30-45 seconds on its first authenticated launch). Keep the renderer from
// reporting a false failure while the daemon is still probing the provider.
const defaultComposerOptionsRequestTimeoutMs = 60_000;
const agentActivitySessionListLimit = 100;
const sessionForkOperationPollBackoffMs = [0, 200, 500, 1_000, 2_000] as const;
const sessionForkOperationMaxConsecutiveReadFailures = 3;

export interface DesktopAgentActivityCommandAdapter extends AgentActivityAdapter {
  createSession(
    input: AgentActivityCreateSessionInput
  ): Promise<AgentActivitySession>;
  createSession(
    input: AgentActivityCreateSessionInput,
    options: EngineEffectOptions
  ): Promise<AgentActivitySession>;
  sendInput(
    input: AgentActivitySendInput
  ): Promise<AgentActivitySendInputResult>;
  sendInput(
    input: AgentActivitySendInput,
    options: EngineEffectOptions
  ): Promise<AgentActivitySendInputResult>;
  goalControl(
    input: AgentActivityGoalControlInput
  ): Promise<AgentActivityGoalControlResult>;
  goalControl(
    input: AgentActivityGoalControlInput,
    options: EngineEffectOptions
  ): Promise<AgentActivityGoalControlResult>;
  submitInteractive(
    input: AgentActivitySubmitInteractiveInput
  ): Promise<AgentActivitySubmitInteractiveResult>;
  submitInteractive(
    input: AgentActivitySubmitInteractiveInput,
    options: EngineEffectOptions
  ): Promise<AgentActivitySubmitInteractiveResult>;
}

export function agentActivitySessionFromTuttidSession(
  workspaceId: string,
  session: WorkspaceAgentSession,
  options: { lifecycleCapabilitiesProjected?: boolean } = {}
): AgentActivitySession {
  return mapAgentActivitySessionFromTuttidSession(workspaceId, session, {
    currentUserId: DESKTOP_AGENT_GUI_CURRENT_USER_ID,
    ...options
  });
}

export function agentActivitySessionDetailFromTuttid(
  workspaceId: string,
  expectedAgentSessionId: string,
  detail: WorkspaceAgentSessionDetailResponse
): AgentActivitySessionDetailSnapshot {
  return mapAgentActivitySessionDetailFromTuttid(
    workspaceId,
    expectedAgentSessionId,
    detail,
    {
      currentUserId: DESKTOP_AGENT_GUI_CURRENT_USER_ID
    }
  );
}

export function createDesktopAgentActivityAdapter({
  composerOptionsRequestTimeoutMs = defaultComposerOptionsRequestTimeoutMs,
  tuttidClient,
  runtimeApi,
  takePendingSessionRecording,
  restorePendingSessionRecording,
  uiMode
}: CreateDesktopAgentActivityAdapterInput): DesktopAgentActivityCommandAdapter {
  return {
    async listSessions(input) {
      const response = await tuttidClient.listWorkspaceAgentSessions(
        input.workspaceId,
        { limit: agentActivitySessionListLimit }
      );
      return {
        sessions: response.sessions.map((session) =>
          agentActivitySessionFromTuttidSession(input.workspaceId, session)
        )
      };
    },
    async listSessionMessages(input) {
      const startedAt = Date.now();
      reportDesktopAgentMessageListDiagnostic(runtimeApi, input.workspaceId, {
        afterVersion: input.afterVersion ?? 0,
        agentSessionId: input.agentSessionId,
        beforeVersion: input.beforeVersion ?? null,
        event: "requested",
        limit: input.limit ?? null,
        order: input.order ?? null
      });
      try {
        const response = await tuttidClient.listWorkspaceAgentSessionMessages(
          input.workspaceId,
          input.agentSessionId,
          {
            afterVersion: input.afterVersion ?? 0,
            beforeVersion: input.beforeVersion,
            order: input.order,
            limit: input.limit
          },
          { signal: input.signal }
        );
        const messages = response.messages.map((message) =>
          agentActivityMessageFromTuttidMessage(input.workspaceId, message)
        );
        const versions = messages
          .map((message) => message.version)
          .filter((version) => Number.isFinite(version));
        reportDesktopAgentMessageListDiagnostic(runtimeApi, input.workspaceId, {
          agentSessionId: input.agentSessionId,
          durationMs: Date.now() - startedAt,
          event: "resolved",
          firstVersion: versions.length ? Math.min(...versions) : null,
          hasMore: response.hasMore,
          lastVersion: versions.length ? Math.max(...versions) : null,
          latestVersion: response.latestVersion,
          messageCount: messages.length
        });
        return {
          hasMore: response.hasMore,
          latestVersion: response.latestVersion,
          messages
        };
      } catch (error) {
        reportDesktopAgentMessageListDiagnostic(runtimeApi, input.workspaceId, {
          agentSessionId: input.agentSessionId,
          durationMs: Date.now() - startedAt,
          event: "failed",
          ...normalizeDesktopAgentDiagnosticError(error)
        });
        throw error;
      }
    },
    async loadComposerOptions(input) {
      const startedAt = Date.now();
      const cwd = input.cwd?.trim();
      const agentTargetId = input.agentTargetId?.trim();
      const section = input.section ?? "full";
      try {
        const result = await withAbortableRequestTimeout(
          (signal) =>
            tuttidClient.getAgentProviderComposerOptions(
              workspaceAgentProvider(input.provider),
              {
                ...(agentTargetId ? { agentTargetId } : {}),
                ...(cwd ? { cwd } : {}),
                ...(section !== "full" ? { section } : {}),
                ...(input.waitForFreshModelCatalog
                  ? { waitForFreshModelCatalog: true }
                  : {}),
                workspaceId: input.workspaceId,
                settings: tuttiAgentSessionComposerSettingsFromActivity(
                  input.settings
                )
              },
              { signal }
            ),
          {
            signal: input.signal,
            timeoutMessage: "Agent composer options request timed out.",
            timeoutMs: composerOptionsRequestTimeoutMs
          }
        );
        const options = agentActivityComposerOptionsFromTuttidResult(
          input.provider,
          result
        );
        const modelNames = desktopComposerModelNames(options.models);
        reportDesktopAgentComposerOptionsDiagnostic(
          runtimeApi,
          input.workspaceId,
          {
            agentTargetId: agentTargetId ?? null,
            durationMs: Date.now() - startedAt,
            modelCount: options.models.length,
            ...(modelNames ? { modelNames } : {}),
            provider: input.provider,
            section,
            status: "ready"
          }
        );
        return options;
      } catch (error) {
        reportDesktopAgentComposerOptionsDiagnostic(
          runtimeApi,
          input.workspaceId,
          {
            agentTargetId: agentTargetId ?? null,
            durationMs: Date.now() - startedAt,
            provider: input.provider,
            section,
            status: "error",
            ...normalizeDesktopAgentDiagnosticError(error)
          }
        );
        throw error;
      }
    },
    async createSession(input, options?: EngineEffectOptions) {
      reportDesktopAgentSubmitTrace(runtimeApi, {
        agentSessionId: input.agentSessionId?.trim() ?? null,
        clientSubmitId: input.clientSubmitId,
        event: "renderer_adapter.create.entered",
        provider: null,
        submitDiagnostics: input.submitDiagnostics,
        workspaceId: input.workspaceId
      });
      let recordingId: string | null = null;
      try {
        const agentSessionId =
          input.agentSessionId?.trim() || createDesktopAgentActivitySessionId();
        reportDesktopAgentSubmitTrace(runtimeApi, {
          agentSessionId,
          clientSubmitId: input.clientSubmitId,
          event: "renderer_adapter.create.http_requested",
          provider: null,
          submitDiagnostics: input.submitDiagnostics,
          workspaceId: input.workspaceId,
          fields: {
            hasInitialTuttiModeActivation:
              input.initialTuttiModeActivation != null
          }
        });
        const agentTargetId = requiredAgentTargetId(input.agentTargetId);
        recordingId = takePendingSessionRecording?.(input.workspaceId) ?? null;
        const request = tuttiCreateWorkspaceAgentSessionRequestFromActivity(
          submitDiagnosticsWithUiMode(
            {
              ...input,
              agentSessionId,
              agentTargetId,
              noProject:
                input.noProject ?? (normalizeText(input.cwd) ? null : true)
            },
            uiMode
          ),
          { recordingId }
        );
        const session = await tuttidClient.createWorkspaceAgentSession(
          input.workspaceId,
          request,
          agentCommandRequestOptions(options, input.signal)
        );
        reportDesktopAgentSubmitTrace(runtimeApi, {
          agentSessionId: session.id,
          clientSubmitId: input.clientSubmitId,
          event: "renderer_adapter.create.resolved",
          provider: session.provider,
          submitDiagnostics: input.submitDiagnostics,
          workspaceId: input.workspaceId,
          fields: { sessionStatus: workspaceAgentSessionStatus(session) }
        });
        return agentActivitySessionFromTuttidSession(
          input.workspaceId,
          session
        );
      } catch (error) {
        if (recordingId) {
          restorePendingSessionRecording?.(input.workspaceId, recordingId);
        }
        reportDesktopAgentSubmitTrace(runtimeApi, {
          agentSessionId: input.agentSessionId?.trim() ?? null,
          clientSubmitId: input.clientSubmitId,
          event: "renderer_adapter.create.failed",
          fields: {
            ...normalizeDesktopAgentDiagnosticError(error),
            hasInitialTuttiModeActivation:
              input.initialTuttiModeActivation != null
          },
          provider: null,
          submitDiagnostics: input.submitDiagnostics,
          workspaceId: input.workspaceId
        });
        throw wrapLocalizedTuttidErrorIfSpecific(error, getActiveLocale());
      }
    },
    async sendInput(input, options?: EngineEffectOptions) {
      reportDesktopAgentSubmitTrace(runtimeApi, {
        agentSessionId: input.agentSessionId,
        clientSubmitId: input.clientSubmitId,
        event: "renderer_adapter.send.entered",
        submitDiagnostics: input.submitDiagnostics,
        workspaceId: input.workspaceId
      });
      reportDesktopAgentSubmitTrace(runtimeApi, {
        agentSessionId: input.agentSessionId,
        clientSubmitId: input.clientSubmitId,
        event: "renderer_adapter.send.http_requested",
        submitDiagnostics: input.submitDiagnostics,
        workspaceId: input.workspaceId
      });
      const request = tuttiSendWorkspaceAgentSessionInputRequestFromActivity(
        submitDiagnosticsWithUiMode(input, uiMode)
      );
      let result: Awaited<
        ReturnType<TuttidClient["sendWorkspaceAgentSessionInput"]>
      >;
      try {
        result = await tuttidClient.sendWorkspaceAgentSessionInput(
          input.workspaceId,
          input.agentSessionId,
          request,
          agentCommandRequestOptions(options, input.signal)
        );
      } catch (error) {
        reportDesktopAgentSubmitTrace(runtimeApi, {
          agentSessionId: input.agentSessionId,
          clientSubmitId: input.clientSubmitId,
          event: "renderer_adapter.send.failed",
          fields: normalizeDesktopAgentDiagnosticError(error),
          submitDiagnostics: input.submitDiagnostics,
          workspaceId: input.workspaceId
        });
        throw wrapLocalizedTuttidErrorIfSpecific(error, getActiveLocale());
      }
      if (result.kind === "goalControl") {
        return {
          kind: "goalControl",
          goal: result.goal ?? result.session.goal ?? null,
          session: agentActivitySessionFromTuttidSession(
            input.workspaceId,
            result.session
          )
        };
      }
      if (!result.turn || !result.turnId) {
        throw new Error("workspace_agent.send_response_turn_required");
      }
      reportDesktopAgentSubmitTrace(runtimeApi, {
        agentSessionId: input.agentSessionId,
        clientSubmitId: input.clientSubmitId,
        event: "renderer_adapter.send.resolved",
        provider: result.session.provider,
        submitDiagnostics: input.submitDiagnostics,
        workspaceId: input.workspaceId,
        fields: {
          sessionStatus: workspaceAgentSessionStatus(result.session),
          turnId: result.turnId,
          turnPhase: result.turn.phase
        }
      });
      return {
        kind: "turn",
        session: agentActivitySessionFromTuttidSession(
          input.workspaceId,
          result.session
        ),
        turnId: result.turnId,
        turn: agentActivityTurnFromTuttidTurn(result.turn)
      };
    },
    async updateTuttiModeActivation(input) {
      const response =
        await tuttidClient.updateWorkspaceAgentSessionTuttiModeActivation(
          input.workspaceId,
          input.agentSessionId,
          {
            ...(input.expectedRevision === undefined
              ? {}
              : { expectedRevision: input.expectedRevision }),
            ...(input.effect === undefined &&
            input.orchestrationIntensity === undefined
              ? {}
              : {
                  effect: input.effect ?? input.orchestrationIntensity
                }),
            ...(input.speed === undefined ? {} : { speed: input.speed }),
            source: input.source,
            status: input.status
          },
          { signal: input.signal }
        );
      if (!response.activation) {
        throw new Error("workspace_agent.tutti_mode_activation_required");
      }
      return {
        activation: agentActivityTuttiModeActivationFromTuttid(
          response.activation
        ),
        changed: response.changed
      };
    },
    async goalControl(input, options?: EngineEffectOptions) {
      const result = await tuttidClient.goalControlWorkspaceAgentSession(
        input.workspaceId,
        input.agentSessionId,
        {
          action: input.action,
          ...(input.clientSubmitId
            ? { clientSubmitId: input.clientSubmitId }
            : {}),
          ...(input.objective !== undefined
            ? { objective: input.objective }
            : {})
        },
        agentCommandRequestOptions(options, input.signal)
      );
      return agentActivityGoalControlResultFromTuttid(
        input.workspaceId,
        result,
        { currentUserId: DESKTOP_AGENT_GUI_CURRENT_USER_ID }
      );
    },
    async submitInteractive(input, options?: EngineEffectOptions) {
      const request = {
        turnId: input.turnId,
        action: input.action ?? null,
        optionId: input.optionId ?? null,
        payload: input.payload ?? null
      };
      const session = await tuttidClient.submitWorkspaceAgentInteractive(
        input.workspaceId,
        input.agentSessionId,
        input.requestId,
        request,
        agentCommandRequestOptions(options, input.signal)
      );
      return {
        session: agentActivitySessionFromTuttidSession(
          input.workspaceId,
          session
        )
      };
    },
    async deleteSession(input) {
      return await tuttidClient.deleteWorkspaceAgentSession(
        input.workspaceId,
        input.agentSessionId
      );
    },
    async deleteSessions(input) {
      const response = await tuttidClient.deleteWorkspaceAgentSessionsBatch(
        input.workspaceId,
        { sessionIds: [...input.agentSessionIds] },
        { signal: input.signal }
      );
      return {
        cleanupFailedSessionIds: response.cleanupFailedSessionIds,
        removedMessages: response.removedMessages,
        removedSessionIds: response.removedSessionIds,
        removedSessions: response.removedSessions
      };
    },
    async renameSession(input) {
      const session = await tuttidClient.updateWorkspaceAgentSessionTitle(
        input.workspaceId,
        input.agentSessionId,
        { title: input.title },
        { signal: input.signal }
      );
      return agentActivitySessionFromTuttidSession(input.workspaceId, session);
    },
    async setSessionPinned(input) {
      const session = await tuttidClient.updateWorkspaceAgentSessionPin(
        input.workspaceId,
        input.agentSessionId,
        { pinned: input.pinned },
        { signal: input.signal }
      );
      return agentActivitySessionFromTuttidSession(input.workspaceId, session);
    },
    async forkSession(input) {
      let startedOperation: WorkspaceAgentSessionForkOperation;
      try {
        startedOperation = await tuttidClient.forkWorkspaceAgentSession(
          input.workspaceId,
          input.sourceAgentSessionId,
          {
            point: { type: "throughTurn", turnId: input.turnId },
            requestId: input.requestId,
            targetAgentSessionId: input.targetAgentSessionId
          },
          { signal: input.signal }
        );
      } catch (error) {
        if (isTuttidProtocolError(error)) {
          throw sessionForkProtocolError(error);
        }
        throw sessionForkDeliveryUnknownError(error);
      }
      const reconciledOperation =
        startedOperation.status === "accepted"
          ? await reconcileAcceptedSessionForkOperation(
              tuttidClient,
              input.workspaceId,
              startedOperation,
              input.signal
            )
          : startedOperation;
      const result = agentActivityForkSessionResult(
        input.workspaceId,
        reconciledOperation
      );
      if (result.status === "committed") {
        // A committed, unacknowledged operation recovered by boundary owns the
        // real child identity. The Engine must adopt that durable request and
        // target instead of manufacturing the caller's new target locally.
        return result;
      }
      return {
        ...result,
        // Unknown recovery has no canonical child to adopt. Keep transport
        // correlation scoped to the current Engine record while operationId
        // identifies the original durable attempt.
        requestId: input.requestId,
        sourceAgentSessionId: input.sourceAgentSessionId,
        targetAgentSessionId: input.targetAgentSessionId,
        turnId: input.turnId
      };
    }
  };
}

function agentCommandRequestOptions(
  options: EngineEffectOptions | undefined,
  signal: AbortSignal | undefined
) {
  return options?.origin === "engine"
    ? {
        agentCommandOrigin: "renderer-engine" as const,
        signal
      }
    : { signal };
}

function sessionForkDeliveryUnknownError(error: unknown): Error {
  return Object.assign(
    new Error(
      error instanceof Error
        ? error.message
        : "Unable to reconcile session fork operation."
    ),
    { reason: "agent_session_fork_delivery_unknown" }
  );
}

async function reconcileAcceptedSessionForkOperation(
  tuttidClient: TuttidClient,
  workspaceId: string,
  startedOperation: WorkspaceAgentSessionForkOperation,
  signal?: AbortSignal
): Promise<WorkspaceAgentSessionForkOperation> {
  let operation = startedOperation;
  let pollAttempt = 0;
  let consecutiveReadFailures = 0;
  while (operation.status === "accepted") {
    await waitForSessionForkOperationPoll(
      sessionForkOperationPollBackoffMs[
        Math.min(pollAttempt, sessionForkOperationPollBackoffMs.length - 1)
      ] ?? 2_000,
      signal
    );
    try {
      operation = await tuttidClient.getWorkspaceAgentSessionForkOperation(
        workspaceId,
        operation.operationId,
        { signal }
      );
      consecutiveReadFailures = 0;
    } catch (error) {
      if (signal?.aborted) {
        throw signal.reason ?? error;
      }
      consecutiveReadFailures += 1;
      if (
        consecutiveReadFailures >=
        sessionForkOperationMaxConsecutiveReadFailures
      ) {
        throw sessionForkDeliveryUnknownError(error);
      }
    }
    pollAttempt += 1;
  }
  return operation;
}

function waitForSessionForkOperationPoll(
  delayMs: number,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(
      signal.reason ?? new Error("Session fork reconciliation was aborted.")
    );
  }
  if (delayMs <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timeoutId = globalThis.setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    const abort = () => {
      globalThis.clearTimeout(timeoutId);
      signal?.removeEventListener("abort", abort);
      reject(
        signal?.reason ?? new Error("Session fork reconciliation was aborted.")
      );
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function sessionForkProtocolError(
  error: TuttidProtocolError
): TuttidProtocolError {
  const boundaryReason = error.params.forkBoundaryReason;
  if (
    typeof boundaryReason !== "string" ||
    !boundaryReason.trim() ||
    error.reason !== "agent_session_fork_conflict"
  ) {
    return error;
  }
  return new TuttidProtocolError({
    code: error.code,
    correlationId: error.correlationId,
    developerMessage: error.developerMessage,
    params: error.params,
    reason: boundaryReason.trim(),
    retryable: error.retryable,
    statusCode: error.statusCode
  });
}

function agentActivityForkSessionResult(
  workspaceId: string,
  operation: WorkspaceAgentSessionForkOperation
) {
  return {
    error: operation.error,
    operationId: operation.operationId,
    requestId: operation.requestId,
    session: operation.session
      ? agentActivitySessionFromTuttidSession(workspaceId, operation.session, {
          lifecycleCapabilitiesProjected: true
        })
      : null,
    sourceAgentSessionId: operation.sourceAgentSessionId,
    status: operation.status,
    targetAgentSessionId: operation.targetAgentSessionId,
    turnId: operation.point.turnId
  };
}

function reportDesktopAgentMessageListDiagnostic(
  runtimeApi: Pick<DesktopRuntimeApi, "logTerminalDiagnostic">,
  workspaceId: string,
  details: Record<string, string | number | boolean | null>
): void {
  try {
    void runtimeApi
      .logTerminalDiagnostic({
        details,
        event: "agent.activity.messages.list",
        level: details.event === "failed" ? "warn" : "debug",
        workspaceId
      })
      .catch(() => {});
  } catch {
    // Diagnostic logging must not affect message loading.
  }
}

function reportDesktopAgentComposerOptionsDiagnostic(
  runtimeApi: Pick<DesktopRuntimeApi, "logTerminalDiagnostic">,
  workspaceId: string,
  details: Record<string, string | number | boolean | null>
): void {
  try {
    void runtimeApi
      .logTerminalDiagnostic({
        details,
        event: "agent.composer_options.load",
        level: details.status === "error" ? "warn" : "info",
        workspaceId
      })
      .catch(() => {});
  } catch {
    // Diagnostic logging must not affect composer option loading.
  }
}

function desktopComposerModelNames(
  models: readonly { value: string }[]
): string | undefined {
  const names: string[] = [];
  const seen = new Set<string>();
  let totalLength = 0;
  for (const model of models) {
    let withoutControls = "";
    for (const character of model.value) {
      const code = character.charCodeAt(0);
      if ((code >= 0 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f)) {
        continue;
      }
      withoutControls += character;
    }
    const name = withoutControls.replace(/\s+/g, " ").trim().slice(0, 120);
    if (!name || seen.has(name)) continue;
    if (names.length >= 32 || totalLength + name.length > 1_024) break;
    names.push(name);
    seen.add(name);
    totalLength += name.length;
  }
  return names.length > 0 ? names.join(",") : undefined;
}

function normalizeDesktopAgentDiagnosticError(
  error: unknown
): Record<string, string | number | boolean | null> {
  if (!(error instanceof Error)) {
    return { errorName: typeof error };
  }
  const record = error as Error & {
    code?: unknown;
    reason?: unknown;
    retryable?: unknown;
    statusCode?: unknown;
  };
  return {
    ...(typeof record.code === "string" ? { errorCode: record.code } : {}),
    errorMessageLength: error.message.length,
    errorName: error.name,
    ...(typeof record.reason === "string"
      ? { errorReason: record.reason }
      : {}),
    ...(typeof record.retryable === "boolean"
      ? { errorRetryable: record.retryable }
      : {}),
    ...(typeof record.statusCode === "number"
      ? { errorStatusCode: record.statusCode }
      : {})
  };
}

export function createDesktopAgentActivitySessionId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  const fallbackHex = Math.random().toString(16).slice(2).padEnd(12, "0");
  return `00000000-0000-4000-8000-${fallbackHex.slice(0, 12)}`;
}

function requiredAgentTargetId(value: string | null | undefined): string {
  const agentTargetId = normalizeText(value);
  if (!agentTargetId) {
    throw new Error("Agent target id is required to create an agent session.");
  }
  return agentTargetId;
}

function withAbortableRequestTimeout<T>(
  request: (signal: AbortSignal) => Promise<T>,
  options: {
    signal?: AbortSignal;
    timeoutMessage: string;
    timeoutMs: number;
  }
): Promise<T> {
  const controller = new AbortController();
  const racers: Array<Promise<T>> = [];
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let abortListener: (() => void) | null = null;

  if (options.signal) {
    if (options.signal.aborted) {
      const error = abortSignalError(options.signal);
      controller.abort(error);
      return Promise.reject(error);
    }
    racers.push(
      new Promise<never>((_, reject) => {
        abortListener = () => {
          const error = abortSignalError(options.signal);
          controller.abort(error);
          reject(error);
        };
        options.signal?.addEventListener("abort", abortListener, {
          once: true
        });
      })
    );
  }

  racers.push(request(controller.signal));

  if (Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
    racers.push(
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          const error = Object.assign(new Error(options.timeoutMessage), {
            code: "ETIMEDOUT"
          });
          controller.abort(error);
          reject(error);
        }, options.timeoutMs);
      })
    );
  }

  return Promise.race(racers).finally(() => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    if (abortListener) {
      options.signal?.removeEventListener("abort", abortListener);
    }
  });
}

function abortSignalError(signal: AbortSignal | undefined): Error {
  if (signal?.reason instanceof Error) {
    return signal.reason;
  }
  const error = new Error("Agent composer options request was cancelled.");
  error.name = "AbortError";
  return error;
}

function normalizeText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function workspaceAgentProvider(value: string): WorkspaceAgentProvider {
  return value as WorkspaceAgentProvider;
}
