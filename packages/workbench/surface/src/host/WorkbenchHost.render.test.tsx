import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { WorkbenchSnapshot } from "@tutti-os/workbench-snapshot";
import { selectWorkbenchNodeIsVisuallyExposed } from "../core/visualOcclusion.ts";
import type { WorkbenchNode } from "../core/types.ts";
import { useWorkbenchSelector } from "../react/hooks/useWorkbenchSelector.ts";
import { WorkbenchNodeLayer } from "../react/WorkbenchNodeLayer.tsx";
import { WorkbenchProvider } from "../react/WorkbenchProvider.tsx";
import {
  useWorkbenchVisualOcclusionPresentation,
  useWorkbenchWindowPresentationVisibility,
  WorkbenchWindowFrame
} from "../react/WorkbenchWindowFrame.tsx";
import { createWorkbenchGenieNodeVisibilityStore } from "../react/genieNodeVisibility.ts";
import {
  createWorkbenchNodePresentationTransitionStore,
  type WorkbenchNodePresentationTransitionStore
} from "../react/nodePresentationTransitions.ts";
import {
  useWorkbenchGenieAnimation,
  type WorkbenchGenieController
} from "../react/useWorkbenchGenieAnimation.tsx";
import { createWorkbenchController } from "../store/createWorkbenchController.ts";
import type {
  WorkbenchController,
  WorkbenchDebugDiagnostics
} from "../store/types.ts";
import { WorkbenchHost } from "./WorkbenchHost.tsx";
import type {
  WorkbenchContribution,
  WorkbenchHostDockEntryPresentationOverrides,
  WorkbenchHostHandle,
  WorkbenchHostNodeDefinition,
  WorkbenchHostRuntimeHandle,
  WorkbenchHostSnapshotRepository
} from "./types.ts";

function WorkbenchGenieIdentityProbe({
  controller,
  debugDiagnostics,
  minimizeAnimation,
  nodePresentationTransitions,
  onRender
}: {
  controller: WorkbenchController;
  debugDiagnostics?: WorkbenchDebugDiagnostics;
  minimizeAnimation?: "genie" | "off" | "scale";
  nodePresentationTransitions: WorkbenchNodePresentationTransitionStore;
  onRender: (genie: WorkbenchGenieController) => void;
}) {
  const genie = useWorkbenchGenieAnimation({
    controller,
    debugDiagnostics,
    minimizeAnimation,
    nodePresentationTransitions
  });
  onRender(genie);
  return <>{genie.genieLayer}</>;
}

function WorkbenchWindowVisibilityProbe({
  onRender
}: {
  onRender: (isVisible: boolean) => void;
}) {
  onRender(useWorkbenchWindowPresentationVisibility());
  return null;
}

function WorkbenchVisualExposureProbe({
  nodeID,
  onRender
}: {
  nodeID: string;
  onRender: (isVisible: boolean) => void;
}) {
  const visualOcclusionPresentation = useWorkbenchVisualOcclusionPresentation();
  onRender(
    useWorkbenchSelector((state) =>
      selectWorkbenchNodeIsVisuallyExposed(
        state,
        nodeID,
        visualOcclusionPresentation
      )
    )
  );
  return null;
}

function createTestGenieController(
  nodeVisibility: ReturnType<typeof createWorkbenchGenieNodeVisibilityStore>
): WorkbenchGenieController {
  return {
    genieLayer: null,
    isPendingMinimizedDockNode: () => false,
    launchNodeFromAnchor: () => {},
    minimizeNodeToAnchor: () => {},
    nodeVisibility,
    pendingMinimizedNode: null,
    registerDockAnchor: () => {},
    shouldAnimateMinimizedDockEnter: () => false
  };
}

