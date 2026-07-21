import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { WorkbenchNode, WorkbenchState } from "../core/types.ts";
import type { WorkbenchDockContext } from "../react/types.ts";
import type { WorkbenchController } from "../store/types.ts";
import { WorkbenchHostDock } from "./WorkbenchHostDock.tsx";
import type {
  WorkbenchHostDockPopupPreviewProvider,
  WorkbenchHostHandle,
  WorkbenchHostNodeData
} from "./types.ts";
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

  it("provides the dock popup preview viewport to component preview providers", async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        disconnect() {}
        observe() {}
        unobserve() {}
      }
    );
    const node = createNode();
    const props = createDockProps([node]);
    const providePopupItemPreview =
      vi.fn<WorkbenchHostDockPopupPreviewProvider>(() => ({
        element: null,
        kind: "component"
      }));
    const dockEntry = {
      icon: null,
      id: "agent-gui",
      instanceMode: "multi" as const,
      label: "Agent",
      providePopupItemPreview,
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
        root.render(<WorkbenchHostDock {...props} dockEntries={[dockEntry]} />);
      });
      const button = container.querySelector<HTMLButtonElement>(
        'button[aria-haspopup="dialog"]'
      );
      expect(button).not.toBeNull();

      providePopupItemPreview.mockClear();
      await act(async () => {
        button?.click();
      });

      expect(providePopupItemPreview.mock.calls.length).toBeGreaterThan(0);
      for (const call of providePopupItemPreview.mock.calls) {
        expect(call[0]?.previewViewport).toEqual({
          height: 95,
          width: 157
        });
      }
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
      (
        globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
      ).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
      vi.unstubAllGlobals();
    }
  });
});

function createNode(): WorkbenchNode<WorkbenchHostNodeData> {
  return {
    data: {
      dockEntryId: "agent-gui",
      instanceId: "agent-gui-1",
      instanceKey: null,
      typeId: "agent-gui"
    },
    displayMode: "floating",
    frame: { height: 560, width: 1040, x: 20, y: 20 },
    id: "agent-gui:agent-gui-1",
    isMinimized: false,
    kind: "agent-gui",
    restoreFrame: null,
    title: "Agent"
  };
}

function createDockProps(
  nodes: readonly WorkbenchNode<WorkbenchHostNodeData>[] = []
) {
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
    nodes: [...nodes],
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
    nodes: [...nodes]
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
