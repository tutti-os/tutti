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
  IssueManagerTaskStatusUpdate,
  IssueManagerTaskSummary
} from "../../../contracts/index.ts";
import {
  formatIssueManagerTimestamp,
  resolveIssueManagerStatusLabel
} from "../../../services/controllerModel.ts";
import type { IssueManagerI18nRuntime } from "../../../i18n/issueManagerI18n.ts";
import { IssueManagerTitleTooltip } from "../content/IssueManagerTitleTooltip.tsx";
import { summarizeIssueManagerContent } from "../panel/IssueManagerPanelText.ts";

type IssueManagerSubtaskBoardStatus =
  | "not_started"
  | "running"
  | "pending_acceptance"
  | "completed"
  | "failed"
  | "canceled";

type IssueManagerSubtaskDragStatus = "completed" | "pending_acceptance";
type IssueManagerSubtaskDragState = {
  cardHeight: number;
  sourceStatus: IssueManagerSubtaskDragStatus;
  taskId: string;
};
type IssueManagerSubtaskDropPreview = {
  index: number;
  status: IssueManagerTaskStatusUpdate;
};
type IssueManagerSubtaskOptimisticDrop = {
  index: number;
  status: IssueManagerTaskStatusUpdate;
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
  return status === "in_progress"
    ? "running"
    : status in issueManagerBoardStatusSet
      ? (status as IssueManagerSubtaskBoardStatus)
      : "not_started";
}

function isIssueManagerTaskDropTargetStatus(
  status: IssueManagerSubtaskBoardStatus
): status is IssueManagerTaskStatusUpdate {
  return (
    status === "not_started" ||
    status === "pending_acceptance" ||
    status === "completed"
  );
}

function isIssueManagerTaskDragStatus(
  status: IssueManagerStatus
): status is IssueManagerSubtaskDragStatus {
  return status === "pending_acceptance" || status === "completed";
}

