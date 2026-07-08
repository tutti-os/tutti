import {
  ArrowLeftIcon,
  ArrowRightIcon,
  Badge,
  Button,
  Input,
  LaunchIcon,
  LoadingIcon,
  RefreshIcon,
  WarningLinedIcon,
  ViewportMenuSurface,
  cn,
  menuItemClassName
} from "@tutti-os/ui-system";
import type { WorkbenchDisplayMode } from "@tutti-os/workbench-surface";
import { useEffect, useRef, useState } from "react";
import type { HTMLAttributes, JSX, ReactNode } from "react";
import type { BrowserNodeFeature } from "../core/feature.ts";
import type { BrowserNodeControllerState } from "../core/nodeController.ts";
import type {
  BrowserNodeNavigationPolicy,
  BrowserNodeRuntimeError,
  BrowserNodeSessionMode
} from "../core/types.ts";
import { useBrowserNodeController } from "./useBrowserNodeController.ts";
import { useBrowserNodeWebview } from "./useBrowserNodeWebview.ts";
import { shouldHideBrowserNodeWebview } from "./webviewVisibility.ts";

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
  defaultUrl: string;
  feature: BrowserNodeFeature;
  hidden?: boolean;
  navigationPolicy?: BrowserNodeNavigationPolicy | null;
  nodeId: string;
  onFocusRequest?: () => void;
  onNavigated?: (url: string) => void;
  profileId?: string | null;
  sessionMode?: BrowserNodeSessionMode;
  sessionPartition?: string | null;
  showHeader?: boolean;
  syncDefaultUrl?: boolean;
}

