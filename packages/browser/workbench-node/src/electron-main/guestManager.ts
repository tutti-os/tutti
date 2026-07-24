import type {
  BrowserNodeAutomationTargetMetadata,
  BrowserNodeLifecycle,
  BrowserNodeNavigationPolicy,
  BrowserNodeSessionMode
} from "../core/types.ts";
import {
  normalizeHostBrowserComparableUrl,
  resolveBrowserNavigationUrl,
  resolveHostBrowserNavigationUrl
} from "../core/url.ts";
import type {
  BrowserGuestCookieStore,
  BrowserGuestManager,
  BrowserGuestManagerInput,
  BrowserPreferredColorScheme,
  BrowserGuestWebContents
} from "./types.ts";
import { createBrowserGuestDownloadController } from "./guestDownloads.ts";
import {
  clearBrowserGuestData,
  printBrowserGuestPage,
  readFoundInPageResult,
  saveBrowserGuestScreenshot,
  setBrowserGuestDeviceEmulation,
  setBrowserGuestZoomFactor
} from "./guestPageActions.ts";
import {
  completedCookieImportResult,
  importBrowserGuestCookies
} from "./cookieImport.ts";
import {
  getBrowserGuestCookieImportSession,
  importChromeCookiesIntoBrowserGuest,
  reloadBrowserGuestsForCookieSession
} from "./chromeCookieImportTarget.ts";
import {
  canGuestGoBack,
  canGuestGoForward,
  emitBrowserNavigationFailed,
  goGuestBack,
  goGuestForward,
  isAbortedNavigationError,
  isBrowserNavigationAllowedByPolicy,
  isGoogleGisOAuthPopupUrl,
  isHttpErrorStatusCode,
  resizeBrowserPreviewImage,
  resolveOptionalBrowserNodeDesiredUrl,
  resolveBrowserNodeUrlError
} from "./guestNavigation.ts";

interface BrowserGuestSession {
  appliedColorScheme: BrowserPreferredColorScheme | null;
  automationTarget: BrowserNodeAutomationTargetMetadata | null;
  contents: BrowserGuestWebContents | null;
  desiredUrl: string;
  findQuery: string;
  lifecycle: BrowserNodeLifecycle;
  listeners: Array<{
    event: string;
    listener: (...args: unknown[]) => void;
  }>;
  navigationFailureSequence: number;
  navigationPolicy: BrowserNodeNavigationPolicy | null;
  nodeId: string;
  profileId: string | null;
  sessionMode: BrowserNodeSessionMode;
  sessionPartition: string | null;
  webContentsId: number | null;
}

async function applyPreferredColorSchemeToGuest(
  session: BrowserGuestSession,
  logger: BrowserGuestManagerInput["logger"],
  syncPreferredColorScheme: BrowserGuestManagerInput["syncPreferredColorScheme"],
  scheme: BrowserPreferredColorScheme | null
): Promise<void> {
  const contents = session.contents;
  if (
    !contents ||
    contents.isDestroyed() ||
    !syncPreferredColorScheme ||
    scheme === null ||
    session.appliedColorScheme === scheme
  ) {
    return;
  }

  try {
    await syncPreferredColorScheme(contents, scheme);
    session.appliedColorScheme = scheme;
  } catch (error) {
    session.appliedColorScheme = null;
    logger?.warn?.("Browser Node failed to sync guest color scheme", {
      error: error instanceof Error ? error.message : String(error),
      nodeId: session.nodeId,
      scheme,
      webContentsId: session.webContentsId
    });
  }
}

