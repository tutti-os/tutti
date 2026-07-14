import { type JSX } from "react";
import { cn } from "@tutti-os/ui-system";
import {
  IssueManagerSidebarBody,
  IssueManagerSidebarHeader,
  IssueManagerSidebarStandalonePane,
  IssueManagerSidebarStatusTabs
} from "./IssueManagerSidebarSections.tsx";
import { IssueManagerTopicSelector } from "./IssueManagerTopicSelector.tsx";
import { resolveIssueManagerSidebarPresentationState } from "./IssueManagerSidebarState.ts";
import type { IssueManagerController } from "../../react/index.ts";
import { resolveIssueManagerSubtaskProgressByIssueId } from "./IssueManagerShellState.ts";
import type {
  issueManagerStatusFilters,
  IssueManagerSidebarViewState
} from "./IssueManagerShellState.ts";
import {
  resolveIssueManagerIssueRunTaskId,
  resolveIssueManagerVisibleSubtasks
} from "../issue/IssueManagerIssueAcceptanceState.ts";

export interface IssueManagerSidebarProps {
  controller: IssueManagerController;
  isCollapsed: boolean;
  isNarrowLayout: boolean;
  showStandaloneState: boolean;
  showTopicSelector?: boolean;
  sidebarViewState: IssueManagerSidebarViewState;
  statusCounts: Record<(typeof issueManagerStatusFilters)[number], number>;
}

export function IssueManagerSidebar({
  controller,
  isCollapsed,
  isNarrowLayout,
  showStandaloneState,
  showTopicSelector = false,
  sidebarViewState,
  statusCounts
}: IssueManagerSidebarProps): JSX.Element {
  const copy = controller.copy;
  const presentation = resolveIssueManagerSidebarPresentationState({
    showStandaloneState,
    sidebarViewState
  });
  const currentIssueDetail =
    controller.issueDetail.value?.issue.issueId ===
    controller.nodeState.selectedIssueId
      ? controller.issueDetail.value
      : null;
  const issueRunTaskId = currentIssueDetail
    ? resolveIssueManagerIssueRunTaskId({
        latestRun:
          currentIssueDetail.latestRun ??
          currentIssueDetail.recentRuns[0] ??
          null,
        selectedIssue: currentIssueDetail.issue,
        tasks: currentIssueDetail.tasks
      })
    : null;
  const visibleTasks = currentIssueDetail
    ? resolveIssueManagerVisibleSubtasks({
        hiddenIssueRunTaskId: issueRunTaskId,
        tasks: currentIssueDetail.tasks
      })
    : [];
  const subtaskProgressByIssueId = resolveIssueManagerSubtaskProgressByIssueId({
    issueId: currentIssueDetail?.issue.issueId ?? null,
    visibleTasks: currentIssueDetail ? visibleTasks : null
  });

  return (
    <aside
      aria-hidden={isCollapsed ? "true" : undefined}
      className={cn(
        "relative isolate flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-transparent opacity-100 transition-[border-color] duration-[140ms] ease-in-out after:pointer-events-none after:absolute after:inset-0 after:z-[1] after:bg-[color-mix(in_srgb,var(--background-panel)_88%,transparent)] after:opacity-0 after:transition-opacity after:duration-[160ms] after:delay-[70ms] motion-reduce:transition-none motion-reduce:after:transition-none [&>*]:transition-[opacity,filter] [&>*]:duration-[160ms] [&>*]:delay-[70ms] [&>*]:ease-in-out motion-reduce:[&>*]:transition-none",
        isNarrowLayout
          ? "border-b border-[var(--border-1)]"
          : "border-r border-[var(--border-1)]",
        isCollapsed &&
          "pointer-events-none border-r-transparent after:opacity-100 after:delay-0 [&>*]:opacity-0 [&>*]:blur-[1px] [&>*]:delay-0 motion-reduce:[&>*]:blur-none"
      )}
      inert={isCollapsed ? true : undefined}
    >
      {showTopicSelector ? (
        <div className="flex min-w-0 items-center px-2.5 pt-2 pb-1">
          <IssueManagerTopicSelector
            activeTopicId={controller.nodeState.activeTopicId ?? null}
            className="max-w-full"
            copy={copy}
            topics={controller.topics.value}
            onCreateTopic={(input) => {
              void controller.createTopic(input);
            }}
            onDeleteTopic={(topicId) => {
              void controller.deleteTopic(topicId);
            }}
            onSelectTopic={controller.selectTopic}
            onUpdateTopic={(input) => {
              void controller.updateTopic(input);
            }}
          />
        </div>
      ) : null}

      <IssueManagerSidebarHeader
        copy={copy}
        issueSearchQuery={controller.nodeState.issueSearchQuery}
        onCreateIssue={() => controller.setIssueEditorMode("create")}
        onIssueSearchUsage={controller.reportIssueSearchUsage}
        onIssueSearchQueryChange={controller.setIssueSearchQuery}
      />

      <IssueManagerSidebarStatusTabs
        copy={copy}
        issueStatusFilter={controller.nodeState.issueStatusFilter}
        statusCounts={statusCounts}
        onIssueStatusFilterChange={controller.setIssueStatusFilter}
      />

      <div aria-hidden="true" className="h-2.5 flex-none" />

      <div
        className={cn(
          "relative flex min-h-0 flex-col",
          isNarrowLayout ? "flex-none" : "flex-1"
        )}
      >
        {presentation.kind !== "none" ? (
          <div className="flex h-full min-h-0 items-center justify-center px-4 pt-1.5 pb-4">
            <IssueManagerSidebarStandalonePane
              body={
                presentation.kind === "empty" ? presentation.body : undefined
              }
              isNarrowLayout={false}
              kind={presentation.kind}
              retryLabel={
                presentation.kind === "error"
                  ? presentation.retryLabel
                  : undefined
              }
              title={
                presentation.kind === "error" ? presentation.title : undefined
              }
              onRetry={() => controller.refreshAll()}
            />
          </div>
        ) : (
          <IssueManagerSidebarBody
            copy={copy}
            isNarrowLayout={isNarrowLayout}
            selectedIssueId={controller.nodeState.selectedIssueId}
            sidebarViewState={sidebarViewState}
            subtaskProgressByIssueId={subtaskProgressByIssueId}
            onRetry={() => controller.refreshAll()}
            onSelectIssue={controller.selectIssue}
          />
        )}
      </div>
    </aside>
  );
}
