import {
  Button,
  LaunchIcon,
  WarningLinedIcon,
  ViewportMenuSurface,
  cn,
  menuItemClassName
} from "@tutti-os/ui-system";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore
} from "react";
import type { JSX, ReactNode } from "react";
import type { BrowserNodeFeature } from "../core/feature.ts";
import type {
  BrowserNodeAutomationTargetMetadata,
  BrowserNodeNavigationPolicy,
  BrowserNodeRuntimeError,
  BrowserNodeSessionMode
} from "../core/types.ts";
import type { BrowserNodeWebviewTag } from "./webviewTag.ts";
import {
  BrowserNodeChrome,
  BrowserNodeHeader,
  useBrowserNodeTabsState
} from "./BrowserNodeChrome.tsx";
import { BrowserNodeWebviewContext } from "./browserNodeWebviewContext.ts";
import { BrowserNodeChromeImportPrompt } from "./BrowserNodeChromeImportPrompt.tsx";
import { isChromeCookieImportEligible } from "./chromeCookieImportUiModel.ts";
import {
  openBrowserNodeExternal,
  resolveBrowserNodeOpenExternalUrl
} from "./browserNodeOperations.ts";
import { useBrowserNodeController } from "./useBrowserNodeController.ts";
import { useBrowserNodeWebview } from "./useBrowserNodeWebview.ts";
import { shouldHideBrowserNodeWebview } from "./webviewVisibility.ts";
import {
  isBrowserNodeHostOverlayOpen,
  subscribeBrowserNodeHostOverlay
} from "./browserNodeHostOverlayStore.ts";
import { isBrowserNodeHomeUrl } from "./browserNodeHome.ts";

// Electron needs the serialized string attribute for dynamically created webviews.
const browserNodeAllowPopupsAttribute = "true" as unknown as boolean;

// Hiding the guest webview while the host window is minimizing avoids
// compositing its (potentially heavy) content during the macOS genie
// animation, which is what causes the animation to stutter.
function useHostWindowMinimizing(): boolean {
  const [isMinimizing, setIsMinimizing] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const handleMinimizeState = (event: Event): void => {
      const detail = (event as CustomEvent<{ minimized: boolean }>).detail;
      setIsMinimizing(detail?.minimized === true);
    };

    window.addEventListener("tutti-host-window-minimize", handleMinimizeState);
    return () => {
      window.removeEventListener(
        "tutti-host-window-minimize",
        handleMinimizeState
      );
    };
  }, []);

  return isMinimizing;
}

export interface BrowserNodeProps {
  automationTarget?: Omit<
    BrowserNodeAutomationTargetMetadata,
    "selected" | "surfaceId" | "tabId"
  > | null;
  defaultUrl: string;
  feature: BrowserNodeFeature;
  hidden?: boolean;
  renderHome?: (context: BrowserNodeHomeRenderContext) => ReactNode;
  navigationPolicy?: BrowserNodeNavigationPolicy | null;
  navigationActions?: ReactNode;
  nodeId: string;
  onFocusRequest?: () => void;
  onNavigated?: (url: string) => void;
  profileId?: string | null;
  sessionMode?: BrowserNodeSessionMode;
  sessionPartition?: string | null;
  showHeader?: boolean;
  syncDefaultUrl?: boolean;
  tabs?: boolean;
}

export interface BrowserNodeHomeRenderContext {
  navigate(url: string): Promise<void>;
  nodeId: string;
}

export function BrowserNode({
  automationTarget = null,
  defaultUrl,
  feature,
  hidden = false,
  renderHome,
  navigationPolicy = null,
  navigationActions,
  nodeId,
  onFocusRequest,
  onNavigated,
  profileId = null,
  sessionMode = "shared",
  sessionPartition = null,
  showHeader = true,
  syncDefaultUrl = false,
  tabs = false
}: BrowserNodeProps): JSX.Element {
  if (tabs) {
    return (
      <TabbedBrowserNode
        automationTarget={automationTarget}
        defaultUrl={defaultUrl}
        feature={feature}
        hidden={hidden}
        renderHome={renderHome}
        navigationPolicy={navigationPolicy}
        navigationActions={navigationActions}
        nodeId={nodeId}
        onFocusRequest={onFocusRequest}
        onNavigated={onNavigated}
        profileId={profileId}
        sessionMode={sessionMode}
        sessionPartition={sessionPartition}
        showHeader={showHeader}
        syncDefaultUrl={syncDefaultUrl}
      />
    );
  }

  return (
    <BrowserNodeContent
      automationTarget={
        automationTarget
          ? {
              ...automationTarget,
              selected: true,
              surfaceId: nodeId,
              tabId: null
            }
          : null
      }
      defaultUrl={defaultUrl}
      feature={feature}
      hidden={hidden}
      renderHome={renderHome}
      navigationPolicy={navigationPolicy}
      navigationActions={navigationActions}
      nodeId={nodeId}
      onFocusRequest={onFocusRequest}
      onNavigated={onNavigated}
      profileId={profileId}
      sessionMode={sessionMode}
      sessionPartition={sessionPartition}
      showHeader={showHeader}
      syncDefaultUrl={syncDefaultUrl}
    />
  );
}