export function createBrowserGuestManager({
  automationRegistry,
  chooseDownloadDirectory,
  emit,
  getPreferredColorScheme,
  logger,
  openDownloadedFile,
  openExternal,
  prepareSession,
  prepareChromeCookieImport,
  resolveOrdinaryCookieStore,
  resolveOrdinaryCookieSession,
  resolveWebContents,
  saveScreenshot,
  selectCookieImport,
  showDownloadedFile,
  syncPreferredColorScheme,
  subscribePreferredColorScheme
}: BrowserGuestManagerInput): BrowserGuestManager {
  const sessions = new Map<string, BrowserGuestSession>();
  const nodeIdByWebContentsId = new Map<number, string>();
  const downloadController = createBrowserGuestDownloadController({
    emit,
    getNodeIdByWebContentsId: (webContentsId) =>
      nodeIdByWebContentsId.get(webContentsId),
    openDownloadedFile,
    showDownloadedFile
  });
  let preferredColorScheme = getPreferredColorScheme?.() ?? null;

  const getSession = (
    nodeId: string,
    input?: {
      automationTarget?: BrowserNodeAutomationTargetMetadata | null;
      navigationPolicy?: BrowserNodeNavigationPolicy | null;
      profileId?: string | null;
      sessionMode?: BrowserNodeSessionMode;
      sessionPartition?: string | null;
      url?: string;
    }
  ): BrowserGuestSession => {
    const existing = sessions.get(nodeId);
    if (existing) {
      if (input?.automationTarget !== undefined) {
        existing.automationTarget = input.automationTarget;
      }
      if (input?.profileId !== undefined) {
        existing.profileId = input.profileId;
      }
      if (input?.sessionMode !== undefined) {
        existing.sessionMode = input.sessionMode;
      }
      if (input?.sessionPartition !== undefined) {
        existing.sessionPartition = input.sessionPartition;
      }
      if (input?.navigationPolicy !== undefined) {
        existing.navigationPolicy = input.navigationPolicy;
      }
      if (input?.url !== undefined) {
        existing.desiredUrl = input.url;
      }
      return existing;
    }

    const session: BrowserGuestSession = {
      appliedColorScheme: null,
      automationTarget: input?.automationTarget ?? null,
      contents: null,
      desiredUrl: input?.url ?? "about:blank",
      findQuery: "",
      lifecycle: "cold",
      listeners: [],
      navigationFailureSequence: 0,
      navigationPolicy: input?.navigationPolicy ?? null,
      nodeId,
      profileId: input?.profileId ?? null,
      sessionMode: input?.sessionMode ?? "shared",
      sessionPartition: input?.sessionPartition ?? null,
      webContentsId: null
    };
    sessions.set(nodeId, session);
    return session;
  };

  const publishState = (session: BrowserGuestSession): void => {
    const contents =
      session.contents && !session.contents.isDestroyed()
        ? session.contents
        : null;
    emit({
      canGoBack: contents ? canGuestGoBack(contents) : false,
      canGoForward: contents ? canGuestGoForward(contents) : false,
      isAttachedToWindow: Boolean(contents),
      isLoading: contents ? contents.isLoading() : false,
      isOccluded: session.lifecycle === "cold",
      lifecycle: session.lifecycle,
      nodeId: session.nodeId,
      title: contents ? contents.getTitle() || null : null,
      type: "state",
      url: contents
        ? contents.getURL() || session.desiredUrl
        : session.desiredUrl,
      zoomFactor: contents?.zoomFactor ?? 1
    });
  };

  const detachGuest = (session: BrowserGuestSession): void => {
    const contents = session.contents;
    const webContentsId = session.webContentsId;
    if (contents) {
      for (const record of session.listeners) {
        contents.off(record.event, record.listener);
      }
    }
    session.listeners = [];
    automationRegistry?.unregister(session.nodeId, contents);
    session.contents = null;
    session.appliedColorScheme = null;
    session.webContentsId = null;
    if (
      webContentsId !== null &&
      nodeIdByWebContentsId.get(webContentsId) === session.nodeId
    ) {
      nodeIdByWebContentsId.delete(webContentsId);
    }
    publishState(session);
  };

  const handlePreferredColorSchemeChange = (
    scheme: BrowserPreferredColorScheme
  ) => {
    preferredColorScheme = scheme;
    for (const session of sessions.values()) {
      session.appliedColorScheme = null;
      void applyPreferredColorSchemeToGuest(
        session,
        logger,
        syncPreferredColorScheme,
        scheme
      ).catch(() => undefined);
    }
  };

  const unsubscribePreferredColorScheme =
    subscribePreferredColorScheme?.(handlePreferredColorSchemeChange) ?? null;

  const attachGuestListeners = (session: BrowserGuestSession): void => {
    const contents = session.contents;
    if (!contents) {
      return;
    }

    const onStateChange = () => publishState(session);
    const onDidStartNavigation = () => {
      automationRegistry?.invalidate(session.nodeId, contents);
      publishState(session);
    };
    const onDidNavigate = (...args: unknown[]) => {
      const url = typeof args[1] === "string" ? args[1] : undefined;
      const statusCode = typeof args[2] === "number" ? args[2] : undefined;
      const statusText = typeof args[3] === "string" ? args[3] : undefined;
      publishState(session);
      if (!isHttpErrorStatusCode(statusCode)) {
        return;
      }

      logger?.warn?.("Browser Node guest navigation returned HTTP error", {
        currentUrl: contents.getURL(),
        desiredUrl: session.desiredUrl,
        nodeId: session.nodeId,
        statusCode,
        statusText,
        url,
        webContentsId: session.webContentsId
      });
      emit({
        code: "navigation-failed",
        diagnosticMessage: statusText,
        nodeId: session.nodeId,
        params: {
          statusCode,
          ...(statusText ? { statusText } : {})
        },
        type: "error"
      });
    };
    const onFailLoad = (...args: unknown[]) => {
      const errorCode = typeof args[1] === "number" ? args[1] : undefined;
      const errorDescription =
        typeof args[2] === "string" ? args[2] : undefined;
      const validatedUrl = typeof args[3] === "string" ? args[3] : undefined;
      const isMainFrame = typeof args[4] === "boolean" ? args[4] : undefined;
      if (isAbortedNavigationError({ errorCode, errorDescription })) {
        publishState(session);
        return;
      }
      logger?.warn?.("Browser Node guest navigation failed", {
        currentUrl: contents.getURL(),
        desiredUrl: session.desiredUrl,
        errorCode,
        errorDescription,
        isMainFrame,
        nodeId: session.nodeId,
        validatedUrl,
        webContentsId: session.webContentsId
      });
      session.navigationFailureSequence += 1;
      publishState(session);
      emitBrowserNavigationFailed({
        emit,
        errorCode,
        errorDescription,
        nodeId: session.nodeId
      });
    };
    const onDestroyed = () => detachGuest(session);
    const onFoundInPage = (...args: unknown[]) => {
      const result = readFoundInPageResult(args[1]);
      if (!result) {
        return;
      }
      emit({
        ...result,
        nodeId: session.nodeId,
        query: session.findQuery,
        type: "find-result"
      });
    };
    const onWillNavigate = (...args: unknown[]) => {
      const event =
        args[0] && typeof args[0] === "object" && "preventDefault" in args[0]
          ? (args[0] as { preventDefault?: () => void })
          : null;
      const url = typeof args[1] === "string" ? args[1] : "";
      if (
        url.length === 0 ||
        isBrowserNavigationAllowedByPolicy({
          policy: session.navigationPolicy,
          url
        })
      ) {
        return;
      }

      event?.preventDefault?.();
      emitOpenUrlFromGuest(session, url);
      publishState(session);
    };

    const records: BrowserGuestSession["listeners"] = [
      { event: "did-start-loading", listener: onStateChange },
      { event: "did-start-navigation", listener: onDidStartNavigation },
      { event: "did-stop-loading", listener: onStateChange },
      { event: "did-navigate", listener: onDidNavigate },
      { event: "did-navigate-in-page", listener: onStateChange },
      { event: "page-title-updated", listener: onStateChange },
      { event: "will-navigate", listener: onWillNavigate },
      { event: "did-fail-load", listener: onFailLoad },
      { event: "destroyed", listener: onDestroyed },
      { event: "found-in-page", listener: onFoundInPage }
    ];

    for (const record of records) {
      contents.on(record.event, record.listener);
    }
    session.listeners = records;
  };

  const loadDesiredUrl = async (
    session: BrowserGuestSession
  ): Promise<void> => {
    const contents = session.contents;
    if (!contents || contents.isDestroyed()) {
      publishState(session);
      return;
    }

    const resolved = resolveHostBrowserNavigationUrl(session.desiredUrl);
    if (!resolved.url) {
      emit({
        ...resolveBrowserNodeUrlError(resolved),
        nodeId: session.nodeId,
        type: "error"
      });
      publishState(session);
      return;
    }
    if (
      !isBrowserNavigationAllowedByPolicy({
        policy: session.navigationPolicy,
        url: resolved.url
      })
    ) {
      emitOpenUrlFromGuest(session, resolved.url);
      publishState(session);
      return;
    }

    const currentComparable = normalizeHostBrowserComparableUrl(
      contents.getURL()
    );
    const nextComparable = normalizeHostBrowserComparableUrl(resolved.url);
    if (currentComparable && currentComparable === nextComparable) {
      publishState(session);
      return;
    }

    const failureSequenceBeforeLoad = session.navigationFailureSequence;
    try {
      await contents.loadURL(resolved.url);
      publishState(session);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger?.warn?.("Browser Node guest loadURL failed", {
        currentUrl: contents.getURL(),
        desiredUrl: session.desiredUrl,
        error: message,
        nodeId: session.nodeId,
        resolvedUrl: resolved.url,
        webContentsId: session.webContentsId
      });
      if (session.navigationFailureSequence !== failureSequenceBeforeLoad) {
        return;
      }
      publishState(session);
      emitBrowserNavigationFailed({
        emit,
        errorDescription: message,
        nodeId: session.nodeId
      });
    }
  };

  const emitOpenUrlFromGuest = (
    session: BrowserGuestSession,
    url: string
  ): { action: "deny" } => {
    const resolved = resolveBrowserNavigationUrl(url);
    if (resolved.url) {
      logger?.info?.("Browser Node guest emitted open-url", {
        nodeId: session.nodeId,
        url: resolved.url,
        webContentsId: session.webContentsId
      });
      emit({
        reuseIfOpen: true,
        sourceNodeId: session.nodeId,
        type: "open-url",
        url: resolved.url
      });
      return { action: "deny" };
    }
    void Promise.resolve(openExternal(url)).catch((error: unknown) => {
      logger?.warn?.("Browser Node openExternal failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    });
    return { action: "deny" };
  };

  return {
    async activate(input) {
      const resolved = resolveHostBrowserNavigationUrl(input.url);
      if (!resolved.url) {
        throw new Error("Browser Node rejected navigation URL");
      }
      const session = getSession(input.nodeId, {
        navigationPolicy: input.navigationPolicy,
        profileId: input.profileId,
        sessionMode: input.sessionMode,
        sessionPartition: input.sessionPartition,
        url: resolved.url
      });
      session.lifecycle = "active";
      await loadDesiredUrl(session);
    },
    async capturePreview(input) {
      const session = sessions.get(input.nodeId);
      const contents =
        session?.contents && !session.contents.isDestroyed()
          ? session.contents
          : null;
      if (!contents?.capturePage) {
        return null;
      }

      const image = await contents.capturePage();
      if (image.isEmpty?.() === true) {
        return null;
      }

      return resizeBrowserPreviewImage(image).toDataURL();
    },
    async chooseDownloadDirectory(input) {
      const browserSession = sessions.get(input.nodeId);
      const electronSession = browserSession?.contents?.session;
      if (!chooseDownloadDirectory || !electronSession?.setDownloadPath) {
        return { canceled: true, directoryPath: null };
      }
      const directoryPath = await chooseDownloadDirectory();
      if (!directoryPath) {
        return { canceled: true, directoryPath: null };
      }
      electronSession.setDownloadPath(directoryPath);
      return { canceled: false, directoryPath };
    },
    async clearBrowsingData(input) {
      await clearBrowserGuestData(sessions.get(input.nodeId)?.contents);
    },
    close(input) {
      const session = sessions.get(input.nodeId);
      if (session) {
        detachGuest(session);
        sessions.delete(input.nodeId);
      }
      emit({ nodeId: input.nodeId, type: "closed" });
      return Promise.resolve();
    },
    debugDump(input) {
      const session = sessions.get(input.nodeId);
      if (!session) {
        return null;
      }
      const contents =
        session.contents && !session.contents.isDestroyed()
          ? session.contents
          : null;
      return {
        canGoBack: contents ? canGuestGoBack(contents) : false,
        canGoForward: contents ? canGuestGoForward(contents) : false,
        currentUrl: contents ? contents.getURL() : null,
        desiredUrl: session.desiredUrl,
        isAttachedToWindow: Boolean(contents),
        isLoading: contents ? contents.isLoading() : false,
        lifecycle: session.lifecycle,
        nodeId: session.nodeId,
        profileId: session.profileId,
        sessionMode: session.sessionMode,
        sessionPartition: session.sessionPartition,
        title: contents ? contents.getTitle() : null,
        userAgent: contents?.getUserAgent?.() ?? null,
        webContentsDestroyed: session.contents
          ? session.contents.isDestroyed()
          : null,
        webContentsId: session.webContentsId
      };
    },
    goBack(input) {
      const contents = sessions.get(input.nodeId)?.contents;
      if (contents && !contents.isDestroyed() && canGuestGoBack(contents)) {
        goGuestBack(contents);
      }
      return Promise.resolve();
    },
    goForward(input) {
      const contents = sessions.get(input.nodeId)?.contents;
      if (contents && !contents.isDestroyed() && canGuestGoForward(contents)) {
        goGuestForward(contents);
      }
      return Promise.resolve();
    },
    findInPage(input) {
      const browserSession = sessions.get(input.nodeId);
      const contents = browserSession?.contents;
      const text = input.text.trim();
      if (!browserSession || !contents || contents.isDestroyed()) {
        return Promise.resolve();
      }
      browserSession.findQuery = text;
      if (!contents.findInPage || text.length === 0) {
        contents.stopFindInPage?.("clearSelection");
        emit({
          activeMatchOrdinal: 0,
          finalUpdate: true,
          matches: 0,
          nodeId: input.nodeId,
          query: text,
          type: "find-result"
        });
        return Promise.resolve();
      }
      contents.findInPage(text, {
        findNext: input.findNext,
        forward: input.forward
      });
      return Promise.resolve();
    },
    async importCookies(input) {
      const contents = sessions.get(input.nodeId)?.contents;
      if (!contents || contents.isDestroyed() || !contents.session?.cookies) {
        return completedCookieImportResult({
          failed: 0,
          imported: 0,
          skipped: 0
        });
      }
      const source = selectCookieImport ? await selectCookieImport() : null;
      return importBrowserGuestCookies(contents, source);
    },
    async importChromeCookies(input, signal) {
      const browserSession = sessions.get(input.nodeId);
      const sessionMode = browserSession?.sessionMode ?? "shared";
      const sessionPartition = browserSession?.sessionPartition ?? null;
      const profileId = browserSession?.profileId ?? null;
      const contents = browserSession?.contents ?? null;
      let cookieStore: BrowserGuestCookieStore | null =
        contents && !contents.isDestroyed()
          ? (contents.session?.cookies ?? null)
          : null;
      if (
        !cookieStore &&
        sessionMode !== "incognito" &&
        sessionPartition === null &&
        resolveOrdinaryCookieStore
      ) {
        await prepareSession?.({
          nodeId: input.nodeId,
          profileId,
          sessionMode,
          sessionPartition,
          url: undefined
        });
        cookieStore =
          (await resolveOrdinaryCookieStore({
            profileId,
            sessionMode,
            sessionPartition
          })) ?? null;
      }
      return importChromeCookiesIntoBrowserGuest({
        contents,
        cookieStore,
        importInput: input,
        prepareChromeCookieImport,
        signal,
        sessionMode,
        sessionPartition
      });
    },
    getCookieImportSession(input) {
      const browserSession = sessions.get(input.nodeId);
      return getBrowserGuestCookieImportSession(browserSession?.contents);
    },
    async resolveCookieImportSession(input) {
      const fromGuest = getBrowserGuestCookieImportSession(
        sessions.get(input.nodeId)?.contents
      );
      if (fromGuest) {
        return fromGuest;
      }
      const browserSession = sessions.get(input.nodeId);
      const sessionMode = browserSession?.sessionMode ?? "shared";
      const sessionPartition = browserSession?.sessionPartition ?? null;
      if (
        sessionMode === "incognito" ||
        sessionPartition !== null ||
        !resolveOrdinaryCookieSession
      ) {
        return null;
      }
      return (
        (await resolveOrdinaryCookieSession({
          profileId: browserSession?.profileId ?? null,
          sessionMode,
          sessionPartition
        })) ?? null
      );
    },
    reloadCookieImportSession(target) {
      reloadBrowserGuestsForCookieSession(sessions.values(), target);
    },
    handleGuestOpenUrl(webContentsId, input) {
      const nodeId = nodeIdByWebContentsId.get(webContentsId);
      const session = nodeId ? sessions.get(nodeId) : null;
      if (!session) {
        logger?.warn?.("Browser Node ignored guest open-url request", {
          url: input.url,
          webContentsId
        });
        return;
      }
      logger?.info?.("Browser Node handling guest open-url request", {
        nodeId: session.nodeId,
        url: input.url,
        webContentsId
      });
      emitOpenUrlFromGuest(session, input.url);
    },
    async navigate(input) {
      const resolved = resolveBrowserNavigationUrl(input.url);
      if (!resolved.url) {
        throw new Error("Browser Node rejected navigation URL");
      }
      const session = getSession(input.nodeId, {
        navigationPolicy: input.navigationPolicy,
        url: resolved.url
      });
      session.lifecycle = "active";
      await loadDesiredUrl(session);
    },
    async openExternal(input) {
      const resolved = resolveHostBrowserNavigationUrl(input.url);
      if (!resolved.url) {
        throw new Error("Browser Node rejected external URL");
      }
      await Promise.resolve(openExternal(resolved.url));
    },
    async performDownloadAction(input) {
      await downloadController.perform(input);
    },
    openDevTools(input) {
      const session = sessions.get(input.nodeId);
      const contents = session?.contents ?? null;
      if (contents && !contents.isDestroyed()) {
        try {
          contents.openDevTools?.({ activate: true, mode: "detach" });
        } catch (error) {
          logger?.warn?.("Browser Node open devtools failed", {
            error: error instanceof Error ? error.message : String(error),
            nodeId: input.nodeId,
            webContentsId: session?.webContentsId ?? null
          });
          throw error;
        }
      }
      return Promise.resolve();
    },
    async prepareSession(input) {
      await prepareSession?.(input);
      getSession(input.nodeId, {
        navigationPolicy: input.navigationPolicy,
        profileId: input.profileId,
        sessionMode: input.sessionMode,
        sessionPartition: input.sessionPartition,
        url: resolveOptionalBrowserNodeDesiredUrl(input.url)
      });
    },
    printPage(input) {
      return printBrowserGuestPage(sessions.get(input.nodeId)?.contents);
    },
    async registerGuest(input) {
      await prepareSession?.({
        nodeId: input.nodeId,
        profileId: input.profileId,
        sessionMode: input.sessionMode,
        sessionPartition: input.sessionPartition,
        navigationPolicy: input.navigationPolicy
      });
      const contents = resolveWebContents(input.webContentsId);
      if (!contents || contents.isDestroyed()) {
        throw new Error(
          `Browser Node guest ${input.webContentsId} is not available`
        );
      }

      const ownerNodeId = nodeIdByWebContentsId.get(input.webContentsId);
      if (ownerNodeId && ownerNodeId !== input.nodeId) {
        throw new Error(
          `Browser Node guest ${input.webContentsId} is already registered`
        );
      }

      const session = getSession(input.nodeId, {
        automationTarget: input.automationTarget,
        navigationPolicy: input.navigationPolicy,
        profileId: input.profileId,
        sessionMode: input.sessionMode,
        sessionPartition: input.sessionPartition,
        url: resolveOptionalBrowserNodeDesiredUrl(input.url)
      });
      if (
        session.webContentsId === input.webContentsId &&
        session.contents === contents
      ) {
        if (session.automationTarget) {
          automationRegistry?.register(
            session.nodeId,
            contents,
            session.automationTarget
          );
        } else {
          automationRegistry?.unregister(session.nodeId, contents);
        }
        publishState(session);
        return;
      }
      if (session.contents && session.contents !== contents) {
        detachGuest(session);
      }
      session.contents = contents;
      session.webContentsId = input.webContentsId;
      nodeIdByWebContentsId.set(input.webContentsId, input.nodeId);
      if (contents.session) {
        downloadController.attach(contents.session);
      }
      session.lifecycle = "active";
      if (session.automationTarget) {
        automationRegistry?.register(
          session.nodeId,
          contents,
          session.automationTarget
        );
      }
      contents.setWindowOpenHandler?.(({ url }) => {
        if (isGoogleGisOAuthPopupUrl(url)) {
          logger?.info?.("Browser Node allowing Google GIS OAuth popup", {
            nodeId: session.nodeId,
            webContentsId: session.webContentsId
          });
          return { action: "allow" };
        }

        return emitOpenUrlFromGuest(session, url);
      });
      attachGuestListeners(session);
      await applyPreferredColorSchemeToGuest(
        session,
        logger,
        syncPreferredColorScheme,
        preferredColorScheme
      );
      await loadDesiredUrl(session);
    },
    reload(input) {
      const contents = sessions.get(input.nodeId)?.contents;
      if (contents && !contents.isDestroyed()) {
        contents.reload();
      }
      return Promise.resolve();
    },
    async saveScreenshot(input) {
      return saveBrowserGuestScreenshot(
        sessions.get(input.nodeId)?.contents,
        input,
        saveScreenshot
      );
    },
    setDeviceEmulation(input) {
      setBrowserGuestDeviceEmulation(
        sessions.get(input.nodeId)?.contents,
        input.preset
      );
      return Promise.resolve();
    },
    setZoomFactor(input) {
      const browserSession = sessions.get(input.nodeId);
      if (!setBrowserGuestZoomFactor(browserSession?.contents, input)) {
        return Promise.resolve();
      }
      publishState(browserSession!);
      return Promise.resolve();
    },
    stopFindInPage(input) {
      const browserSession = sessions.get(input.nodeId);
      const contents = browserSession?.contents;
      if (browserSession) {
        browserSession.findQuery = "";
      }
      contents?.stopFindInPage?.(input.action ?? "clearSelection");
      emit({
        activeMatchOrdinal: 0,
        finalUpdate: true,
        matches: 0,
        nodeId: input.nodeId,
        query: "",
        type: "find-result"
      });
      return Promise.resolve();
    },
    unregisterGuest(input) {
      const session = sessions.get(input.nodeId);
      if (!session || session.webContentsId !== input.webContentsId) {
        return Promise.resolve();
      }
      session.lifecycle = "cold";
      detachGuest(session);
      return Promise.resolve();
    },
    updateAutomationTarget(nodeId, metadata) {
      const session = sessions.get(nodeId);
      if (!session) {
        return;
      }
      session.automationTarget = metadata;
      if (metadata && session.contents && !session.contents.isDestroyed()) {
        automationRegistry?.register(nodeId, session.contents, metadata);
      } else {
        automationRegistry?.unregister(nodeId, session.contents);
      }
    },
    dispose() {
      for (const session of sessions.values()) {
        detachGuest(session);
      }
      sessions.clear();
      unsubscribePreferredColorScheme?.();
      downloadController.dispose();
    }
  };
}
