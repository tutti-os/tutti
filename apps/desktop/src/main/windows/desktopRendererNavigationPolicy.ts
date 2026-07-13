import type { DesktopLogger } from "../logging.ts";

interface DesktopRendererNavigationEvent {
  preventDefault(): void;
}

type DesktopRendererNavigationListener = (
  event: DesktopRendererNavigationEvent,
  url: string
) => void;

interface DesktopRendererNavigationTarget {
  on(
    event: "will-navigate" | "will-redirect",
    listener: DesktopRendererNavigationListener
  ): unknown;
  off(
    event: "will-navigate" | "will-redirect",
    listener: DesktopRendererNavigationListener
  ): unknown;
  setWindowOpenHandler(
    handler: (details: { url: string }) => { action: "deny" }
  ): unknown;
}

export interface DesktopRendererNavigationPolicy {
  authorize(url: string): void;
  dispose(): void;
}

export function installDesktopRendererNavigationPolicy(input: {
  contents: DesktopRendererNavigationTarget;
  logger: Pick<DesktopLogger, "warn">;
  openExternal(url: string): Promise<void> | void;
}): DesktopRendererNavigationPolicy {
  let authorizedUrl: string | null = null;

  const externalize = (url: string, source: "navigation" | "window-open") => {
    const parsed = parseUrl(url);
    if (
      !parsed ||
      (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    ) {
      return;
    }
    void Promise.resolve(input.openExternal(parsed.href)).catch((error) => {
      input.logger.warn("desktop renderer external navigation failed", {
        error: error instanceof Error ? error.message : String(error),
        origin: parsed.origin,
        source
      });
    });
  };

  const blockNavigation = (
    event: DesktopRendererNavigationEvent,
    url: string,
    source: "navigation" | "redirect"
  ) => {
    const candidateUrl = normalizeUrl(url);
    if (authorizedUrl !== null && candidateUrl === authorizedUrl) {
      return;
    }
    event.preventDefault();
    input.logger.warn("desktop renderer navigation blocked", {
      authorizedOrigin: summarizeOrigin(authorizedUrl),
      candidateOrigin: summarizeOrigin(candidateUrl),
      source
    });
    if (source === "navigation") {
      externalize(url, "navigation");
    }
  };

  const handleWillNavigate: DesktopRendererNavigationListener = (event, url) =>
    blockNavigation(event, url, "navigation");
  const handleWillRedirect: DesktopRendererNavigationListener = (event, url) =>
    blockNavigation(event, url, "redirect");

  input.contents.on("will-navigate", handleWillNavigate);
  input.contents.on("will-redirect", handleWillRedirect);
  input.contents.setWindowOpenHandler(({ url }) => {
    externalize(url, "window-open");
    return { action: "deny" };
  });

  return {
    authorize(url) {
      const normalized = normalizeUrl(url);
      if (!normalized) {
        throw new Error("Desktop renderer navigation URL is invalid");
      }
      if (authorizedUrl !== null && authorizedUrl !== normalized) {
        throw new Error("Desktop renderer navigation intent is immutable");
      }
      authorizedUrl = normalized;
    },
    dispose() {
      input.contents.off("will-navigate", handleWillNavigate);
      input.contents.off("will-redirect", handleWillRedirect);
    }
  };
}

function normalizeUrl(value: string | null): string | null {
  if (!value) {
    return null;
  }
  return parseUrl(value)?.href ?? null;
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function summarizeOrigin(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const parsed = parseUrl(value);
  if (!parsed) {
    return null;
  }
  return parsed.protocol === "file:" ? "file:" : parsed.origin;
}