describe("WorkbenchHost", () => {
  it("keeps the host session when Dock presentation overrides change identity", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const onHandleReady = vi.fn<(handle: WorkbenchHostHandle | null) => void>();
    const contribution: WorkbenchContribution = {
      dockEntries: [
        {
          icon: null,
          id: "browser",
          label: "Browser",
          typeId: "browser"
        }
      ],
      id: "browser"
    };
    const contributions = [contribution];
    const snapshotRepository: WorkbenchHostSnapshotRepository = {
      async load() {
        return null;
      },
      save(_workspaceId: string, snapshot: WorkbenchSnapshot) {
        return snapshot;
      }
    };
    const firstOverrides: WorkbenchHostDockEntryPresentationOverrides = {
      browser: { visibility: "always" }
    };
    const secondOverrides: WorkbenchHostDockEntryPresentationOverrides = {
      browser: {
        dockRetention: {
          actionId: "workspace-dock-retention:browser",
          retained: false
        },
        visibility: "when-open"
      }
    };
    const previousActEnvironment = (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT;
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;

    try {
      await act(async () => {
        root.render(
          <WorkbenchHost
            contributions={contributions}
            dockEntryPresentationOverrides={firstOverrides}
            onHandleReady={onHandleReady}
            snapshotRepository={snapshotRepository}
            workspaceId="workspace-1"
          />
        );
      });
      const firstHandle = onHandleReady.mock.calls[0]?.[0];
      expect(firstHandle).toBeTruthy();
      expect(onHandleReady).toHaveBeenCalledTimes(1);

      await act(async () => {
        root.render(
          <WorkbenchHost
            contributions={contributions}
            dockEntryPresentationOverrides={secondOverrides}
            onHandleReady={onHandleReady}
            snapshotRepository={snapshotRepository}
            workspaceId="workspace-1"
          />
        );
      });

      expect(onHandleReady).toHaveBeenCalledTimes(1);
      expect(onHandleReady.mock.calls[0]?.[0]).toBe(firstHandle);
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

  it("refreshes only the node subscribed to external state", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const listenersByTypeId = new Map<string, Set<() => void>>();
    const nodeStateByTypeId = new Map<string, { value: string }>([
      ["node-a", { value: "A" }],
      ["node-b", { value: "B" }]
    ]);
    const renderA = vi.fn();
    const renderB = vi.fn();
    const previousActEnvironment = (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT;
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;

    try {
      await act(async () => {
        root.render(
          <WorkbenchHost
            externalStateSource={{
              getNodeState(input) {
                return nodeStateByTypeId.get(input.typeId) ?? null;
              },
              getWorkspaceState() {
                return null;
              },
              subscribeNodeState(input, listener) {
                const listeners =
                  listenersByTypeId.get(input.typeId) ?? new Set<() => void>();
                listeners.add(listener);
                listenersByTypeId.set(input.typeId, listeners);
                return () => listeners.delete(listener);
              }
            }}
            nodes={[
              {
                frame: { x: 0, y: 0, width: 320, height: 240 },
                renderBody: (context) => {
                  renderA(context.externalNodeState);
                  return null;
                },
                title: "A",
                typeId: "node-a",
                window: { defaultOpen: true }
              },
              {
                frame: { x: 20, y: 20, width: 320, height: 240 },
                renderBody: (context) => {
                  renderB(context.externalNodeState);
                  return null;
                },
                title: "B",
                typeId: "node-b",
                window: { defaultOpen: true }
              }
            ]}
            snapshotRepository={createSnapshotRepository()}
            workspaceId="workspace-1"
          />
        );
      });

      const rendersBeforeNodeBChange = renderA.mock.calls.length;
      nodeStateByTypeId.set("node-b", { value: "B2" });
      await act(async () => {
        for (const listener of listenersByTypeId.get("node-b") ?? []) {
          listener();
        }
      });

      expect(renderA).toHaveBeenCalledTimes(rendersBeforeNodeBChange);
      expect(renderB).toHaveBeenLastCalledWith({ value: "B2" });
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

  it("skips position-only body renders while keeping size renders live", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const renderBody = vi.fn((context) => (
      <div
        data-body-frame={`${context.node.frame.x}:${context.node.frame.width}`}
      />
    ));
    const onHandleReady = vi.fn<(handle: WorkbenchHostHandle | null) => void>();
    const bodyDefinition: WorkbenchHostNodeDefinition = {
      frame: { x: 0, y: 0, width: 320, height: 240 },
      renderBody,
      title: "Body",
      typeId: "body",
      window: { defaultOpen: true }
    };
    const previousActEnvironment = (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT;
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;

    try {
      await act(async () => {
        root.render(
          <WorkbenchHost
            nodes={[bodyDefinition]}
            onHandleReady={onHandleReady}
            snapshotRepository={createSnapshotRepository()}
            workspaceId="workspace-1"
          />
        );
      });

      const host = onHandleReady.mock
        .calls[0]?.[0] as WorkbenchHostRuntimeHandle | null;
      const nodeId = host
        ?.getSnapshot()
        .nodes.find((node) => node.data.typeId === "body")?.id;
      expect(nodeId).toBeTruthy();

      await act(async () => {
        host?.controller.commands.setSurfaceSize({ width: 1200, height: 800 });
        host?.controller.commands.focusNode(nodeId ?? "");
        host?.controller.commands.setActiveDragNode(nodeId ?? null);
      });
      const rendersAtDragStart = renderBody.mock.calls.length;
      const frameAtDragStart = host
        ?.getSnapshot()
        .nodes.find((node) => node.id === nodeId)?.frame;
      if (!frameAtDragStart) {
        throw new Error("Expected a body frame");
      }

      await act(async () => {
        host?.controller.commands.dragNode(nodeId ?? "", {
          ...frameAtDragStart,
          x: 20,
          y: 60
        });
      });
      await act(async () => {
        host?.controller.commands.dragNode(nodeId ?? "", {
          ...frameAtDragStart,
          x: 40,
          y: 80
        });
      });

      expect(renderBody).toHaveBeenCalledTimes(rendersAtDragStart);

      await act(async () => {
        host?.setNodeRuntimeState(nodeId ?? "", {
          revision: 1
        });
      });
      expect(renderBody).toHaveBeenCalledTimes(rendersAtDragStart + 1);

      await act(async () => {
        host?.controller.commands.setActiveDragNode(null);
      });
      expect(renderBody).toHaveBeenCalledTimes(rendersAtDragStart + 2);
      expect(renderBody.mock.lastCall?.[0].node.frame.x).toBe(40);
      expect(
        container.querySelector(
          `[data-body-frame='40:${frameAtDragStart.width}']`
        )
      ).not.toBeNull();

      const rendersAtRest = renderBody.mock.calls.length;
      await act(async () => {
        host?.controller.commands.dragNode(nodeId ?? "", {
          ...frameAtDragStart,
          x: 60,
          y: 100
        });
      });
      expect(renderBody).toHaveBeenCalledTimes(rendersAtRest + 1);

      await act(async () => {
        host?.controller.commands.setActiveResizeNode(nodeId ?? null);
      });
      const rendersAtResizeStart = renderBody.mock.calls.length;
      await act(async () => {
        host?.controller.commands.resizeNode(nodeId ?? "", {
          ...frameAtDragStart,
          x: 40,
          y: 80,
          width: frameAtDragStart.width + 80,
          height: frameAtDragStart.height + 20
        });
      });
      expect(renderBody).toHaveBeenCalledTimes(rendersAtResizeStart + 1);
      await act(async () => {
        host?.controller.commands.setActiveResizeNode(null);
      });
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

  it("positions windows with translate while preserving presentation transforms", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const node: WorkbenchNode = {
      data: null,
      displayMode: "floating",
      frame: { x: 80, y: 60, width: 320, height: 240 },
      id: "node-1",
      isMinimized: false,
      kind: "test",
      restoreFrame: null,
      title: "Test"
    };
    const controller = createWorkbenchController({
      nodes: [node],
      nodeStack: [node.id]
    });
    const nodeVisibility = createWorkbenchGenieNodeVisibilityStore();
    const nodePresentationTransitions =
      createWorkbenchNodePresentationTransitionStore();
    const minimizeNodeToAnchor = vi.fn();
    const previousActEnvironment = (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT;
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;

    try {
      await act(async () => {
        root.render(
          <WorkbenchProvider controller={controller}>
            <WorkbenchWindowFrame
              genieNodeVisibility={nodeVisibility}
              minimizeNodeToAnchor={minimizeNodeToAnchor}
              node={node}
              nodePresentationTransitions={nodePresentationTransitions}
            >
              <div />
            </WorkbenchWindowFrame>
          </WorkbenchProvider>
        );
      });

      const shell = container.querySelector(
        ".workbench-window-shell"
      ) as HTMLElement | null;
      expect(shell?.style.left).toBe("0px");
      expect(shell?.style.top).toBe("0px");
      expect(shell?.style.translate).toBe("80px 60px");
      expect(shell?.style.transform).toBe("");
      expect(shell?.getAttribute("data-viewport-menu-portal-target")).toBe(
        "body"
      );

      await act(async () => {
        root.render(
          <WorkbenchProvider controller={controller}>
            <WorkbenchWindowFrame
              genieNodeVisibility={nodeVisibility}
              minimizeNodeToAnchor={minimizeNodeToAnchor}
              node={node}
              nodePresentationTransitions={nodePresentationTransitions}
              presentation={{
                frameByNodeId: new Map([
                  [node.id, { x: 200, y: 160, width: 160, height: 120 }]
                ]),
                mode: "mission-control",
                visibleNodeIds: new Set([node.id])
              }}
            >
              <div />
            </WorkbenchWindowFrame>
          </WorkbenchProvider>
        );
      });

      expect(shell?.style.translate).toBe("80px 60px");
      expect(shell?.style.transform).toBe("matrix(0.5, 0, 0, 0.5, 120, 100)");
    } finally {
      await act(async () => {
        root.unmount();
      });
      nodeVisibility.dispose();
      nodePresentationTransitions.dispose();
      container.remove();
      (
        globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
      ).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    }
  });

  it("uses explicit frame keys while isolating inactive headers", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const renderHeader = vi.fn((context) => (
      <div
        data-header-frame={`${context.node.frame.x}:${context.node.frame.width}`}
      />
    ));
    const renderSiblingHeader = vi.fn(() => <div data-sibling-header />);
    const onHandleReady = vi.fn<(handle: WorkbenchHostHandle | null) => void>();
    const nodes: readonly WorkbenchHostNodeDefinition[] = [
      {
        frame: { x: 0, y: 0, width: 320, height: 240 },
        getHeaderFrameRenderKey: ({ isDragging, node }) =>
          isDragging ? "dragging" : node.frame.width >= 380,
        renderBody: () => null,
        renderHeader,
        title: "Deferred header",
        typeId: "deferred-header",
        window: {
          defaultOpen: true,
          header: {
            heightPx: 52,
            layout: "overlay"
          }
        }
      },
      {
        frame: { x: 360, y: 0, width: 320, height: 240 },
        renderBody: () => null,
        renderHeader: renderSiblingHeader,
        title: "Live sibling header",
        typeId: "live-sibling-header",
        window: { defaultOpen: true }
      }
    ];
    const snapshotRepository = createSnapshotRepository();
    const renderWorkbench = () => (
      <WorkbenchHost
        nodes={nodes}
        onHandleReady={onHandleReady}
        snapshotRepository={snapshotRepository}
        workspaceId="workspace-1"
      />
    );
    const previousActEnvironment = (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT;
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;

    try {
      await act(async () => {
        root.render(renderWorkbench());
      });

      const host = onHandleReady.mock
        .calls[0]?.[0] as WorkbenchHostRuntimeHandle | null;
      const nodeId = host
        ?.getSnapshot()
        .nodes.find((node) => node.data.typeId === "deferred-header")?.id;
      const siblingNodeId = host
        ?.getSnapshot()
        .nodes.find((node) => node.data.typeId === "live-sibling-header")?.id;
      expect(nodeId).toBeTruthy();
      expect(siblingNodeId).toBeTruthy();
      const deferredWindow = container
        .querySelector("[data-header-frame]")
        ?.closest(".workbench-window");
      expect(deferredWindow?.getAttribute("data-window-header-layout")).toBe(
        "overlay"
      );
      expect(
        (deferredWindow as HTMLElement | null)?.style.getPropertyValue(
          "--workbench-header-height"
        )
      ).toBe("52px");

      await act(async () => {
        host?.controller.commands.setSurfaceSize({ width: 1200, height: 800 });
        host?.controller.commands.focusNode(nodeId ?? "");
        host?.controller.commands.setActiveDragNode(nodeId ?? null);
      });
      const rendersAtDragStart = renderHeader.mock.calls.length;
      const siblingRendersAtDragStart = renderSiblingHeader.mock.calls.length;

      await act(async () => {
        host?.controller.commands.dragNode(nodeId ?? "", {
          x: 20,
          y: 10,
          width: 320,
          height: 240
        });
      });
      await act(async () => {
        host?.controller.commands.dragNode(nodeId ?? "", {
          x: 40,
          y: 20,
          width: 320,
          height: 240
        });
      });

      expect(renderHeader).toHaveBeenCalledTimes(rendersAtDragStart);
      expect(renderSiblingHeader).toHaveBeenCalledTimes(
        siblingRendersAtDragStart
      );

      await act(async () => {
        host?.controller.commands.setActiveDragNode(null);
      });
      expect(renderHeader).toHaveBeenCalledTimes(rendersAtDragStart + 1);
      const frameAfterDrag = host?.getSnapshot().nodes[0]?.frame;
      expect(renderHeader.mock.lastCall?.[0].node.frame).toEqual(
        frameAfterDrag
      );
      expect(
        container.querySelector(
          `[data-header-frame='${frameAfterDrag?.x}:${frameAfterDrag?.width}']`
        )
      ).not.toBeNull();

      await act(async () => {
        host?.controller.commands.setActiveResizeNode(nodeId ?? null);
      });
      const rendersAtResizeStart = renderHeader.mock.calls.length;

      await act(async () => {
        host?.controller.commands.resizeNode(nodeId ?? "", {
          x: 40,
          y: 20,
          width: 360,
          height: 240
        });
      });
      await act(async () => {
        host?.controller.commands.resizeNode(nodeId ?? "", {
          x: 40,
          y: 20,
          width: 400,
          height: 240
        });
      });

      expect(renderHeader).toHaveBeenCalledTimes(rendersAtResizeStart + 1);
      expect(renderSiblingHeader).toHaveBeenCalledTimes(
        siblingRendersAtDragStart
      );

      await act(async () => {
        host?.controller.commands.setActiveResizeNode(null);
      });
      expect(renderHeader).toHaveBeenCalledTimes(rendersAtResizeStart + 2);
      const frameAfterResize = host?.getSnapshot().nodes[0]?.frame;
      expect(renderHeader.mock.lastCall?.[0].node.frame).toEqual(
        frameAfterResize
      );
      expect(
        container.querySelector(
          `[data-header-frame='${frameAfterResize?.x}:${frameAfterResize?.width}']`
        )
      ).not.toBeNull();

      await act(async () => {
        host?.controller.commands.setActiveDragNode(siblingNodeId ?? null);
      });
      const siblingRendersAtOwnDragStart =
        renderSiblingHeader.mock.calls.length;
      await act(async () => {
        host?.controller.commands.dragNode(siblingNodeId ?? "", {
          x: 400,
          y: 20,
          width: 320,
          height: 240
        });
      });
      expect(renderSiblingHeader).toHaveBeenCalledTimes(
        siblingRendersAtOwnDragStart + 1
      );
      await act(async () => {
        host?.controller.commands.setActiveDragNode(null);
      });
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

  it("keeps header infrastructure stable across genie implementation changes", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const node: WorkbenchNode = {
      data: null,
      displayMode: "floating",
      frame: { x: 0, y: 0, width: 320, height: 240 },
      id: "node-1",
      isMinimized: false,
      kind: "test",
      restoreFrame: null,
      title: "Test"
    };
    const controller = createWorkbenchController({
      nodes: [node],
      nodeStack: [node.id]
    });
    const revisions: object[] = [];
    const headerControls: {
      minimizeNodeToAnchor:
        | ((nodeID: string, minimize?: () => void) => void)
        | null;
    } = { minimizeNodeToAnchor: null };
    const renderHeader = vi.fn((context) => {
      revisions.push(context.renderRevision);
      headerControls.minimizeNodeToAnchor = context.genie.minimizeNodeToAnchor;
      return <div data-window-header />;
    });
    const nodeVisibility = createWorkbenchGenieNodeVisibilityStore();
    const nodePresentationTransitions =
      createWorkbenchNodePresentationTransitionStore();
    const firstMinimize = vi.fn();
    const secondMinimize = vi.fn();
    const renderFrame = (
      minimizeNodeToAnchor: WorkbenchGenieController["minimizeNodeToAnchor"]
    ) => (
      <WorkbenchProvider controller={controller}>
        <WorkbenchWindowFrame
          genieNodeVisibility={nodeVisibility}
          minimizeNodeToAnchor={minimizeNodeToAnchor}
          node={node}
          nodePresentationTransitions={nodePresentationTransitions}
          renderHeader={renderHeader}
          windowChromeMode="custom-header"
          windowHeaderPresentation={{
            border: "none",
            heightPx: 76,
            layout: "overlay",
            overflow: "visible"
          }}
        >
          <div />
        </WorkbenchWindowFrame>
      </WorkbenchProvider>
    );
    const previousActEnvironment = (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT;
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;

    try {
      await act(async () => {
        root.render(renderFrame(firstMinimize));
      });
      await act(async () => {
        root.render(renderFrame(secondMinimize));
      });

      expect(revisions).toHaveLength(2);
      expect(revisions[1]).toBe(revisions[0]);
      const windowElement = container.querySelector(".workbench-window");
      expect(windowElement?.getAttribute("data-window-header-border")).toBe(
        "none"
      );
      expect(windowElement?.getAttribute("data-window-header-layout")).toBe(
        "overlay"
      );
      expect(windowElement?.getAttribute("data-window-header-overflow")).toBe(
        "visible"
      );
      expect(
        (windowElement as HTMLElement | null)?.style.getPropertyValue(
          "--workbench-header-height"
        )
      ).toBe("76px");
      headerControls.minimizeNodeToAnchor?.(node.id);
      expect(firstMinimize).not.toHaveBeenCalled();
      expect(secondMinimize).toHaveBeenCalledWith(node.id, undefined);
    } finally {
      await act(async () => {
        root.unmount();
      });
      nodeVisibility.dispose();
      nodePresentationTransitions.dispose();
      container.remove();
      (
        globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
      ).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    }
  });

  it("refreshes only the window whose genie visibility changed", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const nodeA: WorkbenchNode = {
      data: null,
      displayMode: "floating",
      frame: { x: 0, y: 0, width: 320, height: 240 },
      id: "node-a",
      isMinimized: false,
      kind: "test",
      restoreFrame: null,
      title: "A"
    };
    const nodeB: WorkbenchNode = {
      ...nodeA,
      frame: { x: 40, y: 40, width: 320, height: 240 },
      id: "node-b",
      title: "B"
    };
    const controller = createWorkbenchController({
      nodes: [nodeA, nodeB],
      nodeStack: [nodeA.id, nodeB.id]
    });
    const nodeVisibility = createWorkbenchGenieNodeVisibilityStore();
    const nodePresentationTransitions =
      createWorkbenchNodePresentationTransitionStore();
    const renderActionsA = vi.fn(() => null);
    const renderActionsB = vi.fn(() => null);
    const visibilityA = vi.fn();
    const visibilityB = vi.fn();
    const minimizeNodeToAnchor = vi.fn();
    const previousActEnvironment = (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT;
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;

    try {
      await act(async () => {
        root.render(
          <WorkbenchProvider controller={controller}>
            <WorkbenchWindowFrame
              genieNodeVisibility={nodeVisibility}
              minimizeNodeToAnchor={minimizeNodeToAnchor}
              node={nodeA}
              nodePresentationTransitions={nodePresentationTransitions}
              renderActions={renderActionsA}
            >
              <WorkbenchWindowVisibilityProbe onRender={visibilityA} />
            </WorkbenchWindowFrame>
            <WorkbenchWindowFrame
              genieNodeVisibility={nodeVisibility}
              minimizeNodeToAnchor={minimizeNodeToAnchor}
              node={nodeB}
              nodePresentationTransitions={nodePresentationTransitions}
              renderActions={renderActionsB}
            >
              <WorkbenchWindowVisibilityProbe onRender={visibilityB} />
            </WorkbenchWindowFrame>
          </WorkbenchProvider>
        );
      });
      const nodeARendersBefore = renderActionsA.mock.calls.length;
      const nodeBRendersBefore = renderActionsB.mock.calls.length;

      await act(async () => {
        nodeVisibility.setHidden(nodeA.id, true);
      });

      expect(renderActionsA).toHaveBeenCalledTimes(nodeARendersBefore + 1);
      expect(renderActionsB).toHaveBeenCalledTimes(nodeBRendersBefore);
      expect(visibilityA).toHaveBeenLastCalledWith(false);
      expect(visibilityB).toHaveBeenLastCalledWith(true);
      expect(
        container
          .querySelector(`[data-workbench-window-id="${nodeA.id}"]`)
          ?.getAttribute("data-genie-state")
      ).toBe("hidden");
    } finally {
      await act(async () => {
        root.unmount();
      });
      nodeVisibility.dispose();
      nodePresentationTransitions.dispose();
      container.remove();
      (
        globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
      ).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    }
  });

  it("exposes a covered window while its cover leaves through Genie", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const coveredNode: WorkbenchNode = {
      data: null,
      displayMode: "floating",
      frame: { x: 0, y: 0, width: 320, height: 240 },
      id: "covered",
      isMinimized: false,
      kind: "test",
      restoreFrame: null,
      title: "Covered"
    };
    const coverNode: WorkbenchNode = {
      ...coveredNode,
      id: "cover",
      title: "Cover"
    };
    const controller = createWorkbenchController({
      nodes: [coveredNode, coverNode],
      nodeStack: [coveredNode.id, coverNode.id]
    });
    const nodeVisibility = createWorkbenchGenieNodeVisibilityStore();
    const nodePresentationTransitions =
      createWorkbenchNodePresentationTransitionStore();
    const genie: WorkbenchGenieController = {
      genieLayer: null,
      isPendingMinimizedDockNode: () => false,
      launchNodeFromAnchor: () => {},
      minimizeNodeToAnchor: () => {},
      nodeVisibility,
      pendingMinimizedNode: null,
      registerDockAnchor: () => {},
      shouldAnimateMinimizedDockEnter: () => false
    };
    const coveredVisibility = vi.fn();
    const coverVisibility = vi.fn();
    const renderLayer = (genieController: WorkbenchGenieController) => (
      <WorkbenchProvider controller={controller}>
        <WorkbenchNodeLayer
          genie={genieController}
          nodePresentationTransitions={nodePresentationTransitions}
          renderNode={({ node }) => (
            <WorkbenchVisualExposureProbe
              nodeID={node.id}
              onRender={
                node.id === coveredNode.id ? coveredVisibility : coverVisibility
              }
            />
          )}
        />
      </WorkbenchProvider>
    );

    try {
      await act(async () => {
        root.render(renderLayer(genie));
      });

      expect(coveredVisibility).toHaveBeenLastCalledWith(false);
      expect(coverVisibility).toHaveBeenLastCalledWith(true);

      await act(async () => {
        nodeVisibility.setHidden(coverNode.id, true);
      });

      expect(coveredVisibility).toHaveBeenLastCalledWith(true);
      expect(coverVisibility).toHaveBeenLastCalledWith(false);

      await act(async () => {
        nodeVisibility.setHidden(coverNode.id, false);
      });
      expect(coveredVisibility).toHaveBeenLastCalledWith(false);

      await act(async () => {
        root.render(
          renderLayer({
            ...genie,
            pendingMinimizedNode: {
              ...coverNode,
              isMinimized: true
            }
          })
        );
      });
      expect(coveredVisibility).toHaveBeenLastCalledWith(true);
      expect(coverVisibility).toHaveBeenLastCalledWith(false);
    } finally {
      await act(async () => {
        root.unmount();
      });
      nodeVisibility.dispose();
      nodePresentationTransitions.dispose();
      container.remove();
    }
  });

  it("keeps both windows exposed while the cover frame is transitioning", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const coveredNode: WorkbenchNode = {
      data: null,
      displayMode: "floating",
      frame: { x: 8, y: 52, width: 320, height: 240 },
      id: "covered",
      isMinimized: false,
      kind: "test",
      restoreFrame: null,
      title: "Covered"
    };
    const coverNode: WorkbenchNode = {
      ...coveredNode,
      frame: { x: 400, y: 0, width: 320, height: 240 },
      id: "cover",
      title: "Cover"
    };
    const controller = createWorkbenchController({
      nodes: [coveredNode, coverNode],
      nodeStack: [coveredNode.id, coverNode.id],
      surfaceSize: { height: 600, width: 800 }
    });
    const nodeVisibility = createWorkbenchGenieNodeVisibilityStore();
    const nodePresentationTransitions =
      createWorkbenchNodePresentationTransitionStore();
    const coveredVisibility = vi.fn();
    const coverVisibility = vi.fn();

    try {
      await act(async () => {
        root.render(
          <WorkbenchProvider controller={controller}>
            <WorkbenchNodeLayer
              genie={createTestGenieController(nodeVisibility)}
              nodePresentationTransitions={nodePresentationTransitions}
              renderNode={({ node }) => (
                <WorkbenchVisualExposureProbe
                  nodeID={node.id}
                  onRender={
                    node.id === coveredNode.id
                      ? coveredVisibility
                      : coverVisibility
                  }
                />
              )}
            />
          </WorkbenchProvider>
        );
      });

      expect(coveredVisibility).toHaveBeenLastCalledWith(true);
      await act(async () => {
        controller.commands.moveNode(coverNode.id, {
          ...coverNode.frame,
          x: 8
        });
      });
      expect(
        controller.getSnapshot().nodes.find((node) => node.id === coverNode.id)
          ?.frame
      ).toEqual(coveredNode.frame);
      expect([...nodePresentationTransitions.getSnapshot()]).toEqual([
        coverNode.id
      ]);
      expect(coveredVisibility).toHaveBeenLastCalledWith(true);
      expect(coverVisibility).toHaveBeenLastCalledWith(true);

      const coverShell = container.querySelector<HTMLElement>(
        `[data-workbench-window-id="${coverNode.id}"]`
      );
      await act(async () => {
        dispatchWorkbenchTransition(coverShell, "transitionrun", "translate");
        dispatchWorkbenchTransition(coverShell, "transitionrun", "width");
      });
      await act(async () => {
        dispatchWorkbenchTransition(coverShell, "transitionend", "translate");
      });
      expect([...nodePresentationTransitions.getSnapshot()]).toEqual([
        coverNode.id
      ]);
      expect(coveredVisibility).toHaveBeenLastCalledWith(true);
      await act(async () => {
        dispatchWorkbenchTransition(coverShell, "transitionend", "width");
      });
      expect([...nodePresentationTransitions.getSnapshot()]).toEqual([]);
      expect(coveredVisibility).toHaveBeenLastCalledWith(false);
    } finally {
      await act(async () => {
        root.unmount();
      });
      nodePresentationTransitions.dispose();
      nodeVisibility.dispose();
      container.remove();
    }
  });

  it("keeps covered windows exposed through onboarding entry", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const coveredNode: WorkbenchNode = {
      data: null,
      displayMode: "floating",
      frame: { x: 0, y: 0, width: 320, height: 240 },
      id: "covered",
      isMinimized: false,
      kind: "test",
      restoreFrame: null,
      title: "Covered"
    };
    const coverNode: WorkbenchNode = {
      ...coveredNode,
      data: { launchSource: "onboarding-auto" },
      id: "cover",
      title: "Cover"
    };
    const controller = createWorkbenchController({
      nodes: [coveredNode, coverNode],
      nodeStack: [coveredNode.id, coverNode.id],
      surfaceSize: { height: 600, width: 800 }
    });
    const nodeVisibility = createWorkbenchGenieNodeVisibilityStore();
    const nodePresentationTransitions =
      createWorkbenchNodePresentationTransitionStore();
    const coveredVisibility = vi.fn();
    const coverVisibility = vi.fn();

    try {
      await act(async () => {
        root.render(
          <WorkbenchProvider controller={controller}>
            <WorkbenchNodeLayer
              genie={createTestGenieController(nodeVisibility)}
              nodePresentationTransitions={nodePresentationTransitions}
              renderNode={({ node }) => (
                <WorkbenchVisualExposureProbe
                  nodeID={node.id}
                  onRender={
                    node.id === coveredNode.id
                      ? coveredVisibility
                      : coverVisibility
                  }
                />
              )}
            />
          </WorkbenchProvider>
        );
      });

      expect(coveredVisibility).toHaveBeenLastCalledWith(true);
      expect(coverVisibility).toHaveBeenLastCalledWith(true);

      const entryContent = container.querySelector<HTMLElement>(
        `[data-workbench-window-id="${coverNode.id}"] > .workbench-window-shell__content`
      );
      const animationEnd = new Event("animationend", { bubbles: true });
      Object.defineProperty(animationEnd, "animationName", {
        value: "workbench-shell-enter"
      });
      await act(async () => {
        entryContent?.dispatchEvent(animationEnd);
      });
      expect(coveredVisibility).toHaveBeenLastCalledWith(false);
    } finally {
      await act(async () => {
        root.unmount();
      });
      nodePresentationTransitions.dispose();
      nodeVisibility.dispose();
      container.remove();
    }
  });

  it("keeps a scale-restoring window non-occluding until its animation settles", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const nodeElement = document.createElement("section");
    nodeElement.dataset.workbenchWindowId = "node-1";
    document.body.append(nodeElement);
    const dockElement = document.createElement("button");
    document.body.append(dockElement);
    const root = createRoot(container);
    const node: WorkbenchNode = {
      data: null,
      displayMode: "floating",
      frame: { x: 8, y: 52, width: 320, height: 240 },
      id: "node-1",
      isMinimized: true,
      kind: "test",
      restoreFrame: null,
      title: "Node"
    };
    const controller = createWorkbenchController({
      nodes: [node],
      nodeStack: [node.id],
      surfaceSize: { height: 600, width: 800 }
    });
    const nodePresentationTransitions =
      createWorkbenchNodePresentationTransitionStore();
    const renders: WorkbenchGenieController[] = [];
    const animationFrameCallbacks: FrameRequestCallback[] = [];
    const requestAnimationFrameSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        animationFrameCallbacks.push(callback);
        return animationFrameCallbacks.length;
      });
    const cancelAnimationFrameSpy = vi
      .spyOn(window, "cancelAnimationFrame")
      .mockImplementation(() => {});
    const canvasContextSpy = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockImplementation(() => null);
    vi.spyOn(nodeElement, "getBoundingClientRect").mockReturnValue(
      testDOMRect(80, 80, 320, 240)
    );
    vi.spyOn(dockElement, "getBoundingClientRect").mockReturnValue(
      testDOMRect(20, 520, 44, 44)
    );
    let settleAnimation: (() => void) | null = null;
    const finished = new Promise<void>((resolve) => {
      settleAnimation = resolve;
    });
    const animation = {
      cancel: vi.fn(),
      finished
    } as unknown as Animation;
    const animate = vi.fn(() => animation);
    Object.defineProperty(nodeElement, "animate", {
      configurable: true,
      value: animate
    });
    const previousActEnvironment = (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT;
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const flushAnimationFrame = async () => {
      const callbacks = animationFrameCallbacks.splice(0);
      for (const callback of callbacks) {
        callback(performance.now());
      }
      await Promise.resolve();
      await Promise.resolve();
    };

    try {
      await act(async () => {
        root.render(
          <WorkbenchGenieIdentityProbe
            controller={controller}
            minimizeAnimation="scale"
            nodePresentationTransitions={nodePresentationTransitions}
            onRender={(genie) => renders.push(genie)}
          />
        );
      });
      const genie = renders.at(-1);
      genie?.registerDockAnchor("dock-node-1", dockElement);

      await act(async () => {
        genie?.launchNodeFromAnchor("dock-node-1", node.id, () => {
          controller.commands.restoreNode(node.id);
          return node.id;
        });
        await flushAnimationFrame();
        await flushAnimationFrame();
      });

      expect(animate).toHaveBeenCalledOnce();
      expect(genie?.nodeVisibility.getSnapshot(node.id)).toBe(false);
      expect([...nodePresentationTransitions.getSnapshot()]).toEqual([node.id]);

      await act(async () => {
        settleAnimation?.();
        await finished;
        await Promise.resolve();
      });
      expect([...nodePresentationTransitions.getSnapshot()]).toEqual([]);
    } finally {
      await act(async () => {
        root.unmount();
      });
      requestAnimationFrameSpy.mockRestore();
      cancelAnimationFrameSpy.mockRestore();
      canvasContextSpy.mockRestore();
      nodePresentationTransitions.dispose();
      dockElement.remove();
      nodeElement.remove();
      container.remove();
      (
        globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
      ).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    }
  });

  it("keeps the genie controller stable while forwarding to current internals", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const controller = createWorkbenchController();
    const nodePresentationTransitions =
      createWorkbenchNodePresentationTransitionStore();
    const firstLog = vi.fn();
    const secondLog = vi.fn();
    const firstDiagnostics: WorkbenchDebugDiagnostics = {
      isEnabled: () => true,
      log: firstLog
    };
    const secondDiagnostics: WorkbenchDebugDiagnostics = {
      isEnabled: () => true,
      log: secondLog
    };
    const renders: WorkbenchGenieController[] = [];
    const previousActEnvironment = (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT;
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;

    try {
      await act(async () => {
        root.render(
          <WorkbenchGenieIdentityProbe
            controller={controller}
            debugDiagnostics={firstDiagnostics}
            nodePresentationTransitions={nodePresentationTransitions}
            onRender={(genie) => renders.push(genie)}
          />
        );
      });
      await act(async () => {
        root.render(
          <WorkbenchGenieIdentityProbe
            controller={controller}
            debugDiagnostics={secondDiagnostics}
            nodePresentationTransitions={nodePresentationTransitions}
            onRender={(genie) => renders.push(genie)}
          />
        );
      });

      expect(renders).toHaveLength(2);
      expect(renders[1]).toBe(renders[0]);
      renders[1]?.minimizeNodeToAnchor("missing-node");
      expect(firstLog).not.toHaveBeenCalled();
      expect(secondLog).toHaveBeenCalledWith(
        expect.objectContaining({
          details: expect.objectContaining({
            nodeId: "missing-node",
            reason: "target_missing"
          }),
          event: "workbench.genie.minimize.skipped"
        })
      );
    } finally {
      await act(async () => {
        root.unmount();
      });
      nodePresentationTransitions.dispose();
      container.remove();
      (
        globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
      ).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    }
  });

  it("retries a node render after its external state recovers", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const listeners = new Set<() => void>();
    let nodeState: { status: "bad" | "ready" } = { status: "bad" };
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const previousActEnvironment = (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT;
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;

    try {
      await act(async () => {
        root.render(
          <WorkbenchHost
            externalStateSource={{
              getNodeState() {
                return nodeState;
              },
              getWorkspaceState() {
                return null;
              },
              subscribeNodeState(_input, listener) {
                listeners.add(listener);
                return () => listeners.delete(listener);
              }
            }}
            nodes={[
              {
                frame: { x: 0, y: 0, width: 320, height: 240 },
                renderBody: (context) => {
                  if (
                    (context.externalNodeState as { status: string } | null)
                      ?.status === "bad"
                  ) {
                    throw new Error("transient external state");
                  }
                  return <div data-node-recovered="true" />;
                },
                title: "Recoverable",
                typeId: "recoverable",
                window: { defaultOpen: true }
              }
            ]}
            snapshotRepository={createSnapshotRepository()}
            workspaceId="workspace-1"
          />
        );
      });

      expect(
        container.querySelector("[data-workbench-node-render-error]")
      ).not.toBeNull();
      nodeState = { status: "ready" };
      await act(async () => {
        for (const listener of listeners) {
          listener();
        }
      });

      expect(container.querySelector("[data-node-recovered]")).not.toBeNull();
    } finally {
      await act(async () => {
        root.unmount();
      });
      consoleError.mockRestore();
      container.remove();
      (
        globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
      ).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    }
  });
});

function testDOMRect(
  x: number,
  y: number,
  width: number,
  height: number
): DOMRect {
  return {
    bottom: y + height,
    height,
    left: x,
    right: x + width,
    top: y,
    width,
    x,
    y,
    toJSON() {
      return {};
    }
  };
}

function dispatchWorkbenchTransition(
  element: HTMLElement | null,
  type: "transitionend" | "transitionrun",
  propertyName: string
): void {
  const event = new Event(type, { bubbles: true });
  Object.defineProperty(event, "propertyName", { value: propertyName });
  element?.dispatchEvent(event);
}

function createSnapshotRepository(): WorkbenchHostSnapshotRepository {
  return {
    async load() {
      return null;
    },
    save(_workspaceId: string, snapshot: WorkbenchSnapshot) {
      return snapshot;
    }
  };
}
