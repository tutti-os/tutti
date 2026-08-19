import { normalizeTuttidError, TuttidTransportError } from "./errors.ts";

interface ClientResponse<TResult> {
  data?: TResult;
  error?: unknown;
  response?: Response;
}

export function unwrapData<TResult>(
  response: ClientResponse<TResult>,
  fallback: string
): TResult {
  if ("error" in response && response.error !== undefined) {
    throw parseTuttidError(response.error, response.response?.status, fallback);
  }

  if (response.data === undefined) {
    throw new Error(fallback);
  }

  return response.data;
}

export function unwrapAccepted(
  response: { error?: unknown; response?: Response },
  fallback: string
): void {
  if ("error" in response && response.error !== undefined) {
    throw parseTuttidError(response.error, response.response?.status, fallback);
  }
}

function parseTuttidError(
  error: unknown,
  statusCode: number | undefined,
  fallback: string
): Error {
  const normalizedError = normalizeTuttidError(error, statusCode ?? 0);
  if (normalizedError) {
    return normalizedError;
  }

  const errorPayload =
    error && typeof error === "object" && "error" in error
      ? error.error
      : undefined;

  if (typeof errorPayload === "string" && errorPayload.trim()) {
    return new Error(errorPayload);
  }

  if (typeof error === "string" && error.trim()) {
    return new Error(error);
  }

  if (error instanceof Error) {
    return new TuttidTransportError(fallback, error);
  }

  return new Error(fallback);
}
