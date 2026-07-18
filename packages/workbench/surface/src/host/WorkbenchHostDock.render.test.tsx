import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { WorkbenchState } from "../core/types.ts";
import type { WorkbenchDockContext } from "../react/types.ts";
import type { WorkbenchController } from "../store/types.ts";
import { WorkbenchHostDock } from "./WorkbenchHostDock.tsx";
import { WorkbenchSurface } from "../react/WorkbenchSurface.tsx";
import { createWorkbenchController } from "../store/createWorkbenchController.ts";
import type { WorkbenchHostHandle, WorkbenchHostNodeData } from "./types.ts";
import { createWorkbenchHostI18nRuntime } from "./workbenchHostI18n.ts";

describe("WorkbenchHostDock", () => {
  it("preserves hook order while dock entries appear and disappear", async () => {
    const props = createDockProps();
    const dockEntry = {
      icon: null,
      id: "agent-gui",
      label: "Agent",
      typeId: "agent-gui",
      visibility: "always" as const
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const previousActEnvironment = (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT;
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;

    try {
      await act(async () => {
        root.render(<WorkbenchHostDock {...props} dockEntries={[]} />);
      });
      expect(container.querySelector('[role="toolbar"]')).toBeNull();

      await act(async () => {
        root.render(<WorkbenchHostDock {...props} dockEntries={[dockEntry]} />);
      });
      expect(container.querySelector('[role="toolbar"]')).not.toBeNull();

      await act(async () => {
        root.render(<WorkbenchHostDock {...props} dockEntries={[]} />);
      });
      expect(container.querySelector('[role="toolbar"]')).toBeNull();
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
      (
        globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
      ).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    }
  });

  it("renders independent handles for collapsed top chrome and Dock", async () => {
    vi.useFakeTimers();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const controller = createWorkbenchController();
    const previousActEnvironment = (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT;
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;

    try {
      await act(async () => {
        root.render(
          <WorkbenchSurface
            autoHideChrome={{
              collapseDelayMs: 0,
              dockHandleLabel: "Show Dock",
              topHandleLabel: "Show app bar"
            }}
            controller={controller}
            renderDock={() => <button type="button">Dock item</button>}
            renderNode={() => null}
            renderTopChrome={() => <button type="button">App action</button>}
          />
        );
      });

      const topChrome = container.querySelector(
        ".workbench-surface__top-chrome"
      );
      const dock = container.querySelector(".workbench-dock-frame");
      expect(topChrome?.getAttribute("data-auto-hide-state")).toBe("hidden");
      expect(dock?.getAttribute("data-auto-hide-state")).toBe("hidden");

      const topHandle = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Show app bar"]'
      );
      const dockHandle = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Show Dock"]'
      );
      expect(topHandle).not.toBeNull();
      expect(dockHandle).not.toBeNull();

      await act(async () => {
        topHandle?.click();
        dockHandle?.click();
      });

      expect(topChrome?.getAttribute("data-auto-hide-state")).toBe("expanded");
      expect(dock?.getAttribute("data-auto-hide-state")).toBe("expanded");
      expect(
        container.querySelector('button[aria-label="Show app bar"]')
      ).toBeNull();
      expect(
        container.querySelector('button[aria-label="Show Dock"]')
      ).toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_600);
      });

      expect(topChrome?.getAttribute("data-auto-hide-state")).toBe("hidden");
      expect(dock?.getAttribute("data-auto-hide-state")).toBe("hidden");
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
      (
        globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
      ).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
      vi.useRealTimers();
    }
  });
});

function createDockProps() {
  const state: WorkbenchState<WorkbenchHostNodeData> = {
    activeDragNodeId: null,
    activeResizeNodeId: null,
    activeSnapTarget: null,
    layoutConstraints: {
      minHeight: 160,
      minWidth: 280,
      safeArea: { bottom: 0, left: 0, right: 0, top: 0 },
      surfacePadding: 0
    },
    lockedLayout: null,
    nodes: [],
    nodeStack: [],
    surfaceSize: { height: 800, width: 1200 }
  };
  const controller: WorkbenchController<WorkbenchHostNodeData> = {
    commands: {} as WorkbenchController<WorkbenchHostNodeData>["commands"],
    dispatch() {},
    getSnapshot: () => state,
    subscribe: () => () => {}
  };
  const context: WorkbenchDockContext<WorkbenchHostNodeData> = {
    controller,
    focusedNodeId: null,
    genie: {
      isPendingMinimizedDockNode: () => false,
      launchNodeFromAnchor(_anchorKey, _nodeId, launch) {
        void launch();
      },
      registerDockAnchor() {},
      shouldAnimateMinimizedDockEnter: () => false
    },
    minimizedNodes: [],
    nodes: []
  };
  const host: WorkbenchHostHandle = {
    activateNode() {},
    closeNode() {},
    collectWindowCloseEffects: async () => [],
    dispose() {},
    exitFullscreenNode() {},
    focusNode() {},
    getSnapshot: () => state,
    launchNode: async () => null,
    load: async () => {},
    minimizeNode() {},
    reconcileProjectedNodes() {},
    requestNodeClose() {},
    setNodeRuntimeState() {},
    setNodeSizeConstraints() {},
    setNodeTitle() {},
    setSnapshotNodeState() {}
  };

  return {
    context,
    host,
    i18n: createWorkbenchHostI18nRuntime(undefined),
    nodeDefinitions: new Map(),
    workspaceId: "workspace-hook-order"
  };
}
