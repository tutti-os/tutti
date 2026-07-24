import {
  AddIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  Button,
  CloseIcon,
  Input,
  LaunchIcon,
  LoadingIcon,
  RefreshIcon,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  WebIcon,
  cn
} from "@tutti-os/ui-system";
import { useExternalStoreSnapshot } from "@tutti-os/ui-react-hooks";
import type { WorkbenchDisplayMode } from "@tutti-os/workbench-surface";
import { useEffect, useState } from "react";
import type { HTMLAttributes, JSX, ReactNode } from "react";
import type { BrowserNodeFeature } from "../core/feature.ts";
import {
  closeBrowserNodeTab,
  retainBrowserNodeTabSurface
} from "../core/tabsLifecycle.ts";
import type {
  BrowserNodeTab,
  BrowserNodeTabsState
} from "../core/tabsStore.ts";
import type { BrowserNodeRuntimeState } from "../core/types.ts";
import { BrowserNodeActionsMenu } from "./BrowserNodeActionsMenu.tsx";
import {
  openBrowserNodeDevTools,
  openBrowserNodeExternal,
  resolveBrowserNodeOpenExternalUrl
} from "./browserNodeOperations.ts";
import { useBrowserNodeController } from "./useBrowserNodeController.ts";

export interface BrowserNodeChromeProps {
  allowChromeCookieImport?: boolean;
  className?: string;
  defaultActions?: ReactNode;
  defaultUrl: string;
  displayMode?: WorkbenchDisplayMode;
  dragHandleProps?: HTMLAttributes<HTMLElement>;
  feature: BrowserNodeFeature;
  navigationActions?: ReactNode;
  onCloseRequest?: () => void;
  onFocusRequest?: () => void;
  surfaceNodeId: string;
  withBorder?: boolean;
}

export interface BrowserNodeWorkbenchHeaderProps {
  className?: string;
  defaultActions?: ReactNode;
  defaultUrl: string;
  displayMode?: WorkbenchDisplayMode;
  dragHandleProps?: HTMLAttributes<HTMLElement>;
  feature: BrowserNodeFeature;
  navigationActions?: ReactNode;
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
  navigationActions,
  nodeId,
  onCloseRequest,
  onFocusRequest
}: BrowserNodeWorkbenchHeaderProps): JSX.Element {
  return (
    <BrowserNodeChrome
      className={className}
      defaultActions={defaultActions}
      defaultUrl={defaultUrl}
      displayMode={displayMode}
      dragHandleProps={dragHandleProps}
      feature={feature}
      navigationActions={navigationActions}
      onCloseRequest={onCloseRequest}
      onFocusRequest={onFocusRequest}
      surfaceNodeId={nodeId}
      withBorder={false}
    />
  );
}

