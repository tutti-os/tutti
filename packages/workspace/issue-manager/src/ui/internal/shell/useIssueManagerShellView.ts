import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent
} from "react";
import type {
  IssueManagerIssueSummary,
  IssueManagerTaskSummary
} from "../../../contracts/index.ts";
import {
  clampIssueManagerSidebarWidth,
  issueManagerSidebarDefaultWidth,
  issueManagerSidebarMaxWidth,
  issueManagerSidebarMinWidth,
  shouldAutoCollapseIssueManagerSidebar
} from "../../../core/index.ts";
import type { IssueManagerController } from "../../react/index.ts";
import {
  resolveIssueManagerShellContentViewState,
  resolveIssueManagerStatusCounts,
  resolveIssueManagerSidebarViewState
} from "./IssueManagerShellState.ts";
import { logIssueManagerDiagnostic } from "../../../internal/issueManagerDiagnostics.ts";

interface SidebarResizeState {
  maxWidth: number;
  pointerId: number;
  startClientX: number;
  startWidth: number;
}

interface ShellContentDiagnosticSnapshot {
  isIssueEditing: boolean;
  isTaskCreating: boolean;
  isTaskDrawerOpen: boolean;
  issueEditorMode: string;
  selectedIssueId: string | null;
  selectedTaskId: string | null;
  selectedTaskPresent: boolean;
  taskEditorMode: string;
}

export interface UseIssueManagerShellViewInput {
  controller: IssueManagerController;
  selectedIssue: IssueManagerIssueSummary | null;
  selectedTask: IssueManagerTaskSummary | null;
}

