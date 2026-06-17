import {
  useEffect,
  useRef,
  type HTMLAttributes,
  type JSX,
  type ReactNode
} from "react";
import { Button, PanelIcon, cn } from "@tutti-os/ui-system";
import { WorkspaceFileReferencePicker } from "@tutti-os/workspace-file-reference/ui";
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

      <WorkspaceFileReferencePicker
        copy={controller.copy}
        fileAdapter={feature.fileAdapter}
        open={referencePicker.open}
        workspaceId={workspaceId}
        onClose={referencePicker.onClose}
        onConfirm={referencePicker.onConfirm}
      />
    </section>
  );
}

export interface IssueManagerNodeHeaderProps extends HTMLAttributes<HTMLElement> {
  activeTopicId?: string | null;
  copy: IssueManagerI18nRuntime;
  defaultActions?: ReactNode;
  isSidebarAutoCollapsed: boolean;
  isSidebarCollapsed: boolean;
  nodeId: string;
  onToggleSidebar: (nextCollapsed: boolean) => void;
  title?: string;
  workspaceId: string;
}

export function IssueManagerNodeHeader({
  activeTopicId = null,
  className,
  copy,
  defaultActions,
  isSidebarAutoCollapsed,
  isSidebarCollapsed,
  nodeId,
  onToggleSidebar,
  title,
  workspaceId,
  ...headerProps
}: IssueManagerNodeHeaderProps): JSX.Element {
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

  return (
    <header
      {...headerProps}
      className={cn(
        "relative flex h-full min-h-0 items-center justify-between gap-3 bg-[var(--background-panel)] px-2 pl-3",
        className
      )}
    >
      <div className="z-10 flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate text-[13px] font-semibold leading-5 text-[var(--text-primary)]">
          {title?.trim() || copy.t("title")}
        </span>
        <Button
          aria-label={toggleLabel}
          className="cursor-pointer rounded-md"
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
          <PanelIcon className="size-[18px]" />
        </Button>
      </div>
      <div className="pointer-events-none absolute top-1/2 left-1/2 z-20 flex max-w-[220px] -translate-x-1/2 -translate-y-1/2 items-center justify-center">
        <div
          className="pointer-events-auto flex min-w-0 flex-none"
          onDoubleClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <IssueManagerTopicSelector
            activeTopicId={topicState.activeTopicId}
            className="flex-none"
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
      <div
        className="z-10 flex flex-none items-center gap-1"
        onDoubleClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
      >
        {defaultActions}
      </div>
    </header>
  );
}