export function BrowserNodeChrome({
  allowChromeCookieImport = true,
  className,
  defaultActions,
  defaultUrl,
  displayMode,
  dragHandleProps,
  feature,
  navigationActions,
  onCloseRequest,
  onFocusRequest,
  surfaceNodeId,
  withBorder = true
}: BrowserNodeChromeProps): JSX.Element {
  const tabsState = useBrowserNodeTabsState(feature, surfaceNodeId, defaultUrl);
  const activeTab =
    tabsState.tabs.find((tab) => tab.id === tabsState.activeTabId) ??
    tabsState.tabs[0];

  if (!activeTab) {
    throw new Error(`Browser tab surface has no tabs: ${surfaceNodeId}`);
  }

  const {
    className: dragClassName,
    onDoubleClick: onDragDoubleClick,
    onPointerDown: onDragPointerDown,
    ...restDragHandleProps
  } = dragHandleProps ?? {};

  return (
    <div
      className={cn(
        "relative z-[1] flex h-[76px] min-h-[76px] flex-col overflow-visible bg-[var(--background-fronted)]",
        withBorder ? "border-b border-border" : null,
        className
      )}
      data-browser-node-header="true"
      data-browser-node-header-display-mode={displayMode}
    >
      <div
        {...restDragHandleProps}
        className={cn(
          "flex h-[38px] min-h-[38px] items-center gap-1.5 px-2 cursor-grab active:cursor-grabbing",
          "bg-[var(--background-1)]",
          dragClassName
        )}
        data-browser-node-tab-strip="true"
        data-node-drag-handle="true"
        onPointerDown={(event) => {
          if (
            event.target instanceof Element &&
            event.target.closest(".nodrag")
          ) {
            return;
          }
          onDragPointerDown?.(event);
        }}
        onDoubleClick={(event) => {
          if (
            event.target instanceof Element &&
            event.target.closest(".nodrag")
          ) {
            return;
          }
          event.stopPropagation();
          onDragDoubleClick?.(event);
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
        <div
          aria-label={feature.i18n.t("title")}
          className="nodrag flex min-w-0 max-w-[70%] items-center gap-1 overflow-x-auto"
          role="tablist"
        >
          {tabsState.tabs.map((tab) => (
            <BrowserNodeTabButton
              active={tab.id === tabsState.activeTabId}
              canClose={tabsState.tabs.length > 1}
              feature={feature}
              key={tab.id}
              tab={tab}
              onClose={() =>
                closeBrowserNodeTab(feature, surfaceNodeId, tab.id)
              }
              onSelect={() =>
                feature.tabsStore.selectTab(surfaceNodeId, tab.id)
              }
            />
          ))}
        </div>
        <Button
          aria-label={feature.i18n.t("tabs.new")}
          className="nodrag shrink-0 rounded-md"
          size="icon-sm"
          title={feature.i18n.t("tabs.new")}
          type="button"
          variant="chrome"
          onClick={() => feature.tabsStore.addTab(surfaceNodeId)}
        >
          <AddIcon className="size-4" />
        </Button>
        <div className="min-w-8 flex-1 self-stretch" aria-hidden="true" />
      </div>
      <BrowserNodeHeader
        allowChromeCookieImport={allowChromeCookieImport}
        defaultUrl={activeTab.defaultUrl}
        feature={feature}
        navigationActions={navigationActions}
        nodeId={activeTab.nodeId}
        onFocusRequest={onFocusRequest}
      />
    </div>
  );
}

export function BrowserNodeHeader({
  allowChromeCookieImport = true,
  defaultUrl,
  feature,
  navigationActions,
  nodeId,
  onFocusRequest
}: {
  allowChromeCookieImport?: boolean;
  defaultUrl: string;
  feature: BrowserNodeFeature;
  navigationActions?: ReactNode;
  nodeId: string;
  onFocusRequest?: () => void;
}): JSX.Element {
  const { controller, state } = useBrowserNodeController({
    defaultUrl,
    feature,
    nodeId
  });
  const [reloadAnimationKey, setReloadAnimationKey] = useState(0);
  const runtime = state.runtime;
  const openExternalUrl = resolveBrowserNodeOpenExternalUrl(feature, state);

  return (
    <div
      className="flex h-[38px] min-h-[38px] items-center gap-2 px-2 pl-3"
      data-browser-node-navigation-bar="true"
    >
      <div className="inline-flex items-center gap-1">
        <BrowserNodeHeaderButton
          disabled={!runtime.canGoBack}
          label={feature.i18n.t("actions.back")}
          onClick={() => void controller.goBack().catch(() => undefined)}
        >
          <ArrowLeftIcon className="size-[15px]" />
        </BrowserNodeHeaderButton>
        <BrowserNodeHeaderButton
          disabled={!runtime.canGoForward}
          label={feature.i18n.t("actions.forward")}
          onClick={() => void controller.goForward().catch(() => undefined)}
        >
          <ArrowRightIcon className="size-[15px]" />
        </BrowserNodeHeaderButton>
        <BrowserNodeHeaderButton
          label={feature.i18n.t("actions.reload")}
          onClick={() => {
            setReloadAnimationKey((currentKey) => currentKey + 1);
            void controller.reload().catch(() => undefined);
          }}
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
      <form
        className="nodrag relative min-w-0 flex-1"
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void controller.submitDraftUrl().catch(() => undefined);
        }}
      >
        <Input
          aria-label={feature.i18n.t("addressLabel")}
          className="pr-8 focus-visible:border-input focus-visible:ring-0 focus-visible:ring-offset-0"
          placeholder={feature.i18n.t("addressPlaceholder")}
          size="sm"
          value={state.draftUrl}
          onChange={(event) => controller.setDraftUrl(event.target.value)}
          onFocus={onFocusRequest}
        />
        {runtime.isLoading ? (
          <LoadingIcon className="pointer-events-none absolute right-2 top-1/2 z-[1] size-4 -translate-y-1/2 animate-spin text-[var(--text-tertiary)]" />
        ) : null}
      </form>
      {openExternalUrl ? (
        <BrowserNodeHeaderButton
          label={feature.i18n.t("actions.openExternal")}
          onClick={() => void openBrowserNodeExternal(feature, openExternalUrl)}
        >
          <LaunchIcon className="size-[15px]" />
        </BrowserNodeHeaderButton>
      ) : null}
      {navigationActions}
      <BrowserNodeActionsMenu
        allowChromeCookieImport={allowChromeCookieImport}
        feature={feature}
        nodeId={nodeId}
        onOpenDevTools={
          feature.hostApi.openDevTools
            ? () => void openBrowserNodeDevTools(feature, nodeId)
            : undefined
        }
        runtime={runtime}
      />
    </div>
  );
}

