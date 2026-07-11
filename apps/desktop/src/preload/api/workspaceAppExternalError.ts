import { normalizeDesktopApiErrorDetails } from "../../shared/desktopApiError.ts";

export function normalizeWorkspaceAppExternalErrorDetails(
  error: unknown,
  getUnknownErrorMessage: () => string
): ReturnType<typeof normalizeDesktopApiErrorDetails> {
  return normalizeDesktopApiErrorDetails(error, getUnknownErrorMessage());
}
