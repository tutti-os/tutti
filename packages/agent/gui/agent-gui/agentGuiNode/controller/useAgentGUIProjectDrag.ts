import { useCallback, useState, type RefObject } from "react";
import type { WorkspaceUserProject } from "@tutti-os/workspace-user-project";
import type { ConversationSection } from "../agentGuiNodeViewConversation";
import styles from "../AgentGUINode.styles";

const PROJECT_DRAG_SCROLL_EDGE_PX = 40;

export function projectDragAutoScrollDelta(
  clientY: number,
  bounds: Pick<DOMRect, "bottom" | "top">
): number {
  if (clientY < bounds.top + PROJECT_DRAG_SCROLL_EDGE_PX) {
    return -Math.max(
      2,
      ((bounds.top + PROJECT_DRAG_SCROLL_EDGE_PX - clientY) /
        PROJECT_DRAG_SCROLL_EDGE_PX) *
        14
    );
  }
  if (clientY > bounds.bottom - PROJECT_DRAG_SCROLL_EDGE_PX) {
    return Math.max(
      2,
      ((clientY - (bounds.bottom - PROJECT_DRAG_SCROLL_EDGE_PX)) /
        PROJECT_DRAG_SCROLL_EDGE_PX) *
        14
    );
  }
  return 0;
}

interface ProjectDragState {
  beforeProjectId: string | null;
  canDrop: boolean;
  indicator: "before" | "after" | null;
  indicatorSectionId: string | null;
  projectId: string;
  projectPinned: boolean;
}

interface ProjectDragRuntime {
  active: boolean;
  clientY: number | null;
  dragState: ProjectDragState | null;
  frame: number | null;
  image: HTMLElement | null;
  viewport: HTMLElement | null;
}