function TabbedBrowserNode({
  automationTarget,
  defaultUrl,
  feature,
  hidden,
  renderHome,
  navigationPolicy,
  navigationActions,
  nodeId,
  onFocusRequest,
  onNavigated,
  profileId,
  sessionMode = "shared",
  sessionPartition = null,
  showHeader,
  syncDefaultUrl
}: Omit<BrowserNodeProps, "tabs">): JSX.Element {
  const tabsState = useBrowserNodeTabsState(feature, nodeId, defaultUrl);
  const activeTabIdRef = useRef(tabsState.activeTabId);
  const webviewsRef = useRef(new Map<string, BrowserNodeWebviewTag>());
  const [activeWebview, setActiveWebview] =
    useState<BrowserNodeWebviewTag | null>(null);
  activeTabIdRef.current = tabsState.activeTabId;

  const handleTabWebviewChange = useCallback(
    (tabId: string, webview: BrowserNodeWebviewTag | null): void => {
      if (webview) {
        webviewsRef.current.set(tabId, webview);
      } else {
        webviewsRef.current.delete(tabId);
      }
      if (activeTabIdRef.current === tabId) {
        setActiveWebview(webview);
      }
    },
    []
  );

  useEffect(() => {
    setActiveWebview(webviewsRef.current.get(tabsState.activeTabId) ?? null);
  }, [tabsState.activeTabId]);

  return (
    <BrowserNodeWebviewContext.Provider value={activeWebview}>
      <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--background-panel)]">
        {showHeader ? (
          <BrowserNodeChrome
            allowChromeCookieImport={isChromeCookieImportEligible({
              sessionMode,
              sessionPartition
            })}
            defaultUrl={defaultUrl}
            feature={feature}
            navigationActions={navigationActions}
            onFocusRequest={onFocusRequest}
            surfaceNodeId={nodeId}
          />
        ) : null}
        <div className="relative min-h-0 flex-1 overflow-hidden">
          {tabsState.tabs.map((tab) => {
            const active = tab.id === tabsState.activeTabId;
            return (
              <div
                className={cn(
                  "absolute inset-0",
                  active ? "visible" : "invisible pointer-events-none"
                )}
                data-browser-node-tab-content-active={active ? "true" : "false"}
                key={tab.id}
              >
                <BrowserNodeContent
                  automationTarget={
                    automationTarget
                      ? {
                          ...automationTarget,
                          selected: active,
                          surfaceId: nodeId,
                          tabId: tab.id
                        }
                      : null
                  }
                  defaultUrl={tab.defaultUrl}
                  feature={feature}
                  hidden={hidden || !active}
                  renderHome={renderHome}
                  navigationPolicy={navigationPolicy}
                  nodeId={tab.nodeId}
                  onFocusRequest={onFocusRequest}
                  onNavigated={active ? onNavigated : undefined}
                  onWebviewChange={(webview) =>
                    handleTabWebviewChange(tab.id, webview)
                  }
                  profileId={profileId}
                  sessionMode={sessionMode}
                  sessionPartition={sessionPartition}
                  showHeader={false}
                  syncDefaultUrl={syncDefaultUrl}
                />
              </div>
            );
          })}
        </div>
      </div>
    </BrowserNodeWebviewContext.Provider>
  );
}

