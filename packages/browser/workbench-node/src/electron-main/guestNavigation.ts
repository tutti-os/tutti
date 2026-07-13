import type {
  BrowserNodeNavigationPolicy,
  BrowserNodeRuntimeError
} from "../core/types.ts";
import {
  resolveBrowserNavigationUrl,
  type BrowserNavigationUrlResolution
} from "../core/url.ts";
import type {
  BrowserGuestManagerInput,
  BrowserGuestNativeImage,
  BrowserGuestWebContents
} from "./types.ts";

const browserPreviewMaxWidth = 260;
const browserPreviewMaxHeight = 170;
const abortedNavigationErrorCode = -3;

export function canGuestGoBack(contents: BrowserGuestWebContents): boolean {
  return contents.navigationHistory?.canGoBack() ?? contents.canGoBack();
}

export function canGuestGoForward(contents: BrowserGuestWebContents): boolean {
  return contents.navigationHistory?.canGoForward() ?? contents.canGoForward();
}

export function goGuestBack(contents: BrowserGuestWebContents): void {
  if (contents.navigationHistory) {
    contents.navigationHistory.goBack();
    return;
  }
  contents.goBack();
}

export function goGuestForward(contents: BrowserGuestWebContents): void {
  if (contents.navigationHistory) {
    contents.navigationHistory.goForward();
    return;
  }
  contents.goForward();
}

export function resolveBrowserNodeUrlError(
  resolved: BrowserNavigationUrlResolution
): BrowserNodeRuntimeError {
  if (resolved.errorCode === "invalid-url") {
    return { code: "invalid-url" };
  }
  if (resolved.errorCode === "unsupported-protocol") {
    return {
      code: "unsupported-protocol",
      params: resolved.errorParams
    };
  }
  return { code: "unsupported-url" };
}

export function resizeBrowserPreviewImage(
  image: BrowserGuestNativeImage
): BrowserGuestNativeImage {
  if (image.isEmpty?.() === true || !image.resize || !image.getSize) {
    return image;
  }
  const size = image.getSize();
  if (size.width <= 0 || size.height <= 0) {
    return image;
  }
  const scale = Math.min(
    1,
    browserPreviewMaxWidth / size.width,
    browserPreviewMaxHeight / size.height
  );
  if (scale >= 1) {
    return image;
  }
  return image.resize({
    height: Math.max(1, Math.round(size.height * scale)),
    quality: "good",
    width: Math.max(1, Math.round(size.width * scale))
  });
}

export function isAbortedNavigationError(input: {
  errorCode?: number;
  errorDescription?: string;
}): boolean {
  return (
    input.errorCode === abortedNavigationErrorCode ||
    input.errorDescription === "ERR_ABORTED"
  );
}

export function isHttpErrorStatusCode(statusCode: number | undefined): boolean {
  return statusCode !== undefined && statusCode >= 400;
}

export function emitBrowserNavigationFailed(input: {
  emit: BrowserGuestManagerInput["emit"];
  errorCode?: number;
  errorDescription?: string;
  nodeId: string;
}): void {
  input.emit({
    code: "navigation-failed",
    diagnosticMessage: input.errorDescription,
    nodeId: input.nodeId,
    params:
      input.errorCode === undefined
        ? undefined
        : { errorCode: input.errorCode },
    type: "error"
  });
}

export function isGoogleGisOAuthPopupUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname !== "accounts.google.com" ||
      (parsed.pathname !== "/o/oauth2/v2/auth" &&
        parsed.pathname !== "/o/oauth2/auth")
    ) {
      return false;
    }
    const isGisSdkPopup =
      parsed.searchParams.get("gsiwebsdk") === "gis_attributes";
    const isPopupResponse =
      parsed.searchParams.get("display") === "popup" &&
      (parsed.searchParams.get("response_mode") === "form_post" ||
        parsed.searchParams.get("redirect_uri") === "gis_transform");
    return isGisSdkPopup || isPopupResponse;
  } catch {
    return false;
  }
}

export function isBrowserNavigationAllowedByPolicy(input: {
  policy: BrowserNodeNavigationPolicy | null;
  url: string;
}): boolean {
  if (!input.policy) {
    return true;
  }
  if (input.policy.mode === "same-origin") {
    const policyOrigin = resolveBrowserNavigationOrigin(input.policy.originUrl);
    const nextOrigin = resolveBrowserNavigationOrigin(input.url);
    return (
      policyOrigin !== null &&
      nextOrigin !== null &&
      policyOrigin === nextOrigin
    );
  }
  return true;
}

function resolveBrowserNavigationOrigin(url: string): string | null {
  const resolved = resolveBrowserNavigationUrl(url);
  if (!resolved.url) {
    return null;
  }
  try {
    return new URL(resolved.url).origin;
  } catch {
    return null;
  }
}
