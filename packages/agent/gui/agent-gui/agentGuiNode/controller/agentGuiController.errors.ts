// Agent GUI controller — runtime error codes, messages, and diagnostics.

import type { AppErrorCode } from "../../../shared/contracts/dto";
import type { AgentActivityCancelSessionResult } from "@tutti-os/agent-activity-core";
import type { AgentActivityRuntime } from "../../../agentActivityRuntime";
import { projectCoreSessionStatus } from "../../../shared/agentActivitySnapshotProjection";
import { normalizeOptionalWorkspaceAgentStatus } from "../../../shared/workspaceAgentStatusNormalizer";
import { translate } from "../../../i18n/index";
import { getAppErrorCode } from "../../../shared/errors/appError";
import { AGENT_PROVIDER_LABEL } from "../../../contexts/settings/domain/agentSettings";
import {
  buildAgentSessionMentionHref,
  formatAgentMentionMarkdown,
  normalizeAgentSessionMentionTitle
} from "../agentRichText/agentFileMentionExtension";
import {
  AGENT_GUI_CAUGHT_ERROR_STACK_LIMIT,
  AGENT_PROVIDER_SESSION_NOT_FOUND_ERROR,
  AGENT_PROVIDER_SESSION_NOT_FOUND_FALLBACK_MESSAGE,
  AGENT_RESUME_SESSION_NOT_LOCAL_ERROR,
  AGENT_RESUME_SESSION_NOT_LOCAL_FALLBACK_MESSAGE,
  AGENT_SESSION_ACTIVE_TURN_CONFLICT_MESSAGE,
  AGENT_SESSION_NOT_FOUND_ERROR,
  AGENT_SETTINGS_REQUIRE_NEW_SESSION_ERROR
} from "./agentGuiController.constants";
import type { AgentGUIRuntimeErrorPhase } from "./agentGuiController.types";
import { agentSessionStatusBusy } from "./agentGuiController.conversationHelpers";

export function reportAgentGUIRuntimeError(input: {
  agentSessionId?: string | null;
  context?: Record<string, unknown>;
  error: unknown;
  phase: AgentGUIRuntimeErrorPhase;
  provider?: string | null;
  requestId?: number | string | null;
  runtime: AgentActivityRuntime;
  workspaceId: string;
}): void {
  const reportDiagnostic = input.runtime.reportDiagnostic;
  if (!reportDiagnostic) {
    return;
  }
  const details: Record<string, unknown> = {
    error: normalizeAgentGUIDiagnosticError(input.error),
    errorCode: getAgentGUIErrorCode(input.error),
    phase: input.phase,
    ...(input.agentSessionId ? { agentSessionId: input.agentSessionId } : {}),
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.requestId !== undefined && input.requestId !== null
      ? { requestId: input.requestId }
      : {}),
    ...(input.context ?? {})
  };
  try {
    void Promise.resolve(
      reportDiagnostic.call(input.runtime, {
        details,
        event: "agent.gui.caught_error",
        level: "error",
        source: "agent-gui",
        workspaceId: input.workspaceId
      })
    ).catch(() => {});
  } catch {
    // Diagnostic logging must never affect the Agent GUI recovery path.
  }
}

export function reportAgentGUICancelDiagnostic(input: {
  agentSessionId: string;
  busySource?: string | null;
  currentSessionStatus?: string | null;
  phase: "drain_queued_prompt_interrupt" | "interrupt_current_turn";
  provider?: string | null;
  result: AgentActivityCancelSessionResult;
  runtime: AgentActivityRuntime;
  workspaceId: string;
}): void {
  if (input.result.canceled) {
    return;
  }
  const reportDiagnostic = input.runtime.reportDiagnostic;
  if (!reportDiagnostic) {
    return;
  }
  try {
    void Promise.resolve(
      reportDiagnostic.call(input.runtime, {
        details: {
          agentSessionId: input.agentSessionId,
          busySource: input.busySource ?? "unknown",
          canceled: input.result.canceled,
          cancelReason: input.result.reason,
          currentSessionStatus: input.currentSessionStatus ?? null,
          phase: input.phase,
          provider: input.provider ?? null,
          returnedSessionNonBusy: cancelResultSessionStatusIsNonBusy(
            input.result
          ),
          returnedSessionStatus: input.result.session.status
        },
        event: "agent.gui.cancel.noop",
        level: "info",
        source: "agent-gui",
        workspaceId: input.workspaceId
      })
    ).catch(() => {});
  } catch {
    // Diagnostic logging must never affect the Agent GUI recovery path.
  }
}

export function cancelResultSessionStatusIsNonBusy(
  result: AgentActivityCancelSessionResult
): boolean {
  const status = normalizeOptionalWorkspaceAgentStatus({
    currentPhase: result.session.currentPhase,
    status: projectCoreSessionStatus(result.session.status)
  });
  return (
    status !== null && status.kind !== "working" && status.kind !== "waiting"
  );
}

