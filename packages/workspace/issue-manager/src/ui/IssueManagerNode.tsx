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
import { Button, PanelIcon, cn } from "@tutti-os/ui-system";
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
  "size-3 shrink-0 rounded-full border-0 p-0 opacity-95 outline-none transition-[filter,opacity] duration-150 hover:brightness-110 focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--background-panel)]";

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
      ? "min(100%, 520px)"
      : "min(var(--issue-manager-sidebar-width, 280px), 100%)"
  } satisfies CSSProperties;

  return (
    <header
      {...restHeaderProps}
      className={cn(
        "relative flex h-full min-h-0 w-full items-center bg-transparent",
        className
      )}
    >
      <div
        {...dragHandleProps}
        aria-hidden="true"
        className="absolute inset-0 cursor-grab active:cursor-grabbing"
      />
      <div
        {...dragHandleProps}
        className="relative z-10 flex h-full min-w-0 cursor-grab items-center gap-2 border-r border-[var(--border-1)] bg-[var(--background-panel)] pr-3 pl-7 active:cursor-grabbing"
        style={sidebarHeaderStyle}
      >
        <div
          className="mr-3 flex shrink-0 items-center gap-2"
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
        <div
          className="ml-auto flex min-w-0 shrink items-center"
          onDoubleClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <IssueManagerTopicSelector
            activeTopicId={topicState.activeTopicId}
            className="max-w-[150px] flex-none text-[var(--text-primary)]"
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
        <Button
          aria-label={toggleLabel}
          className={issueManagerHeaderChromeIconButtonClassName}
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
  return (
    <button
      aria-label={label}
      aria-pressed={pressed}
      className={cn(
        issueManagerHeaderTrafficLightClassName,
        tone === "close" && "bg-[#ff5f57]",
        tone === "minimize" && "bg-[#ffbd2e]",
        tone === "maximize" && "bg-[#28c840]"
      )}
      title={label}
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      onDoubleClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    />
  );
}