function BrowserNodeContent({
  automationTarget = null,
  defaultUrl,
  feature,
  hidden = false,
  renderHome,
  navigationPolicy = null,
  navigationActions,
  nodeId,
  onFocusRequest,
  onNavigated,
  onWebviewChange,
  profileId = null,
  sessionMode = "shared",
  sessionPartition = null,
  showHeader = false,
  syncDefaultUrl = false
}: Omit<BrowserNodeProps, "automationTarget" | "tabs"> & {
  automationTarget?: BrowserNodeAutomationTargetMetadata | null;
  onWebviewChange?: (webview: BrowserNodeWebviewTag | null) => void;
}): JSX.Element {
  const { state } = useBrowserNodeController({
    defaultUrl,
    feature,
    navigationPolicy,
    nodeId,
    profileId,
    sessionMode,
    sessionPartition,
    syncDefaultUrl
  });
  const runtime = state.runtime;
  const isHostMinimizing = useHostWindowMinimizing();
  const isHostOverlayOpen = useBrowserNodeHostOverlayOpen(nodeId);
  const lastNavigatedUrlRef = useRef<string | null>(
    state.runtime.url?.trim() || null
  );
  const errorMessage = runtime.error
    ? formatBrowserNodeErrorMessage(feature, runtime.error)
    : null;
  const errorStatus = runtime.error
    ? formatBrowserNodeErrorStatus(feature, runtime.error)
    : null;
  const isShowingLoadError = errorMessage !== null;
  // Keep home mounted across about:blank loading flickers. Hiding home while the
  // bootstrap webview reports isLoading makes the empty state flash on every
  // guest reload/attach (including Cookie-import session refreshes).
  const isShowingHome =
    renderHome !== undefined &&
    !isShowingLoadError &&
    isBrowserNodeHomeUrl(runtime.url ?? state.displayUrl);
  const openExternalUrl = resolveBrowserNodeOpenExternalUrl(feature, state);
  const {
    devToolsContextMenu,
    dismissDevToolsContextMenu,
    openDevToolsFromContextMenu,
    shouldRenderWebview,
    setWebviewRef,
    webviewKey,
    webviewPartition,
    webviewSrc
  } = useBrowserNodeWebview({
    automationTarget,
    feature,
    initialUrl: state.displayUrl,
    lifecycle: runtime.lifecycle,
    navigationPolicy,
    nodeId,
    onGuestInteraction: onFocusRequest,
    profileId,
    sessionMode,
    sessionPartition
  });
  const [webview, setWebview] = useState<BrowserNodeWebviewTag | null>(null);
  const onWebviewChangeRef = useRef(onWebviewChange);
  onWebviewChangeRef.current = onWebviewChange;
  const handleWebviewRef = useCallback(
    (element: BrowserNodeWebviewTag | null): void => {
      setWebviewRef(element);
      setWebview(element);
      onWebviewChangeRef.current?.(element);
    },
    [setWebviewRef]
  );

  useEffect(() => {
    const navigatedUrl = state.runtime.url?.trim() ?? "";
    if (
      !onNavigated ||
      state.runtime.isLoading ||
      state.runtime.error ||
      navigatedUrl.length === 0 ||
      navigatedUrl === "about:blank" ||
      lastNavigatedUrlRef.current === navigatedUrl
    ) {
      return;
    }

    lastNavigatedUrlRef.current = navigatedUrl;
    onNavigated(navigatedUrl);
  }, [
    onNavigated,
    state.runtime.error,
    state.runtime.isLoading,
    state.runtime.url
  ]);

  return (
    <BrowserNodeWebviewContext.Provider value={webview}>
      <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--background-panel)]">
        {showHeader ? (
          <BrowserNodeHeader
            allowChromeCookieImport={isChromeCookieImportEligible({
              sessionMode,
              sessionPartition
            })}
            defaultUrl={defaultUrl}
            feature={feature}
            navigationActions={navigationActions}
            nodeId={nodeId}
            onFocusRequest={onFocusRequest}
          />
        ) : null}
        {isChromeCookieImportEligible({ sessionMode, sessionPartition }) ? (
          <BrowserNodeChromeImportPrompt feature={feature} nodeId={nodeId} />
        ) : null}
        <div className="relative min-h-0 flex-1 overflow-hidden bg-[var(--background-panel)]">
          {shouldRenderWebview ? (
            <webview
              allowpopups={browserNodeAllowPopupsAttribute}
              key={webviewKey}
              ref={handleWebviewRef}
              className={cn(
                "absolute inset-0 h-full w-full border-0 bg-[var(--background-panel)]",
                isShowingLoadError ? "hidden pointer-events-none" : "visible",
                isShowingHome && "invisible pointer-events-none",
                shouldHideBrowserNodeWebview({
                  hidden,
                  isHostMinimizing,
                  isHostOverlayOpen:
                    isHostOverlayOpen || devToolsContextMenu !== null
                }) && "invisible"
              )}
              data-browser-node-webview="true"
              partition={webviewPartition}
              src={webviewSrc}
            />
          ) : null}
          {isShowingHome ? (
            <div className="absolute inset-0 z-10 overflow-auto bg-[var(--background-panel)]">
              {renderHome({
                navigate: async (url) => {
                  const resolved = feature.resolveAddressInput(url);
                  if (!resolved.url) {
                    return;
                  }
                  await feature.hostApi.navigate({
                    navigationPolicy,
                    nodeId,
                    url: resolved.url
                  });
                },
                nodeId
              })}
            </div>
          ) : null}
          {errorMessage ? (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-[var(--background-panel)] px-8 py-10 text-center">
              <div
                className="flex w-full max-w-[440px] flex-col items-center"
                role="status"
                aria-live="polite"
              >
                <div className="flex size-11 items-center justify-center rounded-full border border-[color-mix(in_srgb,var(--state-danger)_22%,transparent)] bg-[color-mix(in_srgb,var(--state-danger)_8%,transparent)] text-[var(--state-danger)]">
                  <WarningLinedIcon className="size-5" />
                </div>
                <div className="mt-4 text-lg font-semibold text-[var(--text-primary)]">
                  {feature.i18n.t("loadFailed")}
                </div>
                <div className="mt-1 max-w-[360px] text-[13px] leading-5 text-[var(--text-secondary)]">
                  {errorMessage}
                </div>
                {errorStatus ? (
                  <div className="mt-4 rounded-full border border-border bg-[var(--transparency-block)] px-2.5 py-1 text-[11px] font-medium text-[var(--text-secondary)]">
                    {errorStatus}
                  </div>
                ) : null}
                {openExternalUrl ? (
                  <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
                    <Button
                      size="sm"
                      type="button"
                      variant="outline"
                      onClick={() => {
                        void openBrowserNodeExternal(feature, openExternalUrl);
                      }}
                    >
                      <LaunchIcon className="size-3.5" />
                      {feature.i18n.t("actions.openExternal")}
                    </Button>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
          {devToolsContextMenu ? (
            <ViewportMenuSurface
              open
              className="w-44"
              dismissOnEscape
              dismissOnPointerDownOutside
              onDismiss={dismissDevToolsContextMenu}
              placement={{
                type: "point",
                point: devToolsContextMenu,
                alignX: "start",
                alignY: "start",
                estimatedSize: {
                  width: 176,
                  height: 40
                }
              }}
            >
              <button
                className={cn(menuItemClassName, "w-full")}
                type="button"
                onClick={() => {
                  void openDevToolsFromContextMenu().catch(() => undefined);
                }}
              >
                {feature.i18n.t("actions.openDevTools")}
              </button>
            </ViewportMenuSurface>
          ) : null}
        </div>
      </div>
    </BrowserNodeWebviewContext.Provider>
  );
}

function useBrowserNodeHostOverlayOpen(nodeId: string): boolean {
  const subscribe = useCallback(
    (listener: () => void) => subscribeBrowserNodeHostOverlay(nodeId, listener),
    [nodeId]
  );
  const getSnapshot = useCallback(
    () => isBrowserNodeHostOverlayOpen(nodeId),
    [nodeId]
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

function formatBrowserNodeErrorMessage(
  feature: BrowserNodeFeature,
  error: BrowserNodeRuntimeError
): string {
  switch (error.code) {
    case "invalid-url":
      return feature.i18n.t("errors.invalidUrl", error.params);
    case "navigation-failed":
      if (error.params && error.params.statusCode !== undefined) {
        return feature.i18n.t(
          "errors.navigationFailedWithStatus",
          error.params
        );
      }
      return feature.i18n.t("errors.navigationFailed", error.params);
    case "unsupported-protocol":
      return feature.i18n.t("errors.unsupportedProtocol", error.params);
    case "unsupported-url":
      return feature.i18n.t("errors.unsupportedUrl", error.params);
  }
}

function formatBrowserNodeErrorStatus(
  feature: BrowserNodeFeature,
  error: BrowserNodeRuntimeError
): string | null {
  if (error.code !== "navigation-failed" || !error.params) {
    return null;
  }

  const statusCode = error.params.statusCode;
  if (typeof statusCode === "number") {
    return feature.i18n.t("errors.statusCode", { statusCode });
  }

  const errorCode = error.params.errorCode;
  if (typeof errorCode === "number") {
    return feature.i18n.t("errors.errorCode", { errorCode });
  }

  return null;
}
