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
  error: unknown,
  unknownErrorMessage = "Unknown desktop API error."
): DesktopApiErrorDetails {
  try {
    const inspection = inspectDesktopApiError(error);
    if (inspection.details) {
      return inspection.details;
    }
    return {
      code: "UNKNOWN",
      message:
        inspection.message ??
        (inspection.isRecord
          ? unknownErrorMessage
          : safelyStringifyError(error, unknownErrorMessage))
    };
  } catch {
    return {
      code: "UNKNOWN",
      message: unknownErrorMessage
    };
  }
}

export function readDesktopApiErrorDetails(
  error: unknown
): DesktopApiErrorDetails | undefined {
  return inspectDesktopApiError(error).details;
}

function inspectDesktopApiError(error: unknown): {
  details?: DesktopApiErrorDetails;
  isRecord: boolean;
  message?: string;
} {
  const value = safelyReadRecord(error);
  const code = readNonEmptyString(safelyReadProperty(value, "code"));
  const message = readNonEmptyString(safelyReadProperty(value, "message"));
  if (!value || !code || !message) {
    return { isRecord: value !== undefined, ...(message ? { message } : {}) };
  }
  const reason = readNonEmptyString(safelyReadProperty(value, "reason"));
  const developerMessage = readNonEmptyString(
    safelyReadProperty(value, "developerMessage")
  );
  const correlationId = readNonEmptyString(
    safelyReadProperty(value, "correlationId")
  );
  const params = safelyCloneRecord(safelyReadProperty(value, "params"));
  const retryable = safelyReadProperty(value, "retryable");
  return {
    details: {
      code,
      message,
      ...(reason ? { reason } : {}),
      ...(params ? { params } : {}),
      ...(typeof retryable === "boolean" ? { retryable } : {}),
      ...(developerMessage ? { developerMessage } : {}),
      ...(correlationId ? { correlationId } : {})
    },
    isRecord: true,
    message
  };
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function safelyReadProperty(
  value: Record<string, unknown> | undefined,
  key: string
): unknown {
  try {
    return value?.[key];
  } catch {
    return undefined;
  }
}

function safelyReadRecord(value: unknown): Record<string, unknown> | undefined {
  try {
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function safelyCloneRecord(
  value: unknown
): Record<string, unknown> | undefined {
  try {
    if (!isRecord(value)) {
      return undefined;
    }
    const snapshot: unknown = structuredClone(value);
    return isRecord(snapshot) ? snapshot : undefined;
  } catch {
    return undefined;
  }
}

function safelyStringifyError(value: unknown, fallbackMessage: string): string {
  try {
    const message = String(value).trim();
    return message || fallbackMessage;
  } catch {
    return fallbackMessage;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
