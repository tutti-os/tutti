import {
  type CSSProperties,
  useEffect,
  useRef,
  type HTMLAttributes,
  type JSX,
  type ReactNode
} from "react";
import type {
  WorkbenchDisplayMode,
  WorkbenchHostNodeHeaderWindowActions
} from "@tutti-os/workbench-surface";
import {
  Button,
  FileCreateIcon,
  PanelIcon,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  WindowTrafficLightIcon,
  cn
} from "@tutti-os/ui-system";
import {
  ReferenceSourcePicker,
  WorkspaceFileReferencePicker
} from "@tutti-os/workspace-file-reference/ui";
import type { IssueManagerI18nRuntime } from "../i18n/issueManagerI18n.ts";
import type { IssueManagerOpenSource } from "../contracts/index.ts";
import { logIssueManagerDiagnostic } from "../internal/issueManagerDiagnostics.ts";
import type { IssueManagerLatestRunStatusRenderer } from "./latestRunStatusRenderer.ts";
import { IssueManagerShell } from "./internal/shell/IssueManagerShell.tsx";
import { IssueManagerTopicSelector } from "./internal/shell/IssueManagerTopicSelector.tsx";
import {
  dispatchIssueManagerTopicCreate,
  dispatchIssueManagerTopicDelete,
  dispatchIssueManagerTopicHeaderState,
  dispatchIssueManagerTopicSelection,
  dispatchIssueManagerTopicUpdate,
  dispatchIssueManagerIssueCreateRequest,
  useIssueManagerIssueCreateRequestSync,
  useIssueManagerTopicHeaderCommandSync,
  useIssueManagerTopicHeaderStateSync,
  useIssueManagerNodeHeaderView,
  useIssueManagerNodeView,
  type UseIssueManagerNodeViewInput
} from "./react/index.ts";

export { dispatchIssueManagerTaskListCollapsed } from "./react/index.ts";
export type { IssueManagerLatestRunStatusRenderer } from "./latestRunStatusRenderer.ts";

export interface IssueManagerNodeOpenRequest {
  issueId: string;
  mode?: "breakdown" | "execute";
  outputDir?: string;
  requestId: string;
  runId?: string;
  taskId?: string;
  topicId?: string;
}

export type IssueManagerNodeProps = UseIssueManagerNodeViewInput & {
  openRequest?: IssueManagerNodeOpenRequest | null;
  openSource?: IssueManagerOpenSource;
  renderLatestRunStatus?: IssueManagerLatestRunStatusRenderer;
};

