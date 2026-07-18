import {
  useRef,
  useState,
  type AnimationEvent,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent
} from "react";
import { CircleMinus, CirclePlus } from "lucide-react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  toast
} from "@tutti-os/ui-system";
import type { AgentGUINodeViewModel } from "../model/agentGuiNodeTypes";
import type { AgentGUIViewLabels } from "../AgentGUINodeView";
import {
  AgentGUIProviderIconVisual,
  agentGUIProviderRailIconPresentation
} from "./AgentGUIEmptyState";

type ProviderRailTarget = AgentGUINodeViewModel["rail"]["agentTargets"][number];
type ProviderManagerZone = "available" | "disabled";

interface ProviderManagerDropPlacement {
  overTargetId: string;
  position: "before" | "after";
}

interface ProviderManagerDragState {
  source: ProviderManagerZone;
  targetId: string;
}

type ProviderManagerDragPreview = ProviderManagerDropPlacement;

interface AgentGUIProviderManagerDialogProps {
  hiddenTargetIds: readonly string[];
  labels: AgentGUIViewLabels;
  onMoveTarget: (
    draggedTargetId: string,
    overTargetId: string,
    position: "before" | "after"
  ) => void;
  onOpenChange: (open: boolean) => void;
  onVisibilityChange: (
    targetId: string,
    visible: boolean,
    placement?: ProviderManagerDropPlacement
  ) => void;
  open: boolean;
  runningTargetIds: readonly string[];
  targets: readonly ProviderRailTarget[];
}

const AGENT_MANAGER_LONG_PRESS_MOVE_TOLERANCE_PX = 8;
const AGENT_MANAGER_DROP_HYSTERESIS_PX = 8;

