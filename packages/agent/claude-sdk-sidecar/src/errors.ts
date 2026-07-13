export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function errorPayload(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { message: String(error) };
  }
  const result: Record<string, unknown> = {
    name: error.name,
    message: error.message
  };
  const withCode = error as Error & {
    code?: unknown;
    status?: unknown;
    cause?: unknown;
  };
  if (withCode.code !== undefined) {
    result.code = withCode.code;
  }
  if (withCode.status !== undefined) {
    result.status = withCode.status;
  }
  if (withCode.cause !== undefined) {
    result.cause = errorPayload(withCode.cause);
  }
  if (error.stack) {
    result.stack = error.stack;
  }
  return result;
}