export function IssueManagerNode({
  diagnostics,
  emptyIllustration,
  feature,
  nodeId,
  openSource,
  openRequest,
  onStateChange,
  renderLatestRunStatus,
  resolveRichTextTriggerProviders,
  service,
  state,
  workspaceId
}: IssueManagerNodeProps): JSX.Element {
  const { controller, referencePicker, selectedIssue, selectedTask, shell } =
    useIssueManagerNodeView({
      diagnostics,
      feature,
      nodeId,
      openSource,
      onStateChange,
      resolveRichTextTriggerProviders,
      service,
      state,
      workspaceId
    });
  const lastHandledOpenRequestIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!openRequest?.requestId) {
      return;
    }
    if (lastHandledOpenRequestIdRef.current === openRequest.requestId) {
      logIssueManagerDiagnostic(
        controller.diagnostics,
        "open_request.skipped_duplicate",
        {
          issueId: openRequest.issueId,
          requestId: openRequest.requestId,
          taskId: openRequest.taskId?.trim() || null,
          topicId: openRequest.topicId?.trim() || null
        }
      );
      return;
    }
    lastHandledOpenRequestIdRef.current = openRequest.requestId;

    logIssueManagerDiagnostic(
      controller.diagnostics,
      "open_request.consumed",
      {
        issueId: openRequest.issueId,
        mode: openRequest.mode ?? null,
        requestId: openRequest.requestId,
        taskId: openRequest.taskId?.trim() || null,
        topicId: openRequest.topicId?.trim() || null
      },
      { includeStack: true }
    );

    if (openRequest.topicId?.trim()) {
      controller.selectTopic(openRequest.topicId);
    }
    controller.selectIssue(openRequest.issueId);
    controller.selectTask(openRequest.taskId?.trim() || null);
  }, [controller, openRequest]);

  useEffect(() => {
    dispatchIssueManagerTopicHeaderState({
      activeTopicId: controller.nodeState.activeTopicId ?? null,
      nodeId,
      topics: controller.topics.value,
      workspaceId
    });
  }, [
    controller.nodeState.activeTopicId,
    controller.topics.value,
    nodeId,
    workspaceId
  ]);

  useIssueManagerTopicHeaderCommandSync({
    nodeId,
    onCreateTopic: (topicInput) => {
      void controller.createTopic(topicInput);
    },
    onDeleteTopic: (topicId) => {
      void controller.deleteTopic(topicId);
    },
    onSelectTopic: controller.selectTopic,
    onUpdateTopic: (topicInput) => {
      void controller.updateTopic(topicInput);
    },
    workspaceId
  });
  useIssueManagerIssueCreateRequestSync({
    nodeId,
    onCreateIssue: () => {
      controller.setIssueEditorMode("create");
    },
    workspaceId
  });

  return (
    <section
      aria-label={controller.copy.t("title")}
      className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden text-[var(--text-primary)]"
      data-issue-manager-node-id={nodeId}
      data-issue-manager-workspace-id={workspaceId}
    >
      <IssueManagerShell
        controller={controller}
        emptyIllustration={emptyIllustration}
        onCloseTaskDrawer={shell.onCloseTaskDrawer}
        onDismissIssueCreate={shell.onDismissIssueCreate}
        renderLatestRunStatus={renderLatestRunStatus}
        selectedIssue={selectedIssue}
        selectedTask={selectedTask}
      />

      {feature.referenceSourceAggregator ? (
        <ReferenceSourcePicker
          aggregator={feature.referenceSourceAggregator}
          copy={controller.copy}
          open={referencePicker.open}
          workspaceId={workspaceId}
          onClose={referencePicker.onClose}
          onConfirm={referencePicker.onConfirm}
          onConfirmBundles={referencePicker.onConfirmBundles}
        />
      ) : (
        <WorkspaceFileReferencePicker
          copy={controller.copy}
          fileAdapter={feature.fileAdapter}
          open={referencePicker.open}
          workspaceId={workspaceId}
          onClose={referencePicker.onClose}
          onConfirm={referencePicker.onConfirm}
        />
      )}
    </section>
  );
}

export interface IssueManagerNodeHeaderProps extends HTMLAttributes<HTMLElement> {
  activeTopicId?: string | null;
  copy: IssueManagerI18nRuntime;
  defaultActions?: ReactNode;
  displayMode?: WorkbenchDisplayMode;
  isSidebarAutoCollapsed: boolean;
  isSidebarCollapsed: boolean;
  nodeId: string;
  onToggleSidebar: (nextCollapsed: boolean) => void;
  title?: string;
  windowActions?: Pick<
    WorkbenchHostNodeHeaderWindowActions,
    "close" | "minimize" | "toggleDisplayMode"
  >;
  workspaceId: string;
}

const issueManagerWorkbenchDragHandleAttribute = "data-workbench-drag-handle";
const issueManagerHeaderChromeIconButtonClassName =
  "size-7 min-h-7 min-w-7 cursor-pointer rounded-md p-0 text-[var(--text-secondary)] hover:bg-[color-mix(in_srgb,var(--text-primary)_8%,transparent)] hover:text-[var(--text-primary)]";
const issueManagerHeaderChromeIconClassName = "size-[18px]";
const issueManagerHeaderTrafficLightClassName =
  "relative -m-1 size-5 shrink-0 cursor-pointer rounded-full border-0 bg-transparent p-0 text-[color-mix(in_srgb,var(--text-tertiary)_72%,transparent)] opacity-[0.78] outline-none transition-[color,opacity] duration-150 ease-out before:absolute before:inset-1 before:rounded-full before:bg-current before:transition-colors before:duration-150 before:ease-out before:content-[''] group-hover/traffic-lights:opacity-100 group-focus-within/traffic-lights:opacity-100 focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--background-panel)]";

