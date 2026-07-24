import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
  type JSX,
  type MouseEvent
} from "react";
import { cn } from "@tutti-os/ui-system";
import type {
  IssueManagerStatus,
  IssueManagerTaskSummary
} from "../../../contracts/index.ts";
import {
  formatIssueManagerTimestamp,
  resolveIssueManagerStatusLabel
} from "../../../services/controllerModel.ts";
import type { IssueManagerI18nRuntime } from "../../../i18n/issueManagerI18n.ts";
import { IssueManagerTitleTooltip } from "../content/IssueManagerTitleTooltip.tsx";
import { summarizeIssueManagerContent } from "../panel/IssueManagerPanelText.ts";
import { IssueManagerTaskStructureChips } from "./IssueManagerTaskStructure.tsx";

type IssueManagerSubtaskBoardStatus =
  | "not_started"
  | "running"
  | "pending_acceptance"
  | "completed"
  | "failed"
  | "canceled";

type IssueManagerSubtaskDragState = {
  cardHeight: number;
  sourceStatus: IssueManagerSubtaskBoardStatus;
  taskId: string;
};
type IssueManagerSubtaskDropPreview = {
  index: number;
  status: IssueManagerSubtaskBoardStatus;
};
type IssueManagerSubtaskOptimisticDrop = {
  index: number;
  status: IssueManagerSubtaskBoardStatus;
  taskId: string;
};

const issueManagerSubtaskBoardStatuses = [
  "not_started",
  "running",
  "pending_acceptance",
  "completed",
  "failed",
  "canceled"
] as const satisfies readonly IssueManagerSubtaskBoardStatus[];

const issueManagerTaskStatusDragDataType =
  "application/x-tutti-issue-manager-task-status-drag";
const issueManagerBoardLayoutItemAttribute =
  "data-issue-manager-board-layout-item";
const issueManagerBoardLayoutAnimationDurationMs = 180;
const issueManagerBoardLayoutAnimationEasing = "cubic-bezier(0.22,1,0.36,1)";
const issueManagerSubtaskDragShadow = "var(--shadow-soft)";
const issueManagerSubtaskDragShadowClassName = "shadow-[var(--shadow-soft)]";
const issueManagerBoardLayoutAnimations = new WeakMap<HTMLElement, Animation>();
const issueManagerBoardLayoutInitialScrollSnapshot = {
  left: 0,
  top: 0
};

const issueManagerBoardStatusSet: Record<IssueManagerSubtaskBoardStatus, true> =
  {
    canceled: true,
    completed: true,
    failed: true,
    not_started: true,
    pending_acceptance: true,
    running: true
  };

function resolveIssueManagerSubtaskBoardStatus(
  status: IssueManagerStatus
): IssueManagerSubtaskBoardStatus {
  return status in issueManagerBoardStatusSet
    ? (status as IssueManagerSubtaskBoardStatus)
    : "not_started";
}

function isIssueManagerTaskBoardStatus(
  status: IssueManagerStatus
): status is IssueManagerSubtaskBoardStatus {
  return status in issueManagerBoardStatusSet;
}

function canIssueManagerCrossColumnDropTaskStatus(input: {
  sourceStatus: IssueManagerSubtaskBoardStatus;
  targetStatus: IssueManagerSubtaskBoardStatus;
}): boolean {
  if (input.sourceStatus === "pending_acceptance") {
    return (
      input.targetStatus === "not_started" || input.targetStatus === "completed"
    );
  }
  if (input.sourceStatus === "completed") {
    return (
      input.targetStatus === "not_started" ||
      input.targetStatus === "pending_acceptance"
    );
  }
  return false;
}

function canIssueManagerDropTaskStatus(input: {
  sourceStatus: IssueManagerSubtaskBoardStatus;
  targetStatus: IssueManagerSubtaskBoardStatus;
}): boolean {
  if (input.sourceStatus === input.targetStatus) {
    return true;
  }
  return canIssueManagerCrossColumnDropTaskStatus(input);
}

