import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { WorkbenchSnapshot } from "@tutti-os/workbench-snapshot";
import type { WorkbenchNode } from "../core/types.ts";
import { WorkbenchProvider } from "../react/WorkbenchProvider.tsx";
import { WorkbenchWindowFrame } from "../react/WorkbenchWindowFrame.tsx";
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
  onRender
}: {
  controller: WorkbenchController;
  debugDiagnostics?: WorkbenchDebugDiagnostics;
  onRender: (genie: WorkbenchGenieController) => void;
}) {
  const genie = useWorkbenchGenieAnimation({ controller, debugDiagnostics });
  onRender(genie);
  return <>{genie.genieLayer}</>;
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
        window: { defaultOpen: true }
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
    const createGenie = (
      minimizeNodeToAnchor: WorkbenchGenieController["minimizeNodeToAnchor"]
    ): WorkbenchGenieController => ({
      genieLayer: null,
      isNodeGenieHidden: () => false,
      isPendingMinimizedDockNode: () => false,
      launchNodeFromAnchor: () => {},
      minimizeNodeToAnchor,
      pendingMinimizedNode: null,
      registerDockAnchor: () => {},
      shouldAnimateMinimizedDockEnter: () => false
    });
    const firstMinimize = vi.fn();
    const secondMinimize = vi.fn();
    const renderFrame = (
      minimizeNodeToAnchor: WorkbenchGenieController["minimizeNodeToAnchor"]
    ) => (
      <WorkbenchProvider controller={controller}>
        <WorkbenchWindowFrame
          genie={createGenie(minimizeNodeToAnchor)}
          node={node}
          renderHeader={renderHeader}
          windowChromeMode="custom-header"
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
      headerControls.minimizeNodeToAnchor?.(node.id);
      expect(firstMinimize).not.toHaveBeenCalled();
      expect(secondMinimize).toHaveBeenCalledWith(node.id, undefined);
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

  it("keeps the genie controller stable while forwarding to current internals", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const controller = createWorkbenchController();
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
            onRender={(genie) => renders.push(genie)}
          />
        );
      });
      await act(async () => {
        root.render(
          <WorkbenchGenieIdentityProbe
            controller={controller}
            debugDiagnostics={secondDiagnostics}
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