type IssueManagerNodeHeaderDragHandleAttributes = {
  [issueManagerWorkbenchDragHandleAttribute]?: "true";
};

export function IssueManagerNodeHeader({
  activeTopicId = null,
  className,
  copy,
  defaultActions: _defaultActions,
  displayMode,
  isSidebarAutoCollapsed,
  isSidebarCollapsed,
  nodeId,
  onToggleSidebar,
  title,
  windowActions,
  workspaceId,
  ...headerProps
}: IssueManagerNodeHeaderProps): JSX.Element {
  const {
    [issueManagerWorkbenchDragHandleAttribute]: dragHandleData,
    onDoubleClick,
    onPointerDown,
    ...restHeaderProps
  } = headerProps as typeof headerProps &
    IssueManagerNodeHeaderDragHandleAttributes;
  const dragHandleProps = {
    "data-workbench-drag-handle": dragHandleData,
    onDoubleClick,
    onPointerDown
  };
  const { effectiveCollapsed, toggleLabel, toggleSidebar } =
    useIssueManagerNodeHeaderView({
      copy,
      isSidebarAutoCollapsed,
      isSidebarCollapsed,
      nodeId,
      onToggleSidebar,
      workspaceId
    });
  const topicState = useIssueManagerTopicHeaderStateSync({
    activeTopicId,
    nodeId,
    workspaceId
  });
  const safeDisplayMode = displayMode ?? "floating";
  const safeWindowActions = windowActions ?? {
    close: () => undefined,
    minimize: () => undefined,
    toggleDisplayMode: () => undefined
  };
  const displayModeLabel =
    safeDisplayMode === "fullscreen"
      ? copy.t("actions.restoreWindow")
      : copy.t("actions.maximizeWindow");
  const sidebarHeaderStyle = {
    width: effectiveCollapsed
      ? "max-content"
      : "min(var(--issue-manager-sidebar-width, 280px), 100%)"
  } satisfies CSSProperties;
  const topicHeaderStyle = {
    left: effectiveCollapsed
      ? "50%"
      : "calc(min(var(--issue-manager-sidebar-width, 280px), 100%) + ((100% - min(var(--issue-manager-sidebar-width, 280px), 100%)) / 2))"
  } satisfies CSSProperties;

  return (
    <header
      {...restHeaderProps}
      className={cn(
        "relative flex h-full min-h-0 w-full items-center bg-transparent",
        className
      )}
      data-workbench-custom-header-border="none"
    >
      <div
        {...dragHandleProps}
        aria-hidden="true"
        className="absolute inset-0 cursor-grab active:cursor-grabbing"
      />
      <div
        {...dragHandleProps}
        className={cn(
          "relative z-10 flex h-full min-w-0 cursor-grab items-center gap-2 bg-[var(--background-panel)] pr-3 pl-4 active:cursor-grabbing",
          !effectiveCollapsed && "border-r border-[var(--border-1)]"
        )}
        style={sidebarHeaderStyle}
      >
        <div
          className="group/traffic-lights flex shrink-0 items-center gap-2"
          onDoubleClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <IssueManagerTrafficLightButton
            label={copy.t("actions.closeWindow")}
            tone="close"
            onClick={safeWindowActions.close}
          />
          <IssueManagerTrafficLightButton
            label={copy.t("actions.minimizeWindow")}
            tone="minimize"
            onClick={safeWindowActions.minimize}
          />
          <IssueManagerTrafficLightButton
            label={displayModeLabel}
            pressed={safeDisplayMode === "fullscreen"}
            tone="maximize"
            onClick={safeWindowActions.toggleDisplayMode}
          />
        </div>
        <span className="min-w-0 shrink truncate text-[15px] font-semibold leading-5 text-[var(--text-primary)]">
          {title?.trim() || copy.t("title")}
        </span>
        <Button
          aria-label={toggleLabel}
          className={cn(
            !effectiveCollapsed && "ml-auto",
            issueManagerHeaderChromeIconButtonClassName
          )}
          data-issue-manager-sidebar-auto-collapsed={
            isSidebarAutoCollapsed ? "true" : undefined
          }
          data-issue-manager-sidebar-collapsed={
            effectiveCollapsed ? "true" : undefined
          }
          size="icon-sm"
          title={toggleLabel}
          type="button"
          variant="ghost"
          onClick={(event) => {
            event.stopPropagation();
            toggleSidebar();
          }}
          onDoubleClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <PanelIcon className={issueManagerHeaderChromeIconClassName} />
        </Button>
        {effectiveCollapsed ? (
          <TooltipProvider delayDuration={250} skipDelayDuration={0}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  aria-label={copy.t("actions.createIssue")}
                  className={issueManagerHeaderChromeIconButtonClassName}
                  size="icon-sm"
                  type="button"
                  variant="ghost"
                  onClick={(event) => {
                    event.stopPropagation();
                    dispatchIssueManagerIssueCreateRequest({
                      nodeId,
                      workspaceId
                    });
                  }}
                  onDoubleClick={(event) => event.stopPropagation()}
                  onPointerDown={(event) => event.stopPropagation()}
                >
                  <FileCreateIcon aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {copy.t("actions.createIssue")}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : null}
      </div>
      <div
        className="pointer-events-none absolute inset-y-0 z-10 flex min-w-0 -translate-x-1/2 items-center justify-center px-3"
        style={topicHeaderStyle}
      >
        <div
          className="pointer-events-auto flex min-w-0 max-w-full items-center"
          onDoubleClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <IssueManagerTopicSelector
            activeTopicId={topicState.activeTopicId}
            className="max-w-[220px] text-[var(--text-primary)]"
            copy={copy}
            topics={topicState.topics}
            onCreateTopic={(input) => {
              dispatchIssueManagerTopicCreate({
                input,
                nodeId,
                workspaceId
              });
            }}
            onDeleteTopic={(topicId) => {
              dispatchIssueManagerTopicDelete({
                nodeId,
                topicId,
                workspaceId
              });
            }}
            onSelectTopic={(topicId) => {
              dispatchIssueManagerTopicSelection({
                nodeId,
                topicId,
                workspaceId
              });
            }}
            onUpdateTopic={(input) => {
              dispatchIssueManagerTopicUpdate({
                input,
                nodeId,
                workspaceId
              });
            }}
          />
        </div>
      </div>
    </header>
  );
}

function IssueManagerTrafficLightButton({
  label,
  onClick,
  pressed,
  tone
}: {
  label: string;
  onClick: () => void;
  pressed?: boolean;
  tone: "close" | "minimize" | "maximize";
}): JSX.Element {
  const iconName =
    tone === "maximize" ? (pressed ? "unfullscreen" : "fullscreen") : tone;
  const button = (
    <button
      aria-label={label}
      aria-pressed={pressed}
      className={cn(
        issueManagerHeaderTrafficLightClassName,
        tone === "close" &&
          "group-hover/traffic-lights:text-[#ff5f57] group-focus-within/traffic-lights:text-[#ff5f57]",
        tone === "minimize" &&
          "group-hover/traffic-lights:text-[#ffbd2e] group-focus-within/traffic-lights:text-[#ffbd2e]",
        tone === "maximize" &&
          "group-hover/traffic-lights:text-[#28c840] group-focus-within/traffic-lights:text-[#28c840]"
      )}
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      onDoubleClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <WindowTrafficLightIcon
        aria-hidden="true"
        className="pointer-events-none absolute inset-[5px] z-[1] size-[10px] text-[color-mix(in_srgb,#000_68%,transparent)] opacity-0 transition-opacity duration-150 group-hover/traffic-lights:opacity-100 group-focus-within/traffic-lights:opacity-100"
        data-issue-manager-traffic-light-icon={iconName}
        iconName={iconName}
      />
    </button>
  );

  return (
    <TooltipProvider delayDuration={250} skipDelayDuration={0}>
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
