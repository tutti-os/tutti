import type { Event, Session, WebContents, WebPreferences } from "electron";

const authorizationWebviewMarker = "data-tutti-authorization-webview";
const authorizationPartitionPattern =
  /^tutti-authorization:[A-Za-z0-9._-]{1,128}$/;

interface PendingAuthorizationWebview {
  origin: string;
  session: Session;
}

export interface AuthorizationWebviewSecurityInput {
  params: Record<string, string>;
  webPreferences: WebPreferences;
}

export interface AuthorizationWebviewSecurityResult {
  allowed: boolean;
  origin: string | null;
  reason: string | null;
}

function resolveSafeHttpsUrl(value: string | undefined): URL | null {
  try {
    const parsed = new URL(value ?? "");
    if (
      parsed.protocol !== "https:" ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function isAuthorizationWebviewAttach(
  params: Readonly<Record<string, string>>
): boolean {
  return params[authorizationWebviewMarker] === "true";
}

export function enforceAuthorizationWebviewSecurity({
  params,
  webPreferences
}: AuthorizationWebviewSecurityInput): AuthorizationWebviewSecurityResult {
  webPreferences.allowRunningInsecureContent = false;
  webPreferences.contextIsolation = true;
  webPreferences.javascript = true;
  webPreferences.nodeIntegration = false;
  webPreferences.nodeIntegrationInSubFrames = false;
  webPreferences.plugins = false;
  webPreferences.sandbox = true;
  webPreferences.webSecurity = true;
  delete webPreferences.preload;

  const partition = params.partition;
  if (!partition || !authorizationPartitionPattern.test(partition)) {
    return {
      allowed: false,
      origin: null,
      reason: "Unsupported authorization session partition"
    };
  }

  const initialUrl = resolveSafeHttpsUrl(params.src);
  if (!initialUrl) {
    return {
      allowed: false,
      origin: null,
      reason: "Authorization webviews require a credential-free HTTPS URL"
    };
  }

  params.src = initialUrl.toString();
  delete params.allowpopups;
  return { allowed: true, origin: initialUrl.origin, reason: null };
}

export interface InstallAuthorizationWebviewSecurityInput {
  contents: WebContents;
  openExternal: (url: string) => Promise<void> | void;
  resolveSession: (partition: string) => Session;
}

export function installAuthorizationWebviewSecurity({
  contents,
  openExternal,
  resolveSession
}: InstallAuthorizationWebviewSecurityInput): () => void {
  const pendingAttaches: PendingAuthorizationWebview[] = [];

  const handleWillAttachWebview = (
    event: Event,
    webPreferences: WebPreferences,
    params: Record<string, string>
  ) => {
    if (!isAuthorizationWebviewAttach(params)) return;

    const result = enforceAuthorizationWebviewSecurity({
      params,
      webPreferences
    });
    if (!result.allowed || !result.origin) {
      event.preventDefault();
      return;
    }

    const partition = params.partition;
    if (!partition) {
      event.preventDefault();
      return;
    }
    pendingAttaches.push({
      origin: result.origin,
      session: resolveSession(partition)
    });
  };

  const handleDidAttachWebview = (
    _event: Event,
    guestContents: WebContents
  ) => {
    const pendingIndex = pendingAttaches.findIndex(
      (candidate) => candidate.session === guestContents.session
    );
    if (pendingIndex < 0) return;
    const [pending] = pendingAttaches.splice(pendingIndex, 1);
    if (!pending) return;

    const openSafeExternal = (url: string) => {
      const parsed = resolveSafeHttpsUrl(url);
      if (parsed) {
        void Promise.resolve(openExternal(parsed.toString())).catch(
          () => undefined
        );
      }
    };
    const keepNavigationOnOrigin = (event: Event, url: string) => {
      const parsed = resolveSafeHttpsUrl(url);
      if (parsed?.origin === pending.origin) return;
      event.preventDefault();
      openSafeExternal(url);
    };

    guestContents.on("will-navigate", keepNavigationOnOrigin);
    guestContents.on("will-redirect", keepNavigationOnOrigin);
    guestContents.setWindowOpenHandler(({ url }) => {
      openSafeExternal(url);
      return { action: "deny" };
    });
  };

  contents.on("will-attach-webview", handleWillAttachWebview);
  contents.on("did-attach-webview", handleDidAttachWebview);

  return () => {
    pendingAttaches.length = 0;
    contents.off("will-attach-webview", handleWillAttachWebview);
    contents.off("did-attach-webview", handleDidAttachWebview);
  };
}
