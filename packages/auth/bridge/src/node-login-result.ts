import { DEFAULT_APP_ID } from "./shared";

const USER_CANCELLED_CALLBACK_ERROR = "user_cancelled";
const USER_CANCELLED_RESULT_ERROR = "userCancelled";

export type TuttiAuthErrorCode = "user_cancelled";

export class TuttiAuthError extends Error {
  readonly code: TuttiAuthErrorCode;

  constructor(code: TuttiAuthErrorCode, message = code) {
    super(message);
    this.name = "TuttiAuthError";
    this.code = code;
  }
}

export function isTuttiAuthUserCancelledError(
  error: unknown
): error is TuttiAuthError {
  return (
    error instanceof TuttiAuthError &&
    error.code === USER_CANCELLED_CALLBACK_ERROR
  );
}

export function callbackErrorToError(callbackError: string): Error {
  return callbackError === USER_CANCELLED_CALLBACK_ERROR
    ? new TuttiAuthError(USER_CANCELLED_CALLBACK_ERROR)
    : new Error(callbackError);
}

export function callbackErrorToSafeResultCode(callbackError: string): string {
  return callbackError === USER_CANCELLED_CALLBACK_ERROR
    ? USER_CANCELLED_RESULT_ERROR
    : "providerError";
}

export function buildBridgeResultUrl(
  input: { appCallbackUrl: string; authOrigin: string },
  status: string,
  safeErrorCode?: string
): string {
  const url = new URL("/auth/login/callback", input.authOrigin);
  url.searchParams.set("desktopBridgeStatus", status);
  if (safeErrorCode) {
    url.searchParams.set("desktopBridgeError", safeErrorCode);
  }
  const openAppUrl =
    safeErrorCode === USER_CANCELLED_RESULT_ERROR
      ? null
      : buildSafeOpenAppUrl(input.appCallbackUrl, status, safeErrorCode);
  if (openAppUrl) {
    url.searchParams.set("openAppUrl", openAppUrl);
  }
  return url.toString();
}

function buildSafeOpenAppUrl(
  rawUrl: string,
  status: string,
  safeErrorCode?: string
): string | null {
  try {
    const url = new URL(rawUrl.trim());
    if (!isAllowedAppCallbackProtocol(url.protocol)) {
      return null;
    }
    url.search = "";
    url.hash = "";
    url.searchParams.set("desktopBridgeStatus", status);
    if (safeErrorCode) {
      url.searchParams.set("desktopBridgeError", safeErrorCode);
    }
    return url.toString();
  } catch {
    return null;
  }
}

function isAllowedAppCallbackProtocol(protocol: string): boolean {
  const legacyProtocol = `${DEFAULT_APP_ID}:`;
  const legacyDevProtocol = `${DEFAULT_APP_ID}-dev:`;

  return (
    protocol === "tutti:" ||
    protocol === "tutti-dev:" ||
    protocol === legacyProtocol ||
    protocol === legacyDevProtocol
  );
}
