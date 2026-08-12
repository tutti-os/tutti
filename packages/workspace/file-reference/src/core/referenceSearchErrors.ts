export const REFERENCE_SEARCH_CURSOR_EXPIRED_ERROR_CODE =
  "reference.search_cursor_expired";

export class ReferenceSearchCursorExpiredError extends Error {
  public readonly code = REFERENCE_SEARCH_CURSOR_EXPIRED_ERROR_CODE;

  public constructor(options?: ErrorOptions) {
    super("reference search cursor expired", options);
    this.name = "ReferenceSearchCursorExpiredError";
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
