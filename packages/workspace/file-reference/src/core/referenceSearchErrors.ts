export const REFERENCE_SEARCH_CURSOR_EXPIRED_ERROR_CODE =
  "reference.search_cursor_expired";

export const REFERENCE_SEARCH_CURSOR_LOOP_ERROR_CODE =
  "reference.search_cursor_loop";

export class ReferenceSearchCursorExpiredError extends Error {
  public readonly code = REFERENCE_SEARCH_CURSOR_EXPIRED_ERROR_CODE;

  public constructor(options?: ErrorOptions) {
    super("reference search cursor expired", options);
    this.name = "ReferenceSearchCursorExpiredError";
  }
}

export class ReferenceSearchCursorLoopError extends Error {
  public readonly code = REFERENCE_SEARCH_CURSOR_LOOP_ERROR_CODE;

  public constructor(options?: ErrorOptions) {
    super("reference search cursor did not advance", options);
    this.name = "ReferenceSearchCursorLoopError";
  }
}

export function isReferenceSearchCursorExpiredError(
  error: unknown
): error is ReferenceSearchCursorExpiredError {
  return (
    error instanceof ReferenceSearchCursorExpiredError ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === REFERENCE_SEARCH_CURSOR_EXPIRED_ERROR_CODE)
  );
}
