import type { ApiErrorDetails, ApiErrorResponse } from "./generated/index.ts";

export type TuttidProtocolErrorCode = ApiErrorDetails["code"];
export type TuttidProtocolErrorParams = NonNullable<ApiErrorDetails["params"]>;

const tuttidProtocolErrorCodes = new Set<TuttidProtocolErrorCode>([
  "invalid_request",
  "method_not_allowed",
  "unauthorized",
  "service_unavailable",
  "agent_quick_prompt_not_found",
  "agent_quick_prompt_conflict",
  "agent_quick_prompt_operation_failed",
  "workspace_not_found",
  "workspace_file_not_found",
  "workspace_issue_resource_exists",
  "workspace_issue_resource_not_found",
  "workspace_terminal_not_found",
  "workspace_app_not_found",
  "workspace_operation_failed",
  "preferences_operation_failed"
]);

export interface TuttidProtocolErrorOptions {
  code: TuttidProtocolErrorCode;
  correlationId?: string;
  developerMessage?: string;
  params?: TuttidProtocolErrorParams;
  reason?: string;
  retryable?: boolean;
  statusCode: number;
}

export class TuttidProtocolError extends Error {
  readonly code: TuttidProtocolErrorCode;
  readonly correlationId?: string;
  readonly developerMessage?: string;
  readonly params: TuttidProtocolErrorParams;
  readonly reason?: string;
  readonly retryable: boolean;
  readonly statusCode: number;

  constructor(options: TuttidProtocolErrorOptions) {
    super(
      options.developerMessage ??
        `tuttid request failed with protocol code ${options.code}`
    );
    this.name = "TuttidProtocolError";
    this.code = options.code;
    this.correlationId = options.correlationId;
    this.developerMessage = options.developerMessage;
    this.params = options.params ?? {};
    this.reason = options.reason;
    this.retryable = options.retryable ?? false;
    this.statusCode = options.statusCode;
  }
}

export function isTuttidProtocolError(
  error: unknown
): error is TuttidProtocolError {
  return error instanceof TuttidProtocolError;
}

export function getTuttidProtocolErrorCode(error: unknown): string | null {
  const normalizedError = normalizeTuttidError(error);
  return normalizedError?.code ?? null;
}

export function normalizeTuttidError(
  error: unknown,
  statusCode = 0
): TuttidProtocolError | null {
  if (error instanceof TuttidProtocolError) {
    return error;
  }

  const details = extractProtocolErrorDetails(error);
  if (!details) {
    return null;
  }

  return new TuttidProtocolError({
    code: details.code,
    correlationId: details.correlationId,
    developerMessage: details.developerMessage,
    params: details.params,
    reason: details.reason,
    retryable: details.retryable,
    statusCode
  });
}

export function getTuttidErrorI18nCandidates(error: unknown): string[] {
  const normalizedError = normalizeTuttidError(error);
  if (!normalizedError) {
    return [];
  }

  const candidates: string[] = [];
  if (normalizedError.reason) {
    candidates.push(`errors.${normalizedError.code}.${normalizedError.reason}`);
  }
  candidates.push(`errors.${normalizedError.code}.default`);
  candidates.push(`errors.${normalizedError.code}`);
  return candidates;
}

function extractProtocolErrorDetails(error: unknown): ApiErrorDetails | null {
  if (isApiErrorDetails(error)) {
    return error;
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "error" in error &&
    isApiErrorDetails((error as ApiErrorResponse).error)
  ) {
    return (error as ApiErrorResponse).error;
  }

  return null;
}

function isApiErrorDetails(value: unknown): value is ApiErrorDetails {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    typeof value.code === "string" &&
    tuttidProtocolErrorCodes.has(value.code as TuttidProtocolErrorCode)
  );
}
