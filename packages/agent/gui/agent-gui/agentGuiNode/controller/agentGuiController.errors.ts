import { translate } from "../../../i18n/index";
import type { AppErrorCode } from "../../../shared/contracts/dto";
import { getAppErrorCode } from "../../../shared/errors/appError";

export const AGENT_PROVIDER_SESSION_NOT_FOUND_ERROR =
  "agent.provider_session_not_found";
export const AGENT_RESUME_SESSION_NOT_LOCAL_ERROR =
  "agent.resume_session_not_local";
export const AGENT_SETTINGS_REQUIRE_NEW_SESSION_ERROR =
  "agent.settings_require_new_session";
export const AGENT_SESSION_NOT_FOUND_ERROR = "session.not_found";
export const AGENT_PROVIDER_SESSION_NOT_FOUND_FALLBACK_MESSAGE =
  "The previous agent session can no longer be restored.";
export const AGENT_RESUME_SESSION_NOT_LOCAL_FALLBACK_MESSAGE =
  "The previous agent session is not available on this machine.";
export const AGENT_GUI_CAUGHT_ERROR_STACK_LIMIT = 4000;

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
  return value.length <= AGENT_GUI_CAUGHT_ERROR_STACK_LIMIT
    ? value
    : `${value.slice(0, AGENT_GUI_CAUGHT_ERROR_STACK_LIMIT)}...`;
}

export function getAgentGUIErrorCode(error: unknown): AppErrorCode | null {
  return (
    getAppErrorCode(error) ??
    inferAgentGUIErrorCodeFromReason(getAgentGUIErrorReason(error)) ??
    inferAgentGUIErrorCodeFromMessage(getAgentGUIRawErrorMessage(error))
  );
}

export function getAgentGUIErrorReason(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const reason = (error as { reason?: unknown }).reason;
  return typeof reason === "string" && reason.trim() ? reason.trim() : null;
}

export function inferAgentGUIErrorCodeFromReason(
  reason: string | null
): AppErrorCode | null {
  return reason === AGENT_SETTINGS_REQUIRE_NEW_SESSION_ERROR
    ? (AGENT_SETTINGS_REQUIRE_NEW_SESSION_ERROR as AppErrorCode)
    : null;
}

export function inferAgentGUIErrorCodeFromMessage(
  message: string | null
): AppErrorCode | null {
  switch (message?.trim()) {
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
): { code: AppErrorCode; message: string; debugMessage?: string } {
  const normalizedMessage = message?.trim() || null;
  return {
    code: AGENT_PROVIDER_SESSION_NOT_FOUND_ERROR,
    message: translate("messages.agentProviderSessionNotFound"),
    ...(normalizedMessage ? { debugMessage: normalizedMessage } : {})
  };
}

export function buildResumeSessionNotLocalActivationError(
  message?: string | null
): { code: AppErrorCode; message: string; debugMessage?: string } {
  const normalizedMessage = message?.trim() || null;
  return {
    code: AGENT_RESUME_SESSION_NOT_LOCAL_ERROR,
    message: translate("messages.agentResumeSessionNotLocal"),
    ...(normalizedMessage ? { debugMessage: normalizedMessage } : {})
  };
}

export function getAgentGUIErrorMessage(error: unknown): string {
  const code = getAgentGUIErrorCode(error);
  if (isProviderSessionNotFoundErrorCode(code))
    return translate("messages.agentProviderSessionNotFound");
  if (isResumeSessionNotLocalErrorCode(code))
    return translate("messages.agentResumeSessionNotLocal");
  if (isSettingsRequireNewSessionErrorCode(code))
    return translate("messages.agentSettingsRequireNewSession");
  if (error && typeof error === "object") {
    const debugMessage = (error as { debugMessage?: unknown }).debugMessage;
    if (typeof debugMessage === "string" && debugMessage.trim())
      return debugMessage.trim();
  }
  return error instanceof Error ? error.message : String(error);
}

export function getAgentGUIRawErrorMessage(error: unknown): string | null {
  if (error && typeof error === "object") {
    const debugMessage = (error as { debugMessage?: unknown }).debugMessage;
    if (typeof debugMessage === "string" && debugMessage.trim())
      return debugMessage.trim();
  }
  if (error instanceof Error && error.message.trim())
    return error.message.trim();
  if (typeof error === "string" && error.trim()) return error.trim();
  return null;
}