function groupIssueManagerSubtasksByStatus(
  tasks: readonly IssueManagerTaskSummary[],
  optimisticDrop: IssueManagerSubtaskOptimisticDrop | null = null
): Record<IssueManagerSubtaskBoardStatus, IssueManagerTaskSummary[]> {
  const groups: Record<
    IssueManagerSubtaskBoardStatus,
    IssueManagerTaskSummary[]
  > = {
    canceled: [],
    completed: [],
    failed: [],
    not_started: [],
    pending_acceptance: [],
    running: []
  };
  let optimisticTask: IssueManagerTaskSummary | null = null;

  for (const task of tasks) {
    if (optimisticDrop?.taskId === task.taskId) {
      optimisticTask = {
        ...task,
        status: optimisticDrop.status
      };
      continue;
    }
    groups[resolveIssueManagerSubtaskBoardStatus(task.status)].push(task);
  }

  if (optimisticTask && optimisticDrop) {
    const targetGroup = groups[optimisticDrop.status];
    targetGroup.splice(
      Math.min(Math.max(0, optimisticDrop.index), targetGroup.length),
      0,
      optimisticTask
    );
  }

  return groups;
}

function isIssueManagerOptimisticDropSettled(
  tasks: readonly IssueManagerTaskSummary[],
  optimisticDrop: IssueManagerSubtaskOptimisticDrop
): boolean {
  const optimisticTask = tasks.find(
    (task) => task.taskId === optimisticDrop.taskId
  );
  if (!optimisticTask) {
    return true;
  }
  if (
    resolveIssueManagerSubtaskBoardStatus(optimisticTask.status) !==
    optimisticDrop.status
  ) {
    return false;
  }
  const targetGroup = tasks.filter(
    (task) =>
      resolveIssueManagerSubtaskBoardStatus(task.status) ===
      optimisticDrop.status
  );
  const taskIndex = targetGroup.findIndex(
    (task) => task.taskId === optimisticDrop.taskId
  );
  if (taskIndex < 0) {
    return false;
  }
  const targetIndex = Math.min(
    Math.max(0, optimisticDrop.index),
    Math.max(0, targetGroup.length - 1)
  );
  return taskIndex === targetIndex;
}

function readIssueManagerTaskStatusDragData(
  dataTransfer: DataTransfer
): { sourceStatus: IssueManagerSubtaskBoardStatus; taskId: string } | null {
  try {
    const raw = dataTransfer.getData(issueManagerTaskStatusDragDataType);
    const payload = JSON.parse(raw) as Partial<{
      sourceStatus: IssueManagerStatus;
      taskId: unknown;
    }>;
    const taskId =
      typeof payload.taskId === "string" ? payload.taskId.trim() : "";
    const sourceStatus = payload.sourceStatus ?? "";
    if (!taskId || !isIssueManagerTaskBoardStatus(sourceStatus)) {
      return null;
    }
    return {
      sourceStatus,
      taskId
    };
  } catch {
    return null;
  }
}

function writeIssueManagerTaskStatusDragData(
  event: DragEvent<HTMLButtonElement>,
  task: IssueManagerTaskSummary,
  sourceStatus: IssueManagerSubtaskBoardStatus
): void {
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData(
    issueManagerTaskStatusDragDataType,
    JSON.stringify({ sourceStatus, taskId: task.taskId })
  );
  event.dataTransfer.setData("text/plain", task.taskId);
}

