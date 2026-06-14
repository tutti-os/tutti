import type { JSX } from "react";
import { ScrollArea, cn } from "@tutti-os/ui-system";
import type {
  IssueManagerIssueSummary,
  IssueManagerTaskSummary
} from "../../../contracts/index.ts";
import {
  IssueManagerTaskDrawerBody,
  IssueManagerTaskDrawerFooter,
  IssueManagerTaskDrawerHeader
} from "./IssueManagerTaskDrawerSections.tsx";
import type { IssueManagerLatestRunStatusRenderer } from "../../latestRunStatusRenderer.ts";
import { resolveIssueManagerTaskDrawerViewState } from "./IssueManagerTaskDrawerState.ts";
import type { IssueManagerController } from "../../react/index.ts";

export function IssueManagerTaskDrawer({
  controller,
  isClosing,
  renderLatestRunStatus,
  selectedIssue,
  selectedTask,
  onClose
}: {
  controller: IssueManagerController;
  isClosing: boolean;
  renderLatestRunStatus?: IssueManagerLatestRunStatusRenderer;
  selectedIssue: IssueManagerIssueSummary | null;
  selectedTask: IssueManagerTaskSummary | null;
  onClose: () => void;
}): JSX.Element {
  const view = resolveIssueManagerTaskDrawerViewState({
    controller,
    selectedTask
  });
  const taskContent = selectedTask?.content ?? "";

  return (
    <div
      className={cn(
        "absolute inset-0 z-20 flex justify-end overscroll-contain bg-[var(--backdrop)] backdrop-blur-[1px] motion-reduce:animate-none",
        isClosing
          ? "motion-safe:animate-out motion-safe:fade-out-0 motion-safe:duration-[180ms] motion-safe:ease-[cubic-bezier(0.4,0,0.2,1)]"
          : "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-[180ms] motion-safe:ease-[cubic-bezier(0.4,0,0.2,1)]"
      )}
      onClick={onClose}
      onTouchMove={(event) => {
        event.preventDefault();
      }}
      onWheel={(event) => {
        event.preventDefault();
      }}
    >
      <aside
        className={cn(
          "flex h-full w-[min(360px,92cqw)] flex-col overscroll-contain border-l border-border-1 bg-background-panel text-[var(--text-primary)] shadow-[-20px_0_60px_var(--shadow-elevated)] @min-[960px]/issue-manager-content:w-[480px] motion-reduce:animate-none",
          isClosing
            ? "motion-safe:animate-out motion-safe:slide-out-to-right-full motion-safe:duration-[180ms] motion-safe:ease-[cubic-bezier(0.4,0,0.2,1)]"
            : "motion-safe:animate-in motion-safe:slide-in-from-right-full motion-safe:duration-[220ms] motion-safe:ease-[cubic-bezier(0.22,1,0.36,1)]"
        )}
        onClick={(event) => event.stopPropagation()}
        onTouchMove={(event) => event.stopPropagation()}
        onWheel={(event) => event.stopPropagation()}
      >
        {view.bodyKind === "edit" ? null : (
          <IssueManagerTaskDrawerHeader
            controller={controller}
            onClose={onClose}
            selectedTask={selectedTask}
            view={view}
          />
        )}

        <ScrollArea
          scrollbarMode="native"
          className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]]:overscroll-contain"
        >
          <div
            className={cn(
              "flex flex-col",
              view.bodyKind === "edit"
                ? "gap-[14px] px-6 py-8"
                : "gap-9 px-6 py-7"
            )}
          >
            <IssueManagerTaskDrawerBody
              controller={controller}
              renderLatestRunStatus={renderLatestRunStatus}
              taskContent={taskContent}
              view={view}
            />
          </div>
        </ScrollArea>

        <IssueManagerTaskDrawerFooter
          controller={controller}
          selectedIssue={selectedIssue}
          selectedTask={selectedTask}
          view={view}
        />
      </aside>
    </div>
  );
}
