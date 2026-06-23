import { useRef, type JSX, type MouseEvent, type PointerEvent } from "react";
import { ScrollArea, cn } from "@tutti-os/ui-system";
import type {
  IssueManagerIssueSummary,
  IssueManagerTaskSummary
} from "../../../contracts/index.ts";
import { logIssueManagerDiagnostic } from "../../../internal/issueManagerDiagnostics.ts";
import {
  IssueManagerTaskDrawerBody,
  IssueManagerTaskDrawerFooter,
  IssueManagerTaskDrawerHeader
} from "./IssueManagerTaskDrawerSections.tsx";
import type { IssueManagerLatestRunStatusRenderer } from "../../latestRunStatusRenderer.ts";
import { resolveIssueManagerTaskDrawerViewState } from "./IssueManagerTaskDrawerState.ts";
import type { IssueManagerController } from "../../react/index.ts";

export type IssueManagerTaskDrawerCloseSource = "backdrop" | "header_back";

export function IssueManagerTaskDrawer({
  controller,
  isClosing,
  renderLatestRunStatus,
  selectedIssue,
  selectedTask,
  onClose,
  shouldIgnoreBackdropClick
}: {
  controller: IssueManagerController;
  isClosing: boolean;
  renderLatestRunStatus?: IssueManagerLatestRunStatusRenderer;
  selectedIssue: IssueManagerIssueSummary | null;
  selectedTask: IssueManagerTaskSummary | null;
  onClose: (source: IssueManagerTaskDrawerCloseSource) => void;
  shouldIgnoreBackdropClick?: (event: {
    clientX: number;
    clientY: number;
  }) => boolean;
}): JSX.Element {
  const view = resolveIssueManagerTaskDrawerViewState({
    controller,
    selectedTask
  });
  const taskContent = selectedTask?.content ?? "";
  const hasRequestedBackdropCloseRef = useRef(false);
  const requestBackdropClose = (
    event: MouseEvent<HTMLDivElement> | PointerEvent<HTMLDivElement>,
    phase: "click" | "pointer_down"
  ) => {
    const target = event.target;
    logIssueManagerDiagnostic(
      controller.diagnostics,
      "task_drawer.backdrop_close_event",
      {
        clientX: event.clientX,
        clientY: event.clientY,
        currentTargetTag: event.currentTarget.tagName,
        hasRequestedBackdropClose: hasRequestedBackdropCloseRef.current,
        isClosing,
        isDirectBackdropClick: event.target === event.currentTarget,
        phase,
        selectedIssueId: selectedIssue?.issueId ?? null,
        selectedTaskId: selectedTask?.taskId ?? null,
        selectedTaskTitle: selectedTask?.title ?? null,
        targetClassName:
          target instanceof HTMLElement ? target.className : null,
        targetTag: target instanceof HTMLElement ? target.tagName : null
      }
    );

    if (event.target !== event.currentTarget) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (hasRequestedBackdropCloseRef.current) {
      return;
    }

    if (shouldIgnoreBackdropClick?.(event)) {
      return;
    }

    hasRequestedBackdropCloseRef.current = true;
    onClose("backdrop");
  };
  const handleBackdropPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) {
      return;
    }
    requestBackdropClose(event, "pointer_down");
  };
  const handleBackdropClick = (event: MouseEvent<HTMLDivElement>) => {
    if (hasRequestedBackdropCloseRef.current) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    requestBackdropClose(event, "click");
  };

  return (
    <div
      className={cn(
        "absolute inset-0 z-20 flex justify-end overscroll-contain bg-[var(--backdrop)] backdrop-blur-[1px] motion-reduce:animate-none",
        isClosing
          ? "motion-safe:animate-out motion-safe:fade-out-0 motion-safe:duration-[180ms] motion-safe:ease-[cubic-bezier(0.4,0,0.2,1)]"
          : "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-[180ms] motion-safe:ease-[cubic-bezier(0.4,0,0.2,1)]"
      )}
      onClick={handleBackdropClick}
      onPointerDown={handleBackdropPointerDown}
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
            onClose={() => onClose("header_back")}
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
                : "gap-8 px-6 pt-1 pb-7"
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