function setIssueManagerTaskDragImage(
  event: DragEvent<HTMLButtonElement>
): number {
  const source = event.currentTarget;
  const rect = source.getBoundingClientRect();
  const clone = source.cloneNode(true) as HTMLElement;
  clone.style.position = "fixed";
  clone.style.pointerEvents = "none";
  clone.style.top = "-10000px";
  clone.style.left = "-10000px";
  clone.style.width = `${rect.width}px`;
  clone.style.borderRadius = "8px";
  clone.style.boxShadow = issueManagerSubtaskDragShadow;
  clone.style.background = "var(--background-fronted)";
  clone.style.opacity = "1";
  document.body.append(clone);
  event.dataTransfer.setDragImage(
    clone,
    Math.max(0, event.clientX - rect.left),
    Math.max(0, event.clientY - rect.top)
  );
  window.setTimeout(() => clone.remove(), 0);
  return rect.height;
}

function resolveIssueManagerDropPreviewIndex(input: {
  draggingTaskId: string | null;
  event: DragEvent<HTMLDivElement>;
}): number {
  const cards = Array.from(
    input.event.currentTarget.querySelectorAll<HTMLElement>(
      "[data-issue-manager-board-card]"
    )
  ).filter(
    (card) => card.dataset.issueManagerBoardCardTaskId !== input.draggingTaskId
  );
  for (const [index, card] of cards.entries()) {
    const rect = card.getBoundingClientRect();
    if (input.event.clientY < rect.top + rect.height / 2) {
      return index;
    }
  }
  return cards.length;
}

function orderIssueManagerTasksForSameColumnDropPreview(input: {
  dragState: IssueManagerSubtaskDragState | null;
  dropPreview: IssueManagerSubtaskDropPreview | null;
  status: IssueManagerSubtaskBoardStatus;
  tasks: readonly IssueManagerTaskSummary[];
}): readonly IssueManagerTaskSummary[] {
  if (
    !input.dragState ||
    input.dragState.sourceStatus !== input.status ||
    input.dropPreview?.status !== input.status
  ) {
    return input.tasks;
  }
  const sourceTaskIndex = input.tasks.findIndex(
    (task) => task.taskId === input.dragState?.taskId
  );
  if (sourceTaskIndex < 0) {
    return input.tasks;
  }
  const movingTask = input.tasks[sourceTaskIndex];
  if (!movingTask) {
    return input.tasks;
  }
  const nextTasks = input.tasks.filter((_, index) => index !== sourceTaskIndex);
  const targetIndex = Math.min(
    Math.max(0, input.dropPreview.index),
    nextTasks.length
  );
  if (targetIndex === sourceTaskIndex) {
    return input.tasks;
  }
  nextTasks.splice(targetIndex, 0, movingTask);
  return nextTasks;
}

function isLeavingIssueManagerBoardColumn(
  event: DragEvent<HTMLDivElement>
): boolean {
  const relatedTarget = event.relatedTarget;
  if (
    relatedTarget instanceof Node &&
    event.currentTarget.contains(relatedTarget)
  ) {
    return false;
  }
  const rect = event.currentTarget.getBoundingClientRect();
  return !(
    event.clientX >= rect.left &&
    event.clientX <= rect.right &&
    event.clientY >= rect.top &&
    event.clientY <= rect.bottom
  );
}

function prefersReducedIssueManagerBoardMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function readIssueManagerBoardScrollSnapshot(board: HTMLElement): {
  left: number;
  top: number;
} {
  const scrollContainer = board.parentElement;
  return {
    left: scrollContainer?.scrollLeft ?? 0,
    top: scrollContainer?.scrollTop ?? 0
  };
}

