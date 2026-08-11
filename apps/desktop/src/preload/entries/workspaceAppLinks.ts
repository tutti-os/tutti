const workspaceAppOpenUrlChannel = "workspace-app:open-url";

interface WorkspaceAppMainWorldExecutionScript {
  args?: unknown[];
  func: (...args: never[]) => unknown;
}

interface WorkspaceAppLinkInterceptionOptions {
  executeInMainWorld?: (
    script: WorkspaceAppMainWorldExecutionScript
  ) => unknown;
  reportDiagnostic?: (
    diagnostic: WorkspaceAppLinkInterceptionDiagnostic
  ) => void;
  scope: Window;
  send(this: void, channel: string, payload: unknown): void;
}

export function installWorkspaceAppLinkInterception({
  executeInMainWorld,
  reportDiagnostic,
  scope,
  send
}: WorkspaceAppLinkInterceptionOptions): () => void {
  return installPreloadLinkInterception({
    executeInMainWorld,
    reportDiagnostic,
    scope,
    sendOpenUrl(url) {
      send(workspaceAppOpenUrlChannel, {
        operationId: globalThis.crypto.randomUUID(),
        url
      });
    }
  });
}

export function installPreloadLinkInterception({
  executeInMainWorld,
  reportDiagnostic,
  scope,
  sendOpenUrl
}: {
  executeInMainWorld?: (
    script: WorkspaceAppMainWorldExecutionScript
  ) => unknown;
  reportDiagnostic?: (
    diagnostic: WorkspaceAppLinkInterceptionDiagnostic
  ) => void;
  scope: Window;
  sendOpenUrl: (url: string) => void;
}): () => void {
  installMainWorldOpenInterception({ executeInMainWorld, reportDiagnostic });

  const originalOpen =
    typeof scope.open === "function" ? scope.open.bind(scope) : null;
  if (originalOpen) {
    scope.open = (url?: string | URL, target?: string, features?: string) => {
      if (shouldNavigateOpenInPlace(target)) {
        const resolvedSameOriginUrl = resolveSameOriginUrl(scope, url);
        if (resolvedSameOriginUrl) {
          scope.location.assign(resolvedSameOriginUrl);
          return scope;
        }
      }

      return originalOpen.call(scope, url, target, features);
    };
  }

  const handleClick = (event: MouseEvent) => {
    const anchor = resolveAnchorTarget(event);
    if (!anchor) {
      return;
    }

    const href = anchor.href.trim();
    const target = anchor.getAttribute("target")?.trim().toLowerCase() ?? "";
    if (target !== "_blank") {
      return;
    }
    if (!isInterceptableBlankTarget(anchor)) {
      reportDiagnostic?.({
        action: "skip",
        href,
        reason: anchor.hasAttribute("download")
          ? "download-link"
          : href.startsWith("javascript:")
            ? "javascript-url"
            : "invalid-url",
        target
      });
      return;
    }
    if (!shouldInterceptMouseOpen(event)) {
      reportDiagnostic?.({
        action: "skip",
        button: event.button,
        defaultPrevented: event.defaultPrevented,
        href,
        modifiers: getMouseModifiers(event),
        reason: event.defaultPrevented
          ? "default-prevented"
          : event.button !== 0
            ? "non-left-click"
            : hasMouseModifier(event)
              ? "modified-click"
              : "not-interceptable",
        target
      });
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    const resolvedSameOriginUrl = resolveSameOriginUrl(scope, href);
    if (resolvedSameOriginUrl) {
      reportDiagnostic?.({
        action: "navigate-in-place",
        button: event.button,
        defaultPrevented: event.defaultPrevented,
        href,
        modifiers: getMouseModifiers(event),
        target,
        url: resolvedSameOriginUrl
      });
      scope.location.assign(resolvedSameOriginUrl);
      return;
    }

    reportDiagnostic?.({
      action: "open-url",
      button: event.button,
      defaultPrevented: event.defaultPrevented,
      href,
      modifiers: getMouseModifiers(event),
      target
    });
    sendOpenUrl(href);
  };

  reportDiagnostic?.({
    action: "installed",
    readyState: scope.document.readyState,
    url: scope.location.href
  });
  scope.addEventListener("click", handleClick, true);

  return () => {
    if (originalOpen) {
      scope.open = originalOpen;
    }
    scope.removeEventListener("click", handleClick, true);
  };
}

function installMainWorldOpenInterception({
  executeInMainWorld,
  reportDiagnostic
}: {
  executeInMainWorld?: (
    script: WorkspaceAppMainWorldExecutionScript
  ) => unknown;
  reportDiagnostic?: (
    diagnostic: WorkspaceAppLinkInterceptionDiagnostic
  ) => void;
}): void {
  if (!executeInMainWorld) {
    return;
  }

  try {
    const installed = executeInMainWorld({
      func: installWorkspaceAppMainWorldOpenInterception
    });
    reportDiagnostic?.(
      installed
        ? { action: "installed-main-world" }
        : {
            action: "skip",
            reason: "main-world-window-open-unavailable"
          }
    );
  } catch (error) {
    reportDiagnostic?.({
      action: "skip",
      reason: "main-world-install-failed",
      url: error instanceof Error ? error.message : String(error)
    });
  }
}

function installWorkspaceAppMainWorldOpenInterception(): boolean {
  const scope = globalThis.window;
  const patchKey = "__tuttiWorkspaceAppWindowOpenPatched";
  const globalScope = scope as Window & {
    [patchKey]?: boolean;
  };
  if (globalScope[patchKey]) {
    return true;
  }

  const originalOpen =
    typeof scope.open === "function" ? scope.open.bind(scope) : null;
  if (!originalOpen) {
    return false;
  }

  globalScope[patchKey] = true;
  scope.open = (url?: string | URL, target?: string, features?: string) => {
    if (shouldNavigate(target)) {
      const resolvedSameOriginUrl = resolveSameOrigin(url, scope.location.href);
      if (resolvedSameOriginUrl) {
        scope.location.assign(resolvedSameOriginUrl);
        return scope;
      }
    }

    return originalOpen.call(scope, url, target, features);
  };

  return true;

  function shouldNavigate(target: string | undefined): boolean {
    const normalizedTarget = target?.trim().toLowerCase() ?? "";
    return normalizedTarget.length === 0 || normalizedTarget === "_blank";
  }

  function resolveSameOrigin(
    url: string | URL | undefined,
    currentHref: string
  ): string | null {
    if (url === undefined) {
      return null;
    }

    const rawUrl = url.toString().trim();
    if (rawUrl.length === 0) {
      return null;
    }

    try {
      const currentUrl = new URL(currentHref);
      const nextUrl = new URL(rawUrl, currentUrl);
      return nextUrl.origin === currentUrl.origin ? nextUrl.href : null;
    } catch {
      return null;
    }
  }
}

function shouldNavigateOpenInPlace(target: string | undefined): boolean {
  const normalizedTarget = target?.trim().toLowerCase() ?? "";
  return normalizedTarget.length === 0 || normalizedTarget === "_blank";
}

function resolveSameOriginUrl(
  scope: Window,
  url: string | URL | undefined
): string | null {
  if (url === undefined) {
    return null;
  }

  const rawUrl = url.toString().trim();
  if (rawUrl.length === 0) {
    return null;
  }

  try {
    const currentUrl = new URL(scope.location.href);
    const nextUrl = new URL(rawUrl, currentUrl);
    return nextUrl.origin === currentUrl.origin ? nextUrl.href : null;
  } catch {
    return null;
  }
}

function resolveAnchorTarget(event: Event): HTMLAnchorElement | null {
  const path =
    typeof event.composedPath === "function"
      ? event.composedPath()
      : [event.target].filter(Boolean);

  for (const entry of path) {
    if (entry instanceof HTMLAnchorElement) {
      return entry;
    }
    if (entry instanceof Element) {
      const anchor = entry.closest("a[href]");
      if (anchor instanceof HTMLAnchorElement) {
        return anchor;
      }
    }
  }

  let current = event.target;
  while (current instanceof Element) {
    if (
      current instanceof HTMLAnchorElement &&
      current.href.trim().length > 0
    ) {
      return current;
    }
    current = current.parentElement;
  }

  return null;
}

function isInterceptableBlankTarget(anchor: HTMLAnchorElement): boolean {
  const href = anchor.href.trim();
  if (href.length === 0 || anchor.hasAttribute("download")) {
    return false;
  }

  const target = anchor.getAttribute("target")?.trim().toLowerCase() ?? "";
  if (target !== "_blank") {
    return false;
  }

  return !href.startsWith("javascript:");
}

interface WorkspaceAppLinkInterceptionDiagnostic {
  readonly action:
    | "installed"
    | "installed-main-world"
    | "navigate-in-place"
    | "open-url"
    | "skip";
  readonly button?: number;
  readonly defaultPrevented?: boolean;
  readonly href?: string;
  readonly modifiers?: {
    readonly alt: boolean;
    readonly ctrl: boolean;
    readonly meta: boolean;
    readonly shift: boolean;
  };
  readonly readyState?: string;
  readonly reason?: string;
  readonly target?: string;
  readonly url?: string;
}

function getMouseModifiers(event: MouseEvent): {
  alt: boolean;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
} {
  return {
    alt: event.altKey,
    ctrl: event.ctrlKey,
    meta: event.metaKey,
    shift: event.shiftKey
  };
}

function hasMouseModifier(event: MouseEvent): boolean {
  return event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
}

function shouldInterceptMouseOpen(event: MouseEvent): boolean {
  return (
    !event.defaultPrevented && event.button === 0 && !hasMouseModifier(event)
  );
}