export function AgentGUIProviderManagerDialog({
  hiddenTargetIds,
  labels,
  onMoveTarget,
  onOpenChange,
  onVisibilityChange,
  open,
  runningTargetIds,
  targets
}: AgentGUIProviderManagerDialogProps): React.JSX.Element {
  const hidden = new Set(hiddenTargetIds);
  const running = new Set(runningTargetIds);
  const availableTargets = targets.filter(
    (target) => !hidden.has(target.targetId)
  );
  const disabledTargets = targets.filter((target) =>
    hidden.has(target.targetId)
  );
  const [editing, setEditing] = useState(false);
  const [dragState, setDragState] = useState<ProviderManagerDragState | null>(
    null
  );
  const [dragOverZone, setDragOverZone] = useState<ProviderManagerZone | null>(
    null
  );
  const [dragPreview, setDragPreview] =
    useState<ProviderManagerDragPreview | null>(null);
  const dragStateRef = useRef<ProviderManagerDragState | null>(null);
  const dragPreviewRef = useRef<ProviderManagerDragPreview | null>(null);
  const [longPressTargetId, setLongPressTargetId] = useState<string | null>(
    null
  );
  const longPressOriginRef = useRef<{ x: number; y: number } | null>(null);
  const finalAvailableAgent = availableTargets.length === 1;

  const showRunningAgentBlocked = (targetId: string) => {
    const target = targets.find((candidate) => candidate.targetId === targetId);
    const label = target?.label.trim() || target?.provider || targetId;
    toast.error(labels.manageAgentsRunningBlocked(label), {
      id: `agent-gui-provider-manager-running:${targetId}`
    });
  };

  const cancelLongPress = () => {
    setLongPressTargetId(null);
    longPressOriginRef.current = null;
  };

  const clearDrag = () => {
    dragStateRef.current = null;
    dragPreviewRef.current = null;
    setDragState(null);
    setDragOverZone(null);
    setDragPreview(null);
  };

  const updateDragState = (nextDragState: ProviderManagerDragState | null) => {
    dragStateRef.current = nextDragState;
    setDragState(nextDragState);
  };

  const updateDragPreview = (
    nextPreview: ProviderManagerDragPreview | null
  ) => {
    const currentPreview = dragPreviewRef.current;
    if (
      currentPreview?.overTargetId === nextPreview?.overTargetId &&
      currentPreview?.position === nextPreview?.position
    ) {
      return;
    }
    dragPreviewRef.current = nextPreview;
    setDragPreview(nextPreview);
  };

  const beginLongPress = (
    event: PointerEvent<HTMLDivElement>,
    targetId: string
  ) => {
    if (event.button !== 0 || (event.target as Element).closest("button")) {
      return;
    }
    longPressOriginRef.current = { x: event.clientX, y: event.clientY };
    setLongPressTargetId(targetId);
  };

  const moveLongPress = (event: PointerEvent<HTMLDivElement>) => {
    const origin = longPressOriginRef.current;
    if (
      origin &&
      (Math.abs(event.clientX - origin.x) >
        AGENT_MANAGER_LONG_PRESS_MOVE_TOLERANCE_PX ||
        Math.abs(event.clientY - origin.y) >
          AGENT_MANAGER_LONG_PRESS_MOVE_TOLERANCE_PX)
    ) {
      cancelLongPress();
    }
  };

  const finishLongPress = (
    event: AnimationEvent<HTMLDivElement>,
    targetId: string
  ) => {
    if (
      event.target === event.currentTarget &&
      longPressTargetId === targetId
    ) {
      cancelLongPress();
      setEditing(true);
    }
  };

  const handleOpenChange = (nextOpen: boolean) => {
    cancelLongPress();
    clearDrag();
    setEditing(false);
    onOpenChange(nextOpen);
  };

  const exitEditingFromBlankSpace = (event: MouseEvent<HTMLElement>) => {
    if (!(event.target as Element).closest("[data-agent-target-id]")) {
      setEditing(false);
    }
  };

  const resolveDragState = (
    event: DragEvent<HTMLElement>
  ): ProviderManagerDragState | null => {
    if (dragStateRef.current) {
      return dragStateRef.current;
    }
    const targetId = event.dataTransfer.getData("text/plain").trim();
    if (!targetId) {
      return null;
    }
    return {
      source: hidden.has(targetId) ? "disabled" : "available",
      targetId
    };
  };

  const canDropIntoZone = (
    dragged: ProviderManagerDragState,
    zone: ProviderManagerZone
  ) =>
    !(
      dragged.source === "available" &&
      zone === "disabled" &&
      (finalAvailableAgent || running.has(dragged.targetId))
    );

  const startDrag = (
    event: DragEvent<HTMLDivElement>,
    targetId: string,
    source: ProviderManagerZone
  ) => {
    cancelLongPress();
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", targetId);
    updateDragState({ source, targetId });
  };

  const dragOverDropZone = (
    event: DragEvent<HTMLElement>,
    zone: ProviderManagerZone
  ) => {
    const dragged = resolveDragState(event);
    if (!dragged) {
      return;
    }
    setDragOverZone(zone);
    updateDragPreview(null);
    if (!canDropIntoZone(dragged, zone)) {
      event.dataTransfer.dropEffect = "none";
      if (zone === "disabled" && running.has(dragged.targetId)) {
        showRunningAgentBlocked(dragged.targetId);
      }
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  };

  const targetDropPosition = (
    event: DragEvent<HTMLDivElement>,
    dragged: ProviderManagerDragState,
    overTarget: ProviderRailTarget,
    zone: ProviderManagerZone
  ): "before" | "after" => {
    const zoneTargets =
      zone === "available" ? availableTargets : disabledTargets;
    const draggedIndex = zoneTargets.findIndex(
      (candidate) => candidate.targetId === dragged.targetId
    );
    const overIndex = zoneTargets.findIndex(
      (candidate) => candidate.targetId === overTarget.targetId
    );
    if (dragged.source === zone && draggedIndex >= 0) {
      return draggedIndex < overIndex ? "after" : "before";
    }
    const bounds = event.currentTarget.getBoundingClientRect();
    const midpointX = bounds.left + bounds.width / 2;
    const activePreview = dragPreviewRef.current;
    if (activePreview?.overTargetId === overTarget.targetId) {
      if (
        activePreview.position === "before" &&
        event.clientX <= midpointX + AGENT_MANAGER_DROP_HYSTERESIS_PX
      ) {
        return "before";
      }
      if (
        activePreview.position === "after" &&
        event.clientX >= midpointX - AGENT_MANAGER_DROP_HYSTERESIS_PX
      ) {
        return "after";
      }
    }
    return event.clientX > midpointX ? "after" : "before";
  };

  const dragOverTarget = (
    event: DragEvent<HTMLDivElement>,
    overTarget: ProviderRailTarget,
    zone: ProviderManagerZone
  ) => {
    const dragged = resolveDragState(event);
    if (!dragged || dragged.targetId === overTarget.targetId) {
      return;
    }
    event.stopPropagation();
    setDragOverZone(zone);
    if (!canDropIntoZone(dragged, zone)) {
      event.dataTransfer.dropEffect = "none";
      updateDragPreview(null);
      if (zone === "disabled" && running.has(dragged.targetId)) {
        showRunningAgentBlocked(dragged.targetId);
      }
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    updateDragPreview({
      overTargetId: overTarget.targetId,
      position: targetDropPosition(event, dragged, overTarget, zone)
    });
  };

  const dropIntoZone = (
    event: DragEvent<HTMLElement>,
    zone: ProviderManagerZone
  ) => {
    const dragged = resolveDragState(event);
    if (!dragged || !canDropIntoZone(dragged, zone)) {
      clearDrag();
      return;
    }
    event.preventDefault();
    const zoneTargets =
      zone === "available" ? availableTargets : disabledTargets;
    const lastTarget = zoneTargets
      .filter((target) => target.targetId !== dragged.targetId)
      .at(-1);
    if (dragged.source === zone) {
      if (lastTarget) {
        onMoveTarget(dragged.targetId, lastTarget.targetId, "after");
      }
    } else {
      onVisibilityChange(
        dragged.targetId,
        zone === "available",
        lastTarget
          ? { overTargetId: lastTarget.targetId, position: "after" }
          : undefined
      );
    }
    clearDrag();
  };

  const dropOnTarget = (
    event: DragEvent<HTMLDivElement>,
    overTarget: ProviderRailTarget,
    zone: ProviderManagerZone
  ) => {
    const dragged = resolveDragState(event);
    if (
      !dragged ||
      dragged.targetId === overTarget.targetId ||
      !canDropIntoZone(dragged, zone)
    ) {
      clearDrag();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const activePreview = dragPreviewRef.current;
    const position =
      activePreview?.overTargetId === overTarget.targetId
        ? activePreview.position
        : targetDropPosition(event, dragged, overTarget, zone);
    if (dragged.source === zone) {
      onMoveTarget(dragged.targetId, overTarget.targetId, position);
    } else {
      onVisibilityChange(dragged.targetId, zone === "available", {
        overTargetId: overTarget.targetId,
        position
      });
    }
    clearDrag();
  };

  const disabledDropBlocked =
    dragState?.source === "available" &&
    (finalAvailableAgent || running.has(dragState.targetId));
  const disabledDropBlockedByRunning =
    dragState?.source === "available" && running.has(dragState.targetId);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="nodrag tsh-desktop-no-drag flex max-h-[min(680px,calc(100vh-32px))] flex-col gap-0 overflow-hidden p-0 [-webkit-app-region:no-drag] sm:max-w-[520px]"
        data-testid="agent-gui-provider-manager"
        onEscapeKeyDown={(event) => {
          if (!editing) {
            return;
          }
          event.preventDefault();
          cancelLongPress();
          clearDrag();
          setEditing(false);
        }}
      >
        <DialogHeader className="shrink-0 border-b border-[var(--border-1)] px-5 py-4">
          <DialogTitle>{labels.manageAgentsTitle}</DialogTitle>
          <DialogDescription>
            {labels.manageAgentsDescription}
          </DialogDescription>
        </DialogHeader>
        <div
          className="min-h-0 flex-1 overflow-y-auto px-5 py-4"
          onClick={exitEditingFromBlankSpace}
        >
          <section
            aria-labelledby="agent-manager-available-heading"
            className="agent-gui-provider-manager-drop-zone rounded-[10px] p-2"
            data-drop-active={dragOverZone === "available" ? "true" : undefined}
            data-testid="agent-gui-provider-manager-available-drop-zone"
            onDragOver={(event) => dragOverDropZone(event, "available")}
            onDrop={(event) => dropIntoZone(event, "available")}
          >
            <h3
              className="mb-3 text-[12px] font-medium text-[var(--text-secondary)]"
              id="agent-manager-available-heading"
            >
              {labels.manageAgentsAvailable}
            </h3>
            {availableTargets.length > 0 ? (
              <div
                aria-label={labels.manageAgentsAvailable}
                className="grid grid-cols-5 gap-x-3 gap-y-4 rounded-[8px] border border-dashed border-[var(--border-1)] px-3 py-4"
                data-editing={editing ? "true" : "false"}
                onClick={exitEditingFromBlankSpace}
                role="list"
              >
                {availableTargets.map((target) => {
                  const label = target.label.trim() || target.provider;
                  const targetRunning = running.has(target.targetId);
                  return (
                    <div
                      aria-label={labels.dragAgentToReorder(label)}
                      className="agent-gui-provider-manager-tile nodrag relative flex min-w-0 cursor-grab flex-col items-center rounded-[10px] px-2 py-1 outline-none transition-[background-color,opacity,box-shadow] focus-visible:ring-2 focus-visible:ring-[var(--border-focus)] active:cursor-grabbing [-webkit-app-region:no-drag]"
                      data-agent-target-id={target.targetId}
                      data-dragging={
                        dragState?.targetId === target.targetId
                          ? "true"
                          : undefined
                      }
                      data-drag-active={dragState ? "true" : undefined}
                      data-editing={editing ? "true" : "false"}
                      data-drag-over={
                        dragPreview?.overTargetId === target.targetId
                          ? dragPreview.position
                          : undefined
                      }
                      data-long-press={
                        longPressTargetId === target.targetId
                          ? "true"
                          : undefined
                      }
                      data-running={targetRunning ? "true" : undefined}
                      data-testid="agent-gui-provider-manager-tile"
                      draggable
                      key={target.targetId}
                      onAnimationEnd={(event) =>
                        finishLongPress(event, target.targetId)
                      }
                      onContextMenu={(event) => {
                        event.preventDefault();
                        setEditing(true);
                      }}
                      onDragEnd={clearDrag}
                      onDragOver={(event) =>
                        dragOverTarget(event, target, "available")
                      }
                      onDragStart={(event) =>
                        startDrag(event, target.targetId, "available")
                      }
                      onDrop={(event) =>
                        dropOnTarget(event, target, "available")
                      }
                      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          setEditing(true);
                        }
                      }}
                      onPointerCancel={cancelLongPress}
                      onPointerDown={(event) =>
                        beginLongPress(event, target.targetId)
                      }
                      onPointerLeave={cancelLongPress}
                      onPointerMove={moveLongPress}
                      onPointerUp={cancelLongPress}
                      role="listitem"
                      tabIndex={0}
                    >
                      {dragPreview?.overTargetId === target.targetId ? (
                        <span
                          aria-hidden="true"
                          className="agent-gui-provider-manager-drop-indicator"
                          data-position={dragPreview.position}
                          data-testid="agent-gui-provider-manager-drop-indicator"
                        />
                      ) : null}
                      {editing ? (
                        <Button
                          aria-label={labels.removeAgentFromSidebar(label)}
                          className="absolute right-0.5 top-0 z-10 size-5 rounded-full bg-[var(--background-panel)] p-0 text-[var(--state-danger)] shadow-sm hover:bg-[var(--transparency-hover)] hover:text-[var(--state-danger-hover)]"
                          disabled={finalAvailableAgent && !targetRunning}
                          onClick={(event) => {
                            event.stopPropagation();
                            if (targetRunning) {
                              showRunningAgentBlocked(target.targetId);
                              return;
                            }
                            onVisibilityChange(target.targetId, false);
                          }}
                          size="icon-xs"
                          title={
                            targetRunning
                              ? labels.manageAgentsRunningBlocked(label)
                              : finalAvailableAgent
                                ? labels.manageAgentsKeepOneAvailable
                                : undefined
                          }
                          type="button"
                          variant="ghost"
                        >
                          <CircleMinus aria-hidden="true" className="size-4" />
                        </Button>
                      ) : null}
                      <AgentGUIProviderIconVisual
                        ariaHidden
                        icon={agentGUIProviderRailIconPresentation(
                          target.provider,
                          target.iconUrl
                        )}
                        imageClassName="size-9 shrink-0 rounded-[9px] object-cover"
                      />
                      <span className="mt-2 block w-full truncate text-center text-[12px] font-medium text-[var(--text-primary)]">
                        {label}
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="rounded-[8px] bg-[var(--transparency-block)] px-3 py-4 text-center text-[12px] text-[var(--text-tertiary)]">
                {labels.manageAgentsNoAvailable}
              </p>
            )}
          </section>

          <section
            aria-labelledby="agent-manager-disabled-heading"
            className="agent-gui-provider-manager-drop-zone mt-3 rounded-[10px] p-2 pt-4"
            data-drop-active={
              dragOverZone === "disabled" && !disabledDropBlocked
                ? "true"
                : undefined
            }
            data-drop-blocked={
              dragOverZone === "disabled" && disabledDropBlocked
                ? "true"
                : undefined
            }
            data-testid="agent-gui-provider-manager-disabled-drop-zone"
            onDragOver={(event) => dragOverDropZone(event, "disabled")}
            onDrop={(event) => dropIntoZone(event, "disabled")}
            title={
              disabledDropBlocked
                ? disabledDropBlockedByRunning
                  ? labels.manageAgentsRunningBlocked(
                      targets.find(
                        (target) => target.targetId === dragState?.targetId
                      )?.label ?? ""
                    )
                  : labels.manageAgentsKeepOneAvailable
                : undefined
            }
          >
            <h3
              className="mb-3 text-[12px] font-medium text-[var(--text-secondary)]"
              id="agent-manager-disabled-heading"
            >
              {labels.manageAgentsDisabled}
            </h3>
            {disabledTargets.length > 0 ? (
              <div
                aria-label={labels.manageAgentsDisabled}
                className="grid grid-cols-5 gap-x-3 gap-y-4 rounded-[8px] border border-dashed border-[var(--border-1)] px-3 py-4"
                data-editing={editing ? "true" : "false"}
                onClick={exitEditingFromBlankSpace}
                role="list"
              >
                {disabledTargets.map((target) => {
                  const label = target.label.trim() || target.provider;
                  return (
                    <div
                      aria-label={labels.dragAgentToReorder(label)}
                      className="agent-gui-provider-manager-tile nodrag relative flex min-w-0 cursor-grab flex-col items-center rounded-[10px] px-2 py-1 outline-none transition-[background-color,opacity,box-shadow] focus-visible:ring-2 focus-visible:ring-[var(--border-focus)] active:cursor-grabbing [-webkit-app-region:no-drag]"
                      data-agent-target-id={target.targetId}
                      data-dragging={
                        dragState?.targetId === target.targetId
                          ? "true"
                          : undefined
                      }
                      data-drag-active={dragState ? "true" : undefined}
                      data-drag-over={
                        dragPreview?.overTargetId === target.targetId
                          ? dragPreview.position
                          : undefined
                      }
                      data-editing={editing ? "true" : "false"}
                      data-long-press={
                        longPressTargetId === target.targetId
                          ? "true"
                          : undefined
                      }
                      data-testid="agent-gui-provider-manager-disabled-tile"
                      draggable
                      key={target.targetId}
                      onAnimationEnd={(event) =>
                        finishLongPress(event, target.targetId)
                      }
                      onContextMenu={(event) => {
                        event.preventDefault();
                        setEditing(true);
                      }}
                      onDragEnd={clearDrag}
                      onDragOver={(event) =>
                        dragOverTarget(event, target, "disabled")
                      }
                      onDragStart={(event) =>
                        startDrag(event, target.targetId, "disabled")
                      }
                      onDrop={(event) =>
                        dropOnTarget(event, target, "disabled")
                      }
                      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          setEditing(true);
                        }
                      }}
                      onPointerCancel={cancelLongPress}
                      onPointerDown={(event) =>
                        beginLongPress(event, target.targetId)
                      }
                      onPointerLeave={cancelLongPress}
                      onPointerMove={moveLongPress}
                      onPointerUp={cancelLongPress}
                      role="listitem"
                      tabIndex={0}
                    >
                      {dragPreview?.overTargetId === target.targetId ? (
                        <span
                          aria-hidden="true"
                          className="agent-gui-provider-manager-drop-indicator"
                          data-position={dragPreview.position}
                          data-testid="agent-gui-provider-manager-drop-indicator"
                        />
                      ) : null}
                      {editing ? (
                        <Button
                          aria-label={labels.addAgentToSidebar(label)}
                          className="absolute right-0.5 top-0 z-10 size-5 rounded-full bg-[var(--background-panel)] p-0 text-[var(--state-success)] shadow-sm hover:bg-[var(--transparency-hover)] hover:text-[var(--state-success)]"
                          onClick={(event) => {
                            event.stopPropagation();
                            onVisibilityChange(target.targetId, true);
                          }}
                          size="icon-xs"
                          type="button"
                          variant="ghost"
                        >
                          <CirclePlus aria-hidden="true" className="size-4" />
                        </Button>
                      ) : null}
                      <AgentGUIProviderIconVisual
                        ariaHidden
                        icon={agentGUIProviderRailIconPresentation(
                          target.provider,
                          target.iconUrl
                        )}
                        imageClassName="size-9 shrink-0 rounded-[9px] object-cover opacity-70 grayscale-[0.25]"
                      />
                      <span className="mt-2 block w-full truncate text-center text-[12px] font-medium text-[var(--text-secondary)]">
                        {label}
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="flex min-h-[72px] items-center justify-center rounded-[8px] border border-dashed border-[var(--border-1)] px-3 py-4 text-center text-[12px] text-[var(--text-tertiary)]">
                {labels.manageAgentsNoDisabled}
              </p>
            )}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