function useIssueManagerBoardLayoutAnimation() {
  const boardRef = useRef<HTMLDivElement | null>(null);
  const previousRectsRef = useRef<Map<string, DOMRectReadOnly>>(new Map());
  const previousScrollSnapshotRef = useRef(
    issueManagerBoardLayoutInitialScrollSnapshot
  );

  useLayoutEffect(() => {
    const board = boardRef.current;
    if (!board) {
      return;
    }
    const elements = Array.from(
      board.querySelectorAll<HTMLElement>(
        `[${issueManagerBoardLayoutItemAttribute}]`
      )
    );
    const nextRects = new Map<string, DOMRectReadOnly>();
    const nextScrollSnapshot = readIssueManagerBoardScrollSnapshot(board);
    const previousScrollSnapshot = previousScrollSnapshotRef.current;
    const didScrollSinceLastLayout =
      previousScrollSnapshot.left !== nextScrollSnapshot.left ||
      previousScrollSnapshot.top !== nextScrollSnapshot.top;
    const shouldAnimate =
      !didScrollSinceLastLayout && !prefersReducedIssueManagerBoardMotion();
    const activeVisualTopByKey = new Map<string, number>();

    for (const element of elements) {
      const key = element.getAttribute(issueManagerBoardLayoutItemAttribute);
      const animation = issueManagerBoardLayoutAnimations.get(element);
      if (!key || !animation) {
        continue;
      }
      activeVisualTopByKey.set(key, element.getBoundingClientRect().top);
      animation.cancel();
      issueManagerBoardLayoutAnimations.delete(element);
    }

    for (const element of elements) {
      const key = element.getAttribute(issueManagerBoardLayoutItemAttribute);
      if (!key) {
        continue;
      }
      const rect = element.getBoundingClientRect();
      nextRects.set(key, rect);
      const previousRect = previousRectsRef.current.get(key);
      if (!shouldAnimate || !previousRect) {
        continue;
      }
      const deltaY =
        (activeVisualTopByKey.get(key) ?? previousRect.top) - rect.top;
      if (Math.abs(deltaY) < 0.5) {
        continue;
      }
      const animation = element.animate(
        [
          { transform: `translate3d(0, ${deltaY}px, 0)` },
          { transform: "translate3d(0, 0, 0)" }
        ],
        {
          duration: issueManagerBoardLayoutAnimationDurationMs,
          easing: issueManagerBoardLayoutAnimationEasing
        }
      );
      issueManagerBoardLayoutAnimations.set(element, animation);
      animation.onfinish = () => {
        if (issueManagerBoardLayoutAnimations.get(element) === animation) {
          issueManagerBoardLayoutAnimations.delete(element);
        }
      };
      animation.oncancel = animation.onfinish;
    }

    previousRectsRef.current = nextRects;
    previousScrollSnapshotRef.current = nextScrollSnapshot;
  });

  return boardRef;
}

export function IssueManagerSubtaskBoard({
  copy,
  onMoveTask,
  onSelectTask,
  tasks
}: {
  copy: IssueManagerI18nRuntime;
  onMoveTask: (input: {
    targetIndex: number;
    targetStatus: IssueManagerSubtaskBoardStatus;
    taskId: string;
    visibleTaskIds?: readonly string[];
  }) => Promise<void>;
  onSelectTask: (
    event: MouseEvent<HTMLButtonElement>,
    task: IssueManagerTaskSummary,
    surface: "detail_subtasks_board"
  ) => void;
  tasks: readonly IssueManagerTaskSummary[];
}): JSX.Element {
  const [optimisticDrop, setOptimisticDrop] =
    useState<IssueManagerSubtaskOptimisticDrop | null>(null);
  const groups = groupIssueManagerSubtasksByStatus(tasks, optimisticDrop);
  const visibleTaskIds = tasks.map((task) => task.taskId);
  const [dragState, setDragState] =
    useState<IssueManagerSubtaskDragState | null>(null);
  const [dropPreview, setDropPreview] =
    useState<IssueManagerSubtaskDropPreview | null>(null);
  const boardLayoutRef = useIssueManagerBoardLayoutAnimation();

  useEffect(() => {
    if (!optimisticDrop) {
      return;
    }
    if (isIssueManagerOptimisticDropSettled(tasks, optimisticDrop)) {
      setOptimisticDrop(null);
    }
  }, [optimisticDrop, tasks]);

  const handleTaskDragStart = (
    event: DragEvent<HTMLButtonElement>,
    task: IssueManagerTaskSummary,
    sourceStatus: IssueManagerSubtaskBoardStatus
  ) => {
    const cardHeight = setIssueManagerTaskDragImage(event);
    writeIssueManagerTaskStatusDragData(event, task, sourceStatus);
    setDragState({
      cardHeight,
      sourceStatus,
      taskId: task.taskId
    });
    setOptimisticDrop(null);
    setDropPreview(null);
  };
  const handleTaskDragEnd = () => {
    setDragState(null);
    setDropPreview(null);
  };

  return (
    <div className="issue-manager-board-scroll min-w-0 overflow-x-auto pb-1">
      <div
        className="grid min-w-[1560px] grid-cols-6 gap-3"
        ref={boardLayoutRef}
      >
        {issueManagerSubtaskBoardStatuses.map((status) => (
          <IssueManagerSubtaskBoardColumn
            copy={copy}
            key={status}
            status={status}
            tasks={groups[status]}
            visibleTaskIds={visibleTaskIds}
            dragState={dragState}
            dropPreview={dropPreview}
            onDropPreviewChange={setDropPreview}
            onOptimisticDropChange={setOptimisticDrop}
            onMoveTask={onMoveTask}
            onSelectTask={onSelectTask}
            onTaskDragEnd={handleTaskDragEnd}
            onTaskDragStart={handleTaskDragStart}
          />
        ))}
      </div>
    </div>
  );
}