function canIssueManagerDropTaskStatus(input: {
  sourceStatus: IssueManagerSubtaskDragStatus;
  targetStatus: IssueManagerTaskStatusUpdate;
}): boolean {
  if (input.sourceStatus === "pending_acceptance") {
    return (
      input.targetStatus === "not_started" || input.targetStatus === "completed"
    );
  }
  return (
    input.targetStatus === "not_started" ||
    input.targetStatus === "pending_acceptance"
  );
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

function hasIssueManagerTaskStatusDragData(
  dataTransfer: DataTransfer
): boolean {
  return Array.from(dataTransfer.types).includes(
    issueManagerTaskStatusDragDataType
  );
}

function readIssueManagerTaskStatusDragData(
  dataTransfer: DataTransfer
): { sourceStatus: IssueManagerSubtaskDragStatus; taskId: string } | null {
  try {
    const raw = dataTransfer.getData(issueManagerTaskStatusDragDataType);
    const payload = JSON.parse(raw) as Partial<{
      sourceStatus: IssueManagerStatus;
      taskId: unknown;
    }>;
    const taskId =
      typeof payload.taskId === "string" ? payload.taskId.trim() : "";
    const sourceStatus = payload.sourceStatus ?? "";
    if (!taskId || !isIssueManagerTaskDragStatus(sourceStatus)) {
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
  sourceStatus: IssueManagerSubtaskDragStatus
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

function resolveIssueManagerDropPreviewIndex(
  event: DragEvent<HTMLDivElement>
): number {
  const cards = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>(
      "[data-issue-manager-board-card]"
    )
  );
  for (const [index, card] of cards.entries()) {
    const rect = card.getBoundingClientRect();
    if (event.clientY < rect.top + rect.height / 2) {
      return index;
    }
  }
  return cards.length;
}

function isLeavingIssueManagerBoardColumn(
  event: DragEvent<HTMLDivElement>
): boolean {
  const relatedTarget = event.relatedTarget;
  return !(
    relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)
  );
}

function prefersReducedIssueManagerBoardMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function useIssueManagerBoardLayoutAnimation() {
  const boardRef = useRef<HTMLDivElement | null>(null);
  const previousRectsRef = useRef<Map<string, DOMRectReadOnly>>(new Map());

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
    const shouldAnimate = !prefersReducedIssueManagerBoardMotion();

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
      const deltaX = previousRect.left - rect.left;
      const deltaY = previousRect.top - rect.top;
      if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) {
        continue;
      }
      issueManagerBoardLayoutAnimations.get(element)?.cancel();
      const animation = element.animate(
        [
          { transform: `translate3d(${deltaX}px, ${deltaY}px, 0)` },
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
  });

  return boardRef;
}

export function IssueManagerSubtaskBoard({
  copy,
  onSelectTask,
  onSetTaskStatus,
  tasks
}: {
  copy: IssueManagerI18nRuntime;
  onSelectTask: (
    event: MouseEvent<HTMLButtonElement>,
    task: IssueManagerTaskSummary,
    surface: "detail_subtasks_board"
  ) => void;
  onSetTaskStatus: (
    taskId: string,
    status: IssueManagerTaskStatusUpdate
  ) => Promise<void>;
  tasks: readonly IssueManagerTaskSummary[];
}): JSX.Element {
  const [optimisticDrop, setOptimisticDrop] =
    useState<IssueManagerSubtaskOptimisticDrop | null>(null);
  const groups = groupIssueManagerSubtasksByStatus(tasks, optimisticDrop);
  const [dragState, setDragState] =
    useState<IssueManagerSubtaskDragState | null>(null);
  const [dropPreview, setDropPreview] =
    useState<IssueManagerSubtaskDropPreview | null>(null);
  const boardLayoutRef = useIssueManagerBoardLayoutAnimation();

  useEffect(() => {
    if (!optimisticDrop) {
      return;
    }
    const droppedTask = tasks.find(
      (task) => task.taskId === optimisticDrop.taskId
    );
    if (
      !droppedTask ||
      resolveIssueManagerSubtaskBoardStatus(droppedTask.status) ===
        optimisticDrop.status
    ) {
      setOptimisticDrop(null);
    }
  }, [optimisticDrop, tasks]);

  const handleTaskDragStart = (
    event: DragEvent<HTMLButtonElement>,
    task: IssueManagerTaskSummary,
    sourceStatus: IssueManagerSubtaskDragStatus
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
    <div className="min-w-0 overflow-x-auto pb-1 [scrollbar-width:thin]">
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
            dragState={dragState}
            dropPreview={dropPreview}
            onDropPreviewChange={setDropPreview}
            onOptimisticDropChange={setOptimisticDrop}
            onSelectTask={onSelectTask}
            onSetTaskStatus={onSetTaskStatus}
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
  onDropPreviewChange,
  onOptimisticDropChange,
  onSelectTask,
  onSetTaskStatus,
  onTaskDragEnd,
  onTaskDragStart,
  status,
  tasks
}: {
  copy: IssueManagerI18nRuntime;
  dragState: IssueManagerSubtaskDragState | null;
  dropPreview: IssueManagerSubtaskDropPreview | null;
  onDropPreviewChange: (preview: IssueManagerSubtaskDropPreview | null) => void;
  onOptimisticDropChange: (
    optimisticDrop: IssueManagerSubtaskOptimisticDrop | null
  ) => void;
  onSelectTask: (
    event: MouseEvent<HTMLButtonElement>,
    task: IssueManagerTaskSummary,
    surface: "detail_subtasks_board"
  ) => void;
  onSetTaskStatus: (
    taskId: string,
    status: IssueManagerTaskStatusUpdate
  ) => Promise<void>;
  onTaskDragEnd: () => void;
  onTaskDragStart: (
    event: DragEvent<HTMLButtonElement>,
    task: IssueManagerTaskSummary,
    sourceStatus: IssueManagerSubtaskDragStatus
  ) => void;
  status: IssueManagerSubtaskBoardStatus;
  tasks: readonly IssueManagerTaskSummary[];
}): JSX.Element {
  const dropTargetStatus = isIssueManagerTaskDropTargetStatus(status)
    ? status
    : null;
  const canAcceptTaskDrop =
    Boolean(dropTargetStatus && dragState) &&
    canIssueManagerDropTaskStatus({
      sourceStatus: dragState?.sourceStatus ?? "completed",
      targetStatus: dropTargetStatus ?? "not_started"
    });
  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (
      !dropTargetStatus ||
      !canAcceptTaskDrop ||
      !hasIssueManagerTaskStatusDragData(event.dataTransfer)
    ) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const nextPreview = {
      index: resolveIssueManagerDropPreviewIndex(event),
      status: dropTargetStatus
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
    if (!dropTargetStatus) {
      return;
    }
    const payload = readIssueManagerTaskStatusDragData(event.dataTransfer);
    const taskId = payload?.taskId ?? dragState?.taskId;
    const sourceStatus = payload?.sourceStatus ?? dragState?.sourceStatus;
    if (
      !taskId ||
      !sourceStatus ||
      !canIssueManagerDropTaskStatus({
        sourceStatus,
        targetStatus: dropTargetStatus
      })
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const targetIndex =
      dropPreview?.status === dropTargetStatus
        ? dropPreview.index
        : resolveIssueManagerDropPreviewIndex(event);
    onOptimisticDropChange({
      index: targetIndex,
      status: dropTargetStatus,
      taskId
    });
    onDropPreviewChange(null);
    void onSetTaskStatus(taskId, dropTargetStatus).catch(() => {
      onOptimisticDropChange(null);
    });
  };
  const shouldShowDropPreview = dropPreview?.status === status && dragState;
  const renderDropPreview = (index: number): JSX.Element | null => {
    if (!shouldShowDropPreview || dropPreview.index !== index) {
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
          height: `${Math.max(64, Math.min(dragState.cardHeight, 160))}px`
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
        {tasks.map((task, index) => {
          const dragStatus = isIssueManagerTaskDragStatus(task.status)
            ? task.status
            : null;
          const isDraggingTask = dragState?.taskId === task.taskId;
          return (
            <div
              className="grid gap-2"
              data-issue-manager-board-layout-item={`task:${task.taskId}`}
              key={task.taskId}
            >
              <button
                className={cn(
                  "rounded-[8px] bg-[var(--background-fronted)] px-3 py-2.5 text-left transition-shadow duration-150 motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25",
                  dragStatus && "cursor-grab active:cursor-grabbing",
                  isDraggingTask && issueManagerSubtaskDragShadowClassName
                )}
                data-issue-manager-board-card
                draggable={Boolean(dragStatus)}
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
      return "border-[color-mix(in_srgb,var(--state-warning)_24%,transparent)] bg-[color-mix(in_srgb,var(--state-warning)_18%,transparent)]";
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
      return "border-[color-mix(in_srgb,var(--state-warning)_12%,transparent)] bg-[color-mix(in_srgb,var(--state-warning)_8%,transparent)]";
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
      return "bg-[var(--state-warning)]";
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
