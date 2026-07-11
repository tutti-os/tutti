import type { DesktopApiErrorDetails } from "./contracts/ipc.ts";

export class DesktopApiError extends Error {
  readonly code: string;
  readonly reason?: string;
  readonly params?: Record<string, unknown>;
  readonly retryable?: boolean;
  readonly developerMessage?: string;
  readonly correlationId?: string;

  constructor(details: DesktopApiErrorDetails) {
    super(details.message);
    this.name = "DesktopApiError";
    this.code = details.code;
    this.reason = details.reason;
    this.params = details.params;
    this.retryable = details.retryable;
    this.developerMessage = details.developerMessage;
    this.correlationId = details.correlationId;
  }
}

export function normalizeDesktopApiErrorDetails(
  error: unknown
): DesktopApiErrorDetails {
  try {
    const structured = readDesktopApiErrorDetails(error);
    if (structured) {
      return structured;
    }
    const value = isRecord(error) ? error : undefined;
    const message =
      error instanceof Error
        ? readNonEmptyString(error.message)
        : readNonEmptyString(value?.message);
    return {
      code: "UNKNOWN",
      message:
        message ??
        (error instanceof Error
          ? "Unknown desktop API error."
          : safelyStringifyError(error))
    };
  } catch {
    return {
      code: "UNKNOWN",
      message: "Unknown desktop API error."
    };
  }
}

export function readDesktopApiErrorDetails(
  error: unknown
): DesktopApiErrorDetails | undefined {
  try {
    const value = isRecord(error) ? error : undefined;
    const code = readNonEmptyString(value?.code);
    const message =
      error instanceof Error
        ? readNonEmptyString(error.message)
        : readNonEmptyString(value?.message);
    if (!value || !code || !message) {
      return undefined;
    }
    const reason = readNonEmptyString(value?.reason);
    const developerMessage = readNonEmptyString(value?.developerMessage);
    const correlationId = readNonEmptyString(value?.correlationId);
    return {
      code,
      message,
      ...(reason ? { reason } : {}),
      ...(isRecord(value?.params) ? { params: value.params } : {}),
      ...(typeof value?.retryable === "boolean"
        ? { retryable: value.retryable }
        : {}),
      ...(developerMessage ? { developerMessage } : {}),
      ...(correlationId ? { correlationId } : {})
    };
  } catch {
    return undefined;
  }
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function safelyStringifyError(value: unknown): string {
  try {
    const message = String(value).trim();
    return message || "Unknown desktop API error.";
  } catch {
    return "Unknown desktop API error.";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