function IssueManagerSubtaskBoardColumn({
  copy,
  dragState,
  dropPreview,
  onMoveTask,
  onDropPreviewChange,
  onOptimisticDropChange,
  onSelectTask,
  onTaskDragEnd,
  onTaskDragStart,
  status,
  tasks,
  visibleTaskIds
}: {
  copy: IssueManagerI18nRuntime;
  dragState: IssueManagerSubtaskDragState | null;
  dropPreview: IssueManagerSubtaskDropPreview | null;
  onMoveTask: (input: {
    targetIndex: number;
    targetStatus: IssueManagerSubtaskBoardStatus;
    taskId: string;
    visibleTaskIds?: readonly string[];
  }) => Promise<void>;
  onDropPreviewChange: (preview: IssueManagerSubtaskDropPreview | null) => void;
  onOptimisticDropChange: (
    optimisticDrop: IssueManagerSubtaskOptimisticDrop | null
  ) => void;
  onSelectTask: (
    event: MouseEvent<HTMLButtonElement>,
    task: IssueManagerTaskSummary,
    surface: "detail_subtasks_board"
  ) => void;
  onTaskDragEnd: () => void;
  onTaskDragStart: (
    event: DragEvent<HTMLButtonElement>,
    task: IssueManagerTaskSummary,
    sourceStatus: IssueManagerSubtaskBoardStatus
  ) => void;
  status: IssueManagerSubtaskBoardStatus;
  tasks: readonly IssueManagerTaskSummary[];
  visibleTaskIds: readonly string[];
}): JSX.Element {
  const canAcceptTaskDrop =
    Boolean(dragState) &&
    canIssueManagerDropTaskStatus({
      sourceStatus: dragState?.sourceStatus ?? "completed",
      targetStatus: status
    });
  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!canAcceptTaskDrop) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const nextPreview = {
      index: resolveIssueManagerDropPreviewIndex({
        draggingTaskId: dragState?.taskId ?? null,
        event
      }),
      status
    };
    if (
      dropPreview?.index !== nextPreview.index ||
      dropPreview?.status !== nextPreview.status
    ) {
      onDropPreviewChange(nextPreview);
    }
  };
  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (
      dropPreview?.status === status &&
      isLeavingIssueManagerBoardColumn(event)
    ) {
      onDropPreviewChange(null);
    }
  };
  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    const payload = readIssueManagerTaskStatusDragData(event.dataTransfer);
    const taskId = payload?.taskId ?? dragState?.taskId;
    const sourceStatus = payload?.sourceStatus ?? dragState?.sourceStatus;
    if (
      !taskId ||
      !sourceStatus ||
      !canIssueManagerDropTaskStatus({
        sourceStatus,
        targetStatus: status
      })
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const targetIndex =
      dropPreview?.status === status
        ? dropPreview.index
        : resolveIssueManagerDropPreviewIndex({
            draggingTaskId: taskId,
            event
          });
    onOptimisticDropChange({
      index: targetIndex,
      status,
      taskId
    });
    onDropPreviewChange(null);
    void onMoveTask({
      targetIndex,
      targetStatus: status,
      taskId,
      visibleTaskIds
    }).catch(() => {
      onOptimisticDropChange(null);
    });
  };
  const renderTasks = orderIssueManagerTasksForSameColumnDropPreview({
    dragState,
    dropPreview,
    status,
    tasks
  });
  const isSameColumnDropPreview =
    Boolean(dragState) &&
    dragState?.sourceStatus === status &&
    dropPreview?.status === status &&
    tasks.some((task) => task.taskId === dragState?.taskId);
  const activeDropPreviewDragState =
    dropPreview?.status === status && dragState && !isSameColumnDropPreview
      ? dragState
      : null;
  const renderDropPreview = (renderIndex: number): JSX.Element | null => {
    if (!activeDropPreviewDragState || dropPreview?.index !== renderIndex) {
      return null;
    }
    return (
      <div
        aria-hidden="true"
        className={cn(
          "rounded-[8px] border border-dashed motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-[0.98] motion-safe:duration-[160ms] motion-safe:ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:animate-none",
          resolveIssueManagerBoardPlaceholderClassName(status)
        )}
        data-issue-manager-board-layout-item={`preview:${status}`}
        data-task-status-drop-preview
        style={{
          height: `${Math.max(
            64,
            Math.min(activeDropPreviewDragState.cardHeight, 160)
          )}px`
        }}
      />
    );
  };

  return (
    <div
      className={cn(
        "min-h-[220px] rounded-lg border px-2.5 py-2.5",
        canAcceptTaskDrop &&
          "transition-shadow duration-[180ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
        resolveIssueManagerBoardColumnClassName(status)
      )}
      data-task-status-drop-target={canAcceptTaskDrop || undefined}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            aria-hidden="true"
            className={cn(
              "size-2 rounded-full",
              resolveIssueManagerBoardDotClassName(status)
            )}
          />
          <span className="truncate text-[12px] font-semibold text-[var(--text-primary)]">
            {resolveIssueManagerStatusLabel(copy, status)}
          </span>
        </div>
        <span className="shrink-0 text-[12px] font-semibold text-[var(--text-secondary)]">
          {tasks.length}
        </span>
      </div>
      <div className="grid gap-2">
        {renderDropPreview(0)}
        {renderTasks.map((task, index) => {
          const dragStatus = resolveIssueManagerSubtaskBoardStatus(task.status);
          const isDraggingTask = dragState?.taskId === task.taskId;
          return (
            <div
              className="grid gap-2"
              data-issue-manager-board-layout-item={`task:${status}:${task.taskId}`}
              key={task.taskId}
            >
              <button
                className={cn(
                  "rounded-[8px] bg-[var(--background-board-card)] p-2 text-left transition-shadow duration-150 motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25",
                  "cursor-grab active:cursor-grabbing",
                  isDraggingTask && issueManagerSubtaskDragShadowClassName
                )}
                data-issue-manager-board-card
                data-issue-manager-board-card-task-id={task.taskId}
                draggable
                type="button"
                onClick={(event) =>
                  onSelectTask(event, task, "detail_subtasks_board")
                }
                onDragEnd={onTaskDragEnd}
                onDragStart={(event) => {
                  if (!dragStatus) {
                    event.preventDefault();
                    return;
                  }
                  onTaskDragStart(event, task, dragStatus);
                }}
              >
                <IssueManagerTitleTooltip title={task.title}>
                  <span className="line-clamp-2 text-[13px] font-semibold leading-[1.35] text-[var(--text-primary)] [overflow-wrap:anywhere]">
                    {task.title}
                  </span>
                </IssueManagerTitleTooltip>
                <span className="mt-1 block empty:hidden">
                  <IssueManagerTaskStructureChips copy={copy} task={task} />
                </span>
                <p className="mt-2 line-clamp-3 text-[11px] font-normal leading-[1.5] text-[var(--text-secondary)] [overflow-wrap:anywhere]">
                  {summarizeIssueManagerContent(
                    task.content,
                    copy.t("messages.taskContentEmpty")
                  )}
                </p>
                <span className="mt-2 block text-[11px] font-normal text-[var(--text-tertiary)]">
                  {formatIssueManagerTimestamp(
                    task.createdAtUnix ?? task.updatedAtUnix
                  ) || ""}
                </span>
              </button>
              {renderDropPreview(index + 1)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function resolveIssueManagerBoardPlaceholderClassName(
  status: IssueManagerSubtaskBoardStatus
): string {
  switch (status) {
    case "pending_acceptance":
      return "border-[color-mix(in_srgb,var(--tutti-purple)_24%,transparent)] bg-[color-mix(in_srgb,var(--tutti-purple)_18%,transparent)]";
    case "completed":
      return "border-[color-mix(in_srgb,var(--state-success)_24%,transparent)] bg-[color-mix(in_srgb,var(--state-success)_18%,transparent)]";
    case "not_started":
      return "border-[color-mix(in_srgb,var(--text-secondary)_20%,transparent)] bg-[color-mix(in_srgb,var(--text-secondary)_12%,transparent)]";
    default:
      return "border-[color-mix(in_srgb,var(--text-secondary)_18%,transparent)] bg-[color-mix(in_srgb,var(--text-secondary)_10%,transparent)]";
  }
}

function resolveIssueManagerBoardColumnClassName(
  status: IssueManagerSubtaskBoardStatus
): string {
  switch (status) {
    case "running":
      return "border-[color-mix(in_srgb,var(--status-running)_12%,transparent)] bg-[color-mix(in_srgb,var(--status-running)_8%,transparent)]";
    case "pending_acceptance":
      return "border-[color-mix(in_srgb,var(--tutti-purple)_12%,transparent)] bg-[color-mix(in_srgb,var(--tutti-purple)_8%,transparent)]";
    case "completed":
      return "border-[color-mix(in_srgb,var(--state-success)_12%,transparent)] bg-[color-mix(in_srgb,var(--state-success)_8%,transparent)]";
    case "failed":
      return "border-[color-mix(in_srgb,var(--state-danger)_12%,transparent)] bg-[color-mix(in_srgb,var(--state-danger)_8%,transparent)]";
    case "canceled":
      return "border-[color-mix(in_srgb,var(--text-secondary)_12%,transparent)] bg-[color-mix(in_srgb,var(--text-secondary)_8%,transparent)]";
    default:
      return "border-[color-mix(in_srgb,var(--text-secondary)_12%,transparent)] bg-[color-mix(in_srgb,var(--text-secondary)_8%,transparent)]";
  }
}

function resolveIssueManagerBoardDotClassName(
  status: IssueManagerSubtaskBoardStatus
): string {
  switch (status) {
    case "running":
      return "bg-[var(--status-running)]";
    case "pending_acceptance":
      return "bg-[var(--tutti-purple)]";
    case "completed":
      return "bg-[var(--state-success)]";
    case "failed":
      return "bg-[var(--state-danger)]";
    case "canceled":
      return "bg-[var(--text-tertiary)]";
    default:
      return "bg-[var(--text-secondary)]";
  }
}