export function cancelBusySource(input: {
  conversationStatus?: string | null;
  hasActivePrompt?: boolean;
  runtimeSessionStatus?: string | null;
  sessionStateStatus?: string | null;
}): string {
  if (input.hasActivePrompt) {
    return "interactive_prompt";
  }
  if (
    agentSessionStatusBusy({
      status: input.conversationStatus ?? undefined
    })
  ) {
    return "conversation_status";
  }
  if (
    agentSessionStatusBusy({
      status: input.runtimeSessionStatus ?? undefined
    })
  ) {
    return "runtime_session";
  }
  if (
    agentSessionStatusBusy({
      status: input.sessionStateStatus ?? undefined
    })
  ) {
    return "session_state";
  }
  return "unknown";
}

export function normalizeAgentGUIDiagnosticError(
  error: unknown
): Record<string, unknown> {
  const record =
    error && typeof error === "object"
      ? (error as Record<string, unknown>)
      : null;
  const appErrorCode = getAgentGUIErrorCode(error);
  const explicitCode = typeof record?.code === "string" ? record.code : null;
  const hasStructuredCode = appErrorCode !== null || explicitCode !== null;
  const nativeRuntimeError =
    error instanceof Error && isNativeRuntimeError(error);
  const base: Record<string, unknown> = {
    ...(error instanceof Error ? { name: error.name } : {}),
    ...(explicitCode ? { code: explicitCode } : {}),
    ...(typeof record?.statusCode === "number"
      ? { statusCode: record.statusCode }
      : {}),
    ...(typeof record?.correlationId === "string"
      ? { correlationId: record.correlationId }
      : {}),
    ...(typeof record?.reason === "string" ? { reason: record.reason } : {}),
    ...(typeof record?.retryable === "boolean"
      ? { retryable: record.retryable }
      : {})
  };
  if (nativeRuntimeError) {
    return {
      ...base,
      message: error.message,
      ...(error.stack ? { stack: limitDiagnosticText(error.stack) } : {})
    };
  }
  if (record) {
    return {
      ...base,
      ...(typeof record.name === "string" && !("name" in base)
        ? { name: record.name }
        : {}),
      ...(typeof record.message === "string"
        ? { messageLength: record.message.length }
        : {}),
      ...(typeof record.debugMessage === "string"
        ? { debugMessageLength: record.debugMessage.length }
        : {})
    };
  }
  const rawMessage = getAgentGUIRawErrorMessage(error);
  return {
    ...(hasStructuredCode ? {} : { messageLength: rawMessage?.length ?? 0 }),
    type: typeof error
  };
}

export function isNativeRuntimeError(error: Error): boolean {
  return (
    error instanceof RangeError ||
    error instanceof ReferenceError ||
    error instanceof SyntaxError ||
    error instanceof TypeError ||
    error instanceof URIError
  );
}

export function limitDiagnosticText(value: string): string {
  if (value.length <= AGENT_GUI_CAUGHT_ERROR_STACK_LIMIT) {
    return value;
  }
  return `${value.slice(0, AGENT_GUI_CAUGHT_ERROR_STACK_LIMIT)}...`;
}

export function getAgentGUIErrorCode(error: unknown): AppErrorCode | null {
  return (
    getAppErrorCode(error) ??
    inferAgentGUIErrorCodeFromMessage(getAgentGUIRawErrorMessage(error))
  );
}

export function inferAgentGUIErrorCodeFromMessage(
  message: string | null
): AppErrorCode | null {
  if (!message) {
    return null;
  }
  switch (message.trim()) {
    case AGENT_PROVIDER_SESSION_NOT_FOUND_FALLBACK_MESSAGE:
      return AGENT_PROVIDER_SESSION_NOT_FOUND_ERROR as AppErrorCode;
    case AGENT_RESUME_SESSION_NOT_LOCAL_FALLBACK_MESSAGE:
      return AGENT_RESUME_SESSION_NOT_LOCAL_ERROR as AppErrorCode;
    default:
      return null;
  }
}

export function isProviderSessionNotFoundErrorCode(
  code: AppErrorCode | null | undefined
): boolean {
  return code === AGENT_PROVIDER_SESSION_NOT_FOUND_ERROR;
}

export function isResumeSessionNotLocalErrorCode(
  code: AppErrorCode | null | undefined
): boolean {
  return code === AGENT_RESUME_SESSION_NOT_LOCAL_ERROR;
}

export function isNonRetryableResumeErrorCode(
  code: AppErrorCode | null | undefined
): boolean {
  return (
    isProviderSessionNotFoundErrorCode(code) ||
    isResumeSessionNotLocalErrorCode(code)
  );
}

export function isSessionNotFoundErrorCode(
  code: AppErrorCode | null | undefined
): boolean {
  return code === AGENT_SESSION_NOT_FOUND_ERROR;
}