export function useIssueManagerShellView({
  controller,
  selectedIssue,
  selectedTask
}: UseIssueManagerShellViewInput) {
  const layoutRef = useRef<HTMLDivElement | null>(null);
  const resizeRef = useRef<SidebarResizeState | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(
    issueManagerSidebarDefaultWidth
  );
  const [isNarrowLayout, setIsNarrowLayout] = useState(false);
  const dismissNotification = useEffectEvent(() => {
    controller.dismissNotification();
  });
  const floatingNotice = controller.floatingNotice;
  const lastContentDiagnosticRef =
    useRef<ShellContentDiagnosticSnapshot | null>(null);

  useEffect(() => {
    const publishLayout = () => {
      const width = layoutRef.current?.getBoundingClientRect().width ?? 0;
      if (!width) {
        return;
      }
      setSidebarWidth((current) =>
        clampIssueManagerSidebarWidth(current, width)
      );
      setIsNarrowLayout(shouldAutoCollapseIssueManagerSidebar(width));
    };

    const layout = layoutRef.current;
    const observer =
      layout && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(publishLayout)
        : null;
    publishLayout();
    if (observer && layout) {
      observer.observe(layout);
    }
    window.addEventListener("resize", publishLayout);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", publishLayout);
    };
  }, []);

  useEffect(() => {
    if (!floatingNotice) {
      return undefined;
    }

    const timeout = window.setTimeout(() => {
      dismissNotification();
    }, floatingNotice.durationMs);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [dismissNotification, floatingNotice]);

  const content = resolveIssueManagerShellContentViewState({
    issueEditorMode: controller.issueEditorMode,
    selectedIssue,
    selectedTaskPresent: selectedTask !== null,
    taskEditorMode: controller.taskEditorMode
  });
  useEffect(() => {
    const nextDiagnostic: ShellContentDiagnosticSnapshot = {
      isIssueEditing: content.isIssueEditing,
      isTaskCreating: content.isTaskCreating,
      isTaskDrawerOpen: content.isTaskDrawerOpen,
      issueEditorMode: controller.issueEditorMode,
      selectedIssueId: controller.nodeState.selectedIssueId,
      selectedTaskId: controller.nodeState.selectedTaskId,
      selectedTaskPresent: selectedTask !== null,
      taskEditorMode: controller.taskEditorMode
    };
    const previousDiagnostic = lastContentDiagnosticRef.current;
    if (
      previousDiagnostic &&
      previousDiagnostic.isIssueEditing === nextDiagnostic.isIssueEditing &&
      previousDiagnostic.isTaskCreating === nextDiagnostic.isTaskCreating &&
      previousDiagnostic.isTaskDrawerOpen === nextDiagnostic.isTaskDrawerOpen &&
      previousDiagnostic.issueEditorMode === nextDiagnostic.issueEditorMode &&
      previousDiagnostic.selectedIssueId === nextDiagnostic.selectedIssueId &&
      previousDiagnostic.selectedTaskId === nextDiagnostic.selectedTaskId &&
      previousDiagnostic.selectedTaskPresent ===
        nextDiagnostic.selectedTaskPresent &&
      previousDiagnostic.taskEditorMode === nextDiagnostic.taskEditorMode
    ) {
      return;
    }
    lastContentDiagnosticRef.current = nextDiagnostic;
    logIssueManagerDiagnostic(controller.diagnostics, "shell_content.derived", {
      isIssueEditing: content.isIssueEditing,
      isTaskCreating: content.isTaskCreating,
      isTaskDrawerOpen: content.isTaskDrawerOpen,
      issueEditorMode: controller.issueEditorMode,
      previousIsTaskDrawerOpen: previousDiagnostic?.isTaskDrawerOpen ?? null,
      previousSelectedTaskId: previousDiagnostic?.selectedTaskId ?? null,
      previousTaskEditorMode: previousDiagnostic?.taskEditorMode ?? null,
      selectedIssueId: controller.nodeState.selectedIssueId,
      selectedTaskId: controller.nodeState.selectedTaskId,
      selectedTaskPresent: selectedTask !== null,
      showBottomBar: content.showBottomBar,
      taskEditorMode: controller.taskEditorMode
    });
  }, [
    content.isIssueEditing,
    content.isTaskCreating,
    content.isTaskDrawerOpen,
    content.showBottomBar,
    controller.diagnostics,
    controller.issueEditorMode,
    controller.nodeState.selectedIssueId,
    controller.nodeState.selectedTaskId,
    controller.taskEditorMode,
    selectedTask
  ]);
  const sidebarViewState = resolveIssueManagerSidebarViewState({
    copy: controller.copy,
    issues: controller.issues
  });
  const statusCounts = resolveIssueManagerStatusCounts(controller.issues);
  const isSidebarAutoCollapsed = isNarrowLayout;
  const isSidebarCollapsed =
    controller.nodeState.taskListCollapsed === true || isSidebarAutoCollapsed;

  useEffect(() => {
    const workbenchWindow =
      layoutRef.current?.closest<HTMLElement>(".workbench-window") ?? null;
    if (!workbenchWindow) {
      return undefined;
    }

    workbenchWindow.style.setProperty(
      "--issue-manager-sidebar-width",
      `${sidebarWidth}px`
    );
    workbenchWindow.dataset.issueManagerSidebarCollapsed = isSidebarCollapsed
      ? "true"
      : "false";

    return () => {
      workbenchWindow.style.removeProperty("--issue-manager-sidebar-width");
      delete workbenchWindow.dataset.issueManagerSidebarCollapsed;
    };
  }, [isSidebarCollapsed, sidebarWidth]);

  return {
    content,
    floatingNotice,
    isNarrowLayout,
    layoutRef,
    layoutStyle: {
      gridTemplateColumns: isSidebarCollapsed
        ? "0 minmax(0, 1fr)"
        : "var(--issue-manager-sidebar-width) minmax(0, 1fr)",
      "--issue-manager-sidebar-width": `${sidebarWidth}px`
    } as CSSProperties,
    resizeHandle: {
      ariaValueMax: issueManagerSidebarMaxWidth,
      ariaValueMin: issueManagerSidebarMinWidth,
      ariaValueNow: sidebarWidth,
      onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
          return;
        }
        const delta = event.key === "ArrowRight" ? 16 : -16;
        const layoutWidth =
          layoutRef.current?.getBoundingClientRect().width ?? 0;
        if (!layoutWidth) {
          return;
        }
        event.preventDefault();
        setSidebarWidth((current) =>
          clampIssueManagerSidebarWidth(current + delta, layoutWidth)
        );
      },
      onPointerCancel: (event: PointerEvent<HTMLDivElement>) => {
        resizeRef.current = null;
        event.currentTarget.releasePointerCapture?.(event.pointerId);
      },
      onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0) {
          return;
        }
        const layoutWidth =
          layoutRef.current?.getBoundingClientRect().width ?? 0;
        if (!layoutWidth) {
          return;
        }
        const startWidth = clampIssueManagerSidebarWidth(
          sidebarWidth,
          layoutWidth
        );
        resizeRef.current = {
          maxWidth: clampIssueManagerSidebarWidth(
            issueManagerSidebarMaxWidth,
            layoutWidth
          ),
          pointerId: event.pointerId,
          startClientX: event.clientX,
          startWidth
        };
        setSidebarWidth(startWidth);
        event.currentTarget.setPointerCapture?.(event.pointerId);
      },
      onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
        const state = resizeRef.current;
        if (!state || state.pointerId !== event.pointerId) {
          return;
        }
        setSidebarWidth(
          Math.min(
            Math.max(
              state.startWidth + event.clientX - state.startClientX,
              issueManagerSidebarMinWidth
            ),
            state.maxWidth
          )
        );
      },
      onPointerUp: (event: PointerEvent<HTMLDivElement>) => {
        resizeRef.current = null;
        event.currentTarget.releasePointerCapture?.(event.pointerId);
      }
    },
    sidebar: {
      isAutoCollapsed: isSidebarAutoCollapsed,
      isCollapsed: isSidebarCollapsed,
      showStandaloneState:
        !isNarrowLayout &&
        (sidebarViewState.kind === "empty" ||
          sidebarViewState.kind === "error"),
      statusCounts,
      viewState: sidebarViewState
    }
  };
}

export { shouldAutoCollapseIssueManagerSidebar } from "../../../core/index.ts";