export function BrowserNode({
  defaultUrl,
  feature,
  hidden = false,
  navigationPolicy = null,
  nodeId,
  onFocusRequest,
  onNavigated,
  profileId = null,
  sessionMode = "shared",
  sessionPartition = null,
  showHeader = true,
  syncDefaultUrl = false
}: BrowserNodeProps): JSX.Element {
  const { controller, state } = useBrowserNodeController({
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
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--background-panel)]">
      {showHeader ? (
        <BrowserNodeHeader
          canGoBack={runtime.canGoBack}
          canGoForward={runtime.canGoForward}
          draftUrl={state.draftUrl}
          feature={feature}
          isCold={runtime.lifecycle === "cold"}
          isLoading={runtime.isLoading}
          onDraftUrlChange={(nextUrl) => controller.setDraftUrl(nextUrl)}
          onFocusRequest={onFocusRequest}
          onSubmitUrl={() => {
            void controller.submitDraftUrl().catch(() => undefined);
          }}
          onOpenExternal={
            openExternalUrl
              ? () => {
                  void openBrowserNodeExternal(feature, openExternalUrl);
                }
              : undefined
          }
          onGoBack={() => {
            void controller.goBack().catch(() => undefined);
          }}
          onGoForward={() => {
            void controller.goForward().catch(() => undefined);
          }}
          onReload={() => {
            void controller.reload().catch(() => undefined);
          }}
        />
      ) : null}
      <div className="relative min-h-0 flex-1 overflow-hidden bg-[var(--background-panel)]">
        {shouldRenderWebview ? (
          <webview
            allowpopups={browserNodeAllowPopupsAttribute}
            key={webviewKey}
            ref={setWebviewRef}
            className={cn(
              "absolute inset-0 h-full w-full border-0 bg-[var(--background-panel)]",
              isShowingLoadError ? "hidden pointer-events-none" : "visible",
              shouldHideBrowserNodeWebview({ hidden, isHostMinimizing }) &&
                "invisible"
            )}
            data-browser-node-webview="true"
            partition={webviewPartition}
            src={webviewSrc}
          />
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
  );
}

export interface BrowserNodeWorkbenchHeaderProps {
  className?: string;
  defaultActions?: ReactNode;
  defaultUrl: string;
  displayMode?: WorkbenchDisplayMode;
  dragHandleProps?: HTMLAttributes<HTMLElement>;
  feature: BrowserNodeFeature;
  nodeId: string;
  onCloseRequest?: () => void;
  onFocusRequest?: () => void;
}

export function BrowserNodeWorkbenchHeader({
  className,
  defaultActions,
  defaultUrl,
  displayMode,
  dragHandleProps,
  feature,
  nodeId,
  onCloseRequest,
  onFocusRequest
}: BrowserNodeWorkbenchHeaderProps): JSX.Element {
  const { controller, state } = useBrowserNodeController({
    defaultUrl,
    feature,
    nodeId
  });
  const runtime = state.runtime;
  const openExternalUrl = resolveBrowserNodeOpenExternalUrl(feature, state);

  return (
    <BrowserNodeHeader
      canGoBack={runtime.canGoBack}
      canGoForward={runtime.canGoForward}
      className={className}
      defaultActions={defaultActions}
      displayMode={displayMode}
      draftUrl={state.draftUrl}
      dragHandleProps={dragHandleProps}
      feature={feature}
      isCold={runtime.lifecycle === "cold"}
      isLoading={runtime.isLoading}
      onCloseRequest={onCloseRequest}
      onDraftUrlChange={(nextUrl) => controller.setDraftUrl(nextUrl)}
      onFocusRequest={onFocusRequest}
      onSubmitUrl={() => {
        void controller.submitDraftUrl().catch(() => undefined);
      }}
      onOpenExternal={
        openExternalUrl
          ? () => {
              void openBrowserNodeExternal(feature, openExternalUrl);
            }
          : undefined
      }
      onGoBack={() => {
        void controller.goBack().catch(() => undefined);
      }}
      onGoForward={() => {
        void controller.goForward().catch(() => undefined);
      }}
      onReload={() => {
        void controller.reload().catch(() => undefined);
      }}
      withBorder={false}
    />
  );
}

export function BrowserNodeHeader({
  canGoBack,
  canGoForward,
  className,
  defaultActions,
  displayMode,
  draftUrl,
  dragHandleProps,
  feature,
  isCold = false,
  isLoading,
  onCloseRequest,
  onDraftUrlChange,
  onFocusRequest,
  onGoBack,
  onGoForward,
  onOpenExternal,
  onReload,
  onSubmitUrl,
  withBorder = true
}: {
  canGoBack: boolean;
  canGoForward: boolean;
  className?: string;
  defaultActions?: ReactNode;
  displayMode?: WorkbenchDisplayMode;
  draftUrl: string;
  dragHandleProps?: HTMLAttributes<HTMLElement>;
  feature: BrowserNodeFeature;
  isCold?: boolean;
  isLoading: boolean;
  onCloseRequest?: () => void;
  onDraftUrlChange: (nextUrl: string) => void;
  onFocusRequest?: () => void;
  onGoBack: () => void;
  onGoForward: () => void;
  onOpenExternal?: () => void;
  onReload: () => void;
  onSubmitUrl: () => void;
  withBorder?: boolean;
}): JSX.Element {
  const [reloadAnimationKey, setReloadAnimationKey] = useState(0);

  const handleReload = (): void => {
    setReloadAnimationKey((currentKey) => currentKey + 1);
    onReload();
  };

  return (
    <div
      className={cn(
        "flex h-[var(--workbench-header-height,38px)] min-h-[var(--workbench-header-height,38px)] items-center gap-2 bg-[var(--background-panel)] px-2 pl-3",
        withBorder ? "border-b border-border" : null,
        className
      )}
      data-browser-node-header="true"
      data-browser-node-header-display-mode={displayMode}
      onDoubleClick={(event) => {
        if (
          event.target instanceof Element &&
          event.target.closest(".nodrag")
        ) {
          return;
        }
        event.stopPropagation();
        dragHandleProps?.onDoubleClick?.(event);
      }}
    >
      {defaultActions ? (
        <span
          className="nodrag flex shrink-0 items-center"
          onClickCapture={(event) => {
            if (
              !onCloseRequest ||
              !(event.target instanceof Element) ||
              !event.target.closest('[data-workbench-action="close"]')
            ) {
              return;
            }
            onCloseRequest();
          }}
        >
          {defaultActions}
        </span>
      ) : null}
      <div className="inline-flex items-center gap-1">
        <BrowserNodeHeaderButton
          disabled={!canGoBack}
          label={feature.i18n.t("actions.back")}
          onClick={onGoBack}
        >
          <ArrowLeftIcon className="size-[15px]" />
        </BrowserNodeHeaderButton>
        <BrowserNodeHeaderButton
          disabled={!canGoForward}
          label={feature.i18n.t("actions.forward")}
          onClick={onGoForward}
        >
          <ArrowRightIcon className="size-[15px]" />
        </BrowserNodeHeaderButton>
        <BrowserNodeHeaderButton
          label={feature.i18n.t("actions.reload")}
          onClick={handleReload}
        >
          <RefreshIcon
            key={reloadAnimationKey}
            className={cn(
              "size-[15px]",
              reloadAnimationKey > 0 &&
                "motion-safe:animate-[spin_520ms_cubic-bezier(0.4,0,0.2,1)_1_reverse]"
            )}
          />
        </BrowserNodeHeaderButton>
      </div>
      <div
        {...dragHandleProps}
        className="h-full w-1.5 shrink-0 cursor-grab active:cursor-grabbing"
        data-browser-node-drag-gutter="true"
        data-node-drag-handle="true"
        aria-hidden="true"
      />
      <form
        className="nodrag relative min-w-0 flex-1"
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onSubmitUrl();
        }}
      >
        <Input
          aria-label={feature.i18n.t("addressLabel")}
          className="pr-8 focus-visible:border-input focus-visible:ring-0 focus-visible:ring-offset-0"
          placeholder={feature.i18n.t("addressPlaceholder")}
          size="sm"
          value={draftUrl}
          onChange={(event) => onDraftUrlChange(event.target.value)}
          onFocus={onFocusRequest}
        />
        {isLoading ? (
          <LoadingIcon className="pointer-events-none absolute right-2 top-1/2 z-[1] size-4 -translate-y-1/2 animate-spin text-[var(--text-tertiary)]" />
        ) : null}
      </form>
      {onOpenExternal ? (
        <BrowserNodeHeaderButton
          label={feature.i18n.t("actions.openExternal")}
          onClick={onOpenExternal}
        >
          <LaunchIcon className="size-[15px]" />
        </BrowserNodeHeaderButton>
      ) : null}
      {isCold ? (
        <Badge
          className="nodrag h-[26px] min-w-7 shrink-0 rounded-md text-[10px] font-semibold lowercase tracking-[0.08em]"
          aria-label={feature.i18n.t("coldStatus")}
        >
          {feature.i18n.t("coldStatus")}
        </Badge>
      ) : null}
    </div>
  );
}

function resolveBrowserNodeOpenExternalUrl(
  feature: BrowserNodeFeature,
  state: BrowserNodeControllerState
): string | null {
  if (!feature.hostApi.openExternal) {
    return null;
  }

  const sourceUrl = state.runtime.url?.trim() || state.displayUrl.trim();
  if (sourceUrl.length === 0 || sourceUrl === "about:blank") {
    return null;
  }

  return feature.resolveOpenExternalUrl(sourceUrl).url;
}

async function openBrowserNodeExternal(
  feature: BrowserNodeFeature,
  url: string
): Promise<void> {
  try {
    await feature.hostApi.openExternal?.({ url });
  } catch (error) {
    feature.reportDiagnostic?.({
      details: {
        error: error instanceof Error ? error.message : String(error),
        url
      },
      event: "open-external-failed",
      level: "warn"
    });
  }
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

function BrowserNodeHeaderButton({
  children,
  disabled,
  label,
  onClick
}: {
  children: ReactNode;
  disabled?: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <Button
      aria-label={label}
      className="rounded-md"
      disabled={disabled}
      size="icon-sm"
      title={label}
      type="button"
      variant="chrome"
      onClick={onClick}
    >
      {children}
    </Button>
  );
}