export function isSettingsRequireNewSessionErrorCode(
  code: AppErrorCode | null | undefined
): boolean {
  return code === AGENT_SETTINGS_REQUIRE_NEW_SESSION_ERROR;
}

export function buildProviderSessionNotFoundActivationError(
  message?: string | null
): {
  code: AppErrorCode;
  message: string;
  debugMessage?: string;
} {
  const localizedMessage = translate("messages.agentProviderSessionNotFound");
  const normalizedMessage =
    typeof message === "string" && message.trim() ? message.trim() : null;
  return {
    code: AGENT_PROVIDER_SESSION_NOT_FOUND_ERROR,
    message: localizedMessage,
    ...(normalizedMessage ? { debugMessage: normalizedMessage } : {})
  };
}

export function buildResumeSessionNotLocalActivationError(
  message?: string | null
): {
  code: AppErrorCode;
  message: string;
  debugMessage?: string;
} {
  const localizedMessage = translate("messages.agentResumeSessionNotLocal");
  const normalizedMessage =
    typeof message === "string" && message.trim() ? message.trim() : null;
  return {
    code: AGENT_RESUME_SESSION_NOT_LOCAL_ERROR,
    message: localizedMessage,
    ...(normalizedMessage ? { debugMessage: normalizedMessage } : {})
  };
}

export function getAgentGUIErrorMessage(error: unknown): string {
  if (isProviderSessionNotFoundErrorCode(getAgentGUIErrorCode(error))) {
    return translate("messages.agentProviderSessionNotFound");
  }
  if (isResumeSessionNotLocalErrorCode(getAgentGUIErrorCode(error))) {
    return translate("messages.agentResumeSessionNotLocal");
  }
  if (isSettingsRequireNewSessionErrorCode(getAgentGUIErrorCode(error))) {
    return translate("messages.agentSettingsRequireNewSession");
  }
  if (error && typeof error === "object") {
    const debugMessage = (error as { debugMessage?: unknown }).debugMessage;
    if (typeof debugMessage === "string" && debugMessage.trim()) {
      return debugMessage.trim();
    }
  }
  return error instanceof Error ? error.message : String(error);
}

export function getAgentGUIRawErrorMessage(error: unknown): string | null {
  if (error && typeof error === "object") {
    const debugMessage = (error as { debugMessage?: unknown }).debugMessage;
    if (typeof debugMessage === "string" && debugMessage.trim()) {
      return debugMessage.trim();
    }
  }
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }
  return null;
}

export function buildContinueInNewConversationPrompt(input: {
  workspaceId: string;
  agentSessionId: string;
  conversationUserId?: string | null;
  currentUserId?: string | null;
  userProfilesByUserId: Record<string, { name?: string | null }>;
  provider: string;
  conversationTitle: string;
  existingDraftPrompt: string;
}): string {
  const providerLabelFromCatalog =
    AGENT_PROVIDER_LABEL[input.provider as keyof typeof AGENT_PROVIDER_LABEL] ??
    null;
  const providerLabel =
    providerLabelFromCatalog || input.provider.trim() || "Agent";
  const normalizedTitle = normalizeAgentSessionMentionTitle(
    input.conversationTitle
  );
  const normalizedConversationUserId = input.conversationUserId?.trim() ?? "";
  const normalizedCurrentUserId = input.currentUserId?.trim() ?? "";
  const initiatorName =
    (normalizedConversationUserId &&
      input.userProfilesByUserId[normalizedConversationUserId]?.name?.trim()) ||
    (normalizedCurrentUserId &&
      input.userProfilesByUserId[normalizedCurrentUserId]?.name?.trim()) ||
    normalizedConversationUserId ||
    normalizedCurrentUserId ||
    translate("messages.agentThisSessionMentionLabel").trim();
  const mentionLabel = `${initiatorName} & ${providerLabel}${
    normalizedTitle ? ` ${normalizedTitle}` : ""
  }`.trim();
  const href = buildAgentSessionMentionHref(
    input.workspaceId,
    input.agentSessionId,
    input.provider
  );
  const mention = formatAgentMentionMarkdown({
    kind: "session",
    href,
    workspaceId: input.workspaceId,
    targetId: input.agentSessionId,
    name: mentionLabel,
    title: normalizedTitle || providerLabel,
    scope: "my_sessions",
    initiatorName,
    agentName: providerLabel
  });
  const existingDraftPrompt = input.existingDraftPrompt.trim();
  if (!existingDraftPrompt) {
    return `${mention} `;
  }
  if (existingDraftPrompt.includes(href)) {
    return existingDraftPrompt;
  }
  return `${mention} ${existingDraftPrompt}`;
}

export function isAgentSessionActiveTurnConflictError(error: unknown): boolean {
  const message = getAgentGUIRawErrorMessage(error);
  return (
    message
      ?.toLowerCase()
      .includes(AGENT_SESSION_ACTIVE_TURN_CONFLICT_MESSAGE) ?? false
  );
}