function BrowserNodeTabButton({
  active,
  canClose,
  feature,
  onClose,
  onSelect,
  tab
}: {
  active: boolean;
  canClose: boolean;
  feature: BrowserNodeFeature;
  onClose: () => void;
  onSelect: () => void;
  tab: BrowserNodeTab;
}): JSX.Element {
  const runtime = useExternalStoreSnapshot<BrowserNodeRuntimeState>({
    getSnapshot: () => feature.runtimeStore.getNodeState(tab.nodeId),
    subscribe: feature.runtimeStore.subscribe
  });
  const title = runtime.title?.trim() || feature.i18n.t("tabs.untitled");

  return (
    <div
      className={cn(
        "group flex h-7 min-w-[104px] max-w-[220px] items-center gap-1.5 rounded-md border px-2 text-xs transition-colors",
        active
          ? "border-[var(--line-2)] bg-[var(--background-fronted)] text-[var(--text-primary)]"
          : "border-transparent text-[var(--text-secondary)] hover:bg-[var(--transparency-hover)] hover:text-[var(--text-primary)]"
      )}
      data-browser-node-tab-active={active ? "true" : "false"}
    >
      <button
        aria-selected={active}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        role="tab"
        title={title}
        type="button"
        onClick={onSelect}
      >
        {runtime.isLoading ? (
          <LoadingIcon className="size-3.5 shrink-0 animate-spin text-[var(--text-tertiary)]" />
        ) : (
          <WebIcon className="size-3.5 shrink-0 text-[var(--text-tertiary)]" />
        )}
        <span className="truncate">{title}</span>
      </button>
      {canClose ? (
        <button
          aria-label={feature.i18n.t("tabs.close")}
          className="flex size-5 shrink-0 items-center justify-center rounded text-[var(--text-tertiary)] hover:bg-[var(--transparency-hover)] hover:text-[var(--text-primary)]"
          title={feature.i18n.t("tabs.close")}
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
        >
          <CloseIcon className="size-3" />
        </button>
      ) : null}
    </div>
  );
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
}): JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={label}
          className="rounded-md"
          disabled={disabled}
          size="icon-sm"
          type="button"
          variant="chrome"
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

export function useBrowserNodeTabsState(
  feature: BrowserNodeFeature,
  surfaceNodeId: string,
  defaultUrl: string
): BrowserNodeTabsState {
  feature.tabsStore.ensureSurface(surfaceNodeId, defaultUrl);
  useEffect(
    () => retainBrowserNodeTabSurface(feature, surfaceNodeId),
    [feature, surfaceNodeId]
  );
  useEffect(() => {
    feature.tabsStore.syncDefaultUrl(surfaceNodeId, defaultUrl);
  }, [defaultUrl, feature, surfaceNodeId]);

  return useExternalStoreSnapshot<BrowserNodeTabsState>({
    getSnapshot: () => {
      const state = feature.tabsStore.getSurfaceState(surfaceNodeId);
      if (!state) {
        return feature.tabsStore.ensureSurface(surfaceNodeId, defaultUrl);
      }
      return state;
    },
    subscribe: feature.tabsStore.subscribe
  });
}