export function useAgentGUIProjectDrag(input: {
  disabled: boolean;
  onMoveProject: (
    projectId: string,
    beforeProjectId: string | null
  ) => Promise<void>;
  scrollViewportRef: RefObject<HTMLDivElement | null>;
  userProjects: readonly WorkspaceUserProject[];
}) {
  const [dragState, setDragState] = useState<ProjectDragState | null>(null);
  const [isMovePending, setIsMovePending] = useState(false);
  const [runtime] = useState<ProjectDragRuntime>(() => ({
    active: false,
    clientY: null,
    dragState: null,
    frame: null,
    image: null,
    viewport: null
  }));

  const stopAutoScroll = useCallback(() => {
    if (runtime.frame !== null) {
      window.cancelAnimationFrame(runtime.frame);
      runtime.frame = null;
    }
    runtime.clientY = null;
  }, [runtime]);

  const clear = useCallback(() => {
    stopAutoScroll();
    runtime.image?.remove();
    runtime.image = null;
    runtime.active = false;
    runtime.dragState = null;
    runtime.viewport = null;
    setDragState(null);
  }, [runtime, stopAutoScroll]);

  const runAutoScroll = useCallback(() => {
    runtime.frame = null;
    const viewport = runtime.viewport ?? input.scrollViewportRef.current;
    if (!runtime.active || !viewport || runtime.clientY === null) return;
    const rect = viewport.getBoundingClientRect();
    const delta = projectDragAutoScrollDelta(runtime.clientY, rect);
    if (delta !== 0) {
      viewport.scrollTop += delta;
      runtime.frame = window.requestAnimationFrame(runAutoScroll);
    }
  }, [input.scrollViewportRef, runtime]);

  const trackPosition = useCallback(
    (clientY: number) => {
      if (!runtime.active) return;
      runtime.clientY = clientY;
      if (runtime.frame === null) {
        runtime.frame = window.requestAnimationFrame(runAutoScroll);
      }
    },
    [runAutoScroll, runtime]
  );

  const start = useCallback(
    (section: ConversationSection, event: React.DragEvent<HTMLElement>) => {
      const projectId = section.project?.id?.trim() ?? "";
      if (input.disabled || isMovePending || !projectId) {
        event.preventDefault();
        return;
      }
      if (
        event.target instanceof Element &&
        event.target.closest("[data-project-drag-block]")
      ) {
        event.preventDefault();
        return;
      }
      runtime.active = true;
      runtime.viewport =
        event.currentTarget
          .closest("aside")
          ?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]') ??
        null;
      const nextDragState: ProjectDragState = {
        beforeProjectId: projectId,
        canDrop: false,
        indicator: null,
        indicatorSectionId: null,
        projectId,
        projectPinned: (section.project?.pinnedAtUnixMs ?? 0) > 0
      };
      runtime.dragState = nextDragState;
      setDragState(nextDragState);
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", projectId);
      const image = document.createElement("div");
      image.className = styles.projectDragImage;
      const sourceIcon = event.currentTarget.querySelector(
        "[data-project-drag-icon]"
      );
      const icon = sourceIcon?.cloneNode(true);
      const label = document.createElement("span");
      label.textContent = section.label;
      if (icon instanceof SVGElement) image.append(icon);
      image.append(label);
      document.body.append(image);
      runtime.image = image;
      event.dataTransfer.setDragImage(image, 16, 16);
    },
    [input.disabled, isMovePending, runtime]
  );

  const updateTarget = useCallback(
    (
      section: ConversationSection,
      edge: "before" | "after",
      event: React.DragEvent<HTMLElement>
    ) => {
      const targetId = section.project?.id?.trim() ?? "";
      const currentDragState = runtime.dragState;
      if (!runtime.active || !currentDragState || !targetId) return;
      const targetPinned = (section.project?.pinnedAtUnixMs ?? 0) > 0;
      if (targetPinned !== currentDragState.projectPinned) {
        event.dataTransfer.dropEffect = "none";
        const nextDragState: ProjectDragState = {
          ...currentDragState,
          beforeProjectId: null,
          canDrop: false,
          indicator: null,
          indicatorSectionId: null
        };
        runtime.dragState = nextDragState;
        setDragState(nextDragState);
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      const partitionProjects = input.userProjects.filter(
        (project) =>
          (project.pinnedAtUnixMs ?? 0) > 0 === currentDragState.projectPinned
      );
      const targetIndex = partitionProjects.findIndex(
        (project) => project.id === targetId
      );
      const nextDragState: ProjectDragState = {
        ...currentDragState,
        canDrop: true,
        beforeProjectId:
          edge === "before"
            ? targetId
            : (partitionProjects[targetIndex + 1]?.id ?? null),
        indicator: edge,
        indicatorSectionId: section.id
      };
      runtime.dragState = nextDragState;
      setDragState(nextDragState);
      trackPosition(event.clientY);
    },
    [input.userProjects, runtime, trackPosition]
  );

  const drop = useCallback(
    async (event: React.DragEvent<HTMLElement>) => {
      const currentDragState = runtime.dragState;
      if (!currentDragState || !runtime.active) return;
      if (!currentDragState.canDrop) {
        clear();
        return;
      }
      event.preventDefault();
      const { beforeProjectId, projectId } = currentDragState;
      clear();
      setIsMovePending(true);
      try {
        await input.onMoveProject(projectId, beforeProjectId);
      } finally {
        setIsMovePending(false);
      }
    },
    [clear, input.onMoveProject, runtime]
  );

  const installGlobalListeners = useCallback(() => {
    const clearOnGlobalEnd = () => clear();
    const trackGlobalPosition = (event: DragEvent) =>
      trackPosition(event.clientY);
    document.addEventListener("dragend", clearOnGlobalEnd, true);
    document.addEventListener("drop", clearOnGlobalEnd);
    document.addEventListener("dragover", trackGlobalPosition);
    return () => {
      document.removeEventListener("dragend", clearOnGlobalEnd, true);
      document.removeEventListener("drop", clearOnGlobalEnd);
      document.removeEventListener("dragover", trackGlobalPosition);
      clear();
    };
  }, [clear, trackPosition]);

  return {
    clear,
    dragState,
    drop,
    installGlobalListeners,
    isMovePending,
    start,
    updateTarget
  };
}
