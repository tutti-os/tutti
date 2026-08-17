import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { WorkbenchNode, WorkbenchState } from "../core/types.ts";
import type { WorkbenchDockContext } from "../react/types.ts";
import type { WorkbenchController } from "../store/types.ts";
import { WorkbenchHostDock } from "./WorkbenchHostDock.tsx";
import type {
  WorkbenchHostDockEntry,
  WorkbenchHostHandle,
  WorkbenchHostNodeData,
  WorkbenchHostNodeDefinition
} from "./types.ts";
import { createWorkbenchHostI18nRuntime } from "./workbenchHostI18n.ts";

describe("WorkbenchHostDock interactions", () => {
  it("preserves blocked, action, focus, popup, and launch click effects", async () => {
    const focusNode = createNode("focus-node", "focus-entry");
    const popupNode = createNode("popup-node", "popup-entry");
    const fixture = createDockFixture([focusNode, popupNode]);
    const events: string[] = [];
    fixture.host.focusNode = vi.fn((nodeId) => {
      events.push(`focus:${nodeId}`);
    });
    fixture.host.launchNode = vi.fn(async (input) => {
      events.push(`launch:${input.dockEntryId}`);
      return null;
    });
    const onDockEntryAction = vi.fn(({ actionId }) => {
      events.push(`action:${actionId}`);
    });
    const onDockEntryClick = vi.fn(({ nodeId }) => {
      events.push(`click:${nodeId}`);
    });
    const entries: WorkbenchHostDockEntry[] = [
      entry("blocked-entry", {
        state: { kind: "disabled", reason: "Unavailable" }
      }),
      entry("action-entry", { clickActionId: "retry" }),
      entry("focus-entry"),
      entry("popup-entry", { instanceMode: "multi" }),
      entry("launch-entry")
    ];
    const mounted = await mountDock(
      <WorkbenchHostDock
        {...fixture.props}
        dockEntries={entries}
        onDockEntryAction={onDockEntryAction}
        onDockEntryClick={onDockEntryClick}
      />
    );

    try {
      await clickDockEntry(mounted.container, "blocked-entry");
      expect(onDockEntryAction).not.toHaveBeenCalled();
      expect(onDockEntryClick).not.toHaveBeenCalled();
      expect(fixture.host.launchNode).not.toHaveBeenCalled();

      await clickDockEntry(mounted.container, "action-entry");
      await vi.waitFor(() => {
        expect(onDockEntryAction).toHaveBeenCalledWith({
          actionId: "retry",
          entryId: "action-entry",
          host: fixture.host
        });
      });

      await clickDockEntry(mounted.container, "focus-entry");
      expect(events.slice(-2)).toEqual([
        "click:focus-node",
        "focus:focus-node"
      ]);
      expect(fixture.launchNodeFromAnchor).toHaveBeenCalledWith(
        "focus-entry",
        "focus-node",
        expect.any(Function)
      );

      await clickDockEntry(mounted.container, "popup-entry");
      expect(
        dockEntryButton(mounted.container, "popup-entry").getAttribute(
          "aria-expanded"
        )
      ).toBe("true");
      expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();

      await clickDockEntry(mounted.container, "launch-entry");
      await vi.waitFor(() => {
        expect(fixture.host.launchNode).toHaveBeenCalledWith({
          dockEntryId: "launch-entry",
          payload: undefined,
          reason: "dock",
          typeId: "launch-entry"
        });
      });
    } finally {
      await mounted.unmount();
    }
  });

  it("keeps context-menu launch metadata and fallback payload semantics", async () => {
    const fixture = createDockFixture();
    const launchNode = vi.fn(async () => null);
    fixture.host.launchNode = launchNode;
    const mounted = await mountDock(
      <WorkbenchHostDock
        {...fixture.props}
        dockEntries={[
          entry("context-entry", {
            launchPayload: { source: "primary" },
            newWindowLaunchPayload: { source: "new-window" }
          })
        ]}
      />
    );

    try {
      const button = dockEntryButton(mounted.container, "context-entry");
      await act(async () => {
        button.dispatchEvent(
          new MouseEvent("contextmenu", { bubbles: true, cancelable: true })
        );
      });
      const menu = document.body.querySelector<HTMLElement>(
        '[data-desktop-dock-context-menu="true"]'
      );
      expect(menu).not.toBeNull();
      const command =
        menu?.querySelector<HTMLButtonElement>('[role="menuitem"]');
      expect(command?.disabled).toBe(false);

      await act(async () => {
        command?.click();
      });
      await vi.waitFor(() => {
        expect(launchNode).toHaveBeenCalledWith({
          dockEntryId: "context-entry",
          launchSource: "dock-popup-new-window",
          payload: { source: "new-window" },
          reason: "dock",
          typeId: "context-entry"
        });
      });
    } finally {
      await mounted.unmount();
    }
  });

  it("runs hover pointer actions once and preserves keyboard activation", async () => {
    const fixture = createDockFixture();
    const pending = deferred();
    const onDockEntryAction = vi.fn(({ actionId }) =>
      actionId === "pointer" ? pending.promise : undefined
    );
    const mounted = await mountDock(
      <WorkbenchHostDock
        {...fixture.props}
        dockEntries={[
          entry("hover-entry", {
            hoverActions: [
              {
                id: "pointer",
                label: "Retry",
                pendingLabel: "Retrying"
              },
              { id: "keyboard", label: "Open settings" }
            ],
            state: { kind: "unavailable", reason: "Connection failed。" }
          })
        ]}
        onDockEntryAction={onDockEntryAction}
      />
    );

    try {
      await act(async () => {
        dockEntryButton(mounted.container, "hover-entry").focus();
      });
      const panel = mounted.container.querySelector<HTMLElement>(
        ".desktop-dock__hover-panel"
      );
      expect(panel?.textContent).toContain("Connection failed");
      expect(panel?.textContent).not.toContain("Connection failed。");
      const [pointerAction, keyboardAction] = Array.from(
        panel?.querySelectorAll<HTMLButtonElement>("button") ?? []
      );

      await act(async () => {
        pointerAction?.dispatchEvent(
          new MouseEvent("pointerdown", { bubbles: true, button: 0 })
        );
        pointerAction?.click();
      });
      expect(onDockEntryAction).toHaveBeenCalledTimes(1);
      expect(onDockEntryAction).toHaveBeenLastCalledWith({
        actionId: "pointer",
        entryId: "hover-entry",
        host: fixture.host
      });
      expect(pointerAction?.getAttribute("aria-busy")).toBe("true");
      expect(pointerAction?.textContent).toBe("Retrying");

      await act(async () => {
        keyboardAction?.click();
      });
      expect(onDockEntryAction).toHaveBeenCalledTimes(2);
      expect(onDockEntryAction).toHaveBeenLastCalledWith({
        actionId: "keyboard",
        entryId: "hover-entry",
        host: fixture.host
      });

      await act(async () => {
        pending.resolve();
        await pending.promise;
      });
      await vi.waitFor(() => {
        expect(pointerAction?.textContent).toBe("Retry");
      });
    } finally {
      pending.resolve();
      await mounted.unmount();
    }
  });

  it("opens and closes label tooltips through keyboard focus", async () => {
    const fixture = createDockFixture();
    const mounted = await mountDock(
      <WorkbenchHostDock
        {...fixture.props}
        dockEntries={[entry("tooltip-entry", { label: "Tooltip label" })]}
      />
    );

    try {
      const button = dockEntryButton(mounted.container, "tooltip-entry");
      await act(async () => {
        button.focus();
      });
      expect(
        mounted.container.querySelector('[role="tooltip"]')?.textContent
      ).toBe("Tooltip label");

      await act(async () => {
        button.blur();
      });
      expect(mounted.container.querySelector('[role="tooltip"]')).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it("restores an independent minimized slot through its Genie anchor", async () => {
    const minimizedNode = createMinimizedNode("minimized-one", 10);
    const fixture = createDockFixture([], [minimizedNode]);
    const mounted = await mountDock(
      <WorkbenchHostDock
        {...fixture.props}
        dockEntries={[]}
        nodeDefinitions={minimizedNodeDefinitions()}
      />
    );

    try {
      const restoreButton = mounted.container.querySelector<HTMLElement>(
        '[data-desktop-dock-anchor-key="minimized:minimized-one"] [role="button"]'
      );
      expect(restoreButton).not.toBeNull();
      await act(async () => {
        restoreButton?.click();
      });

      expect(fixture.launchNodeFromAnchor).toHaveBeenCalledWith(
        "minimized:minimized-one",
        "minimized-one",
        expect.any(Function)
      );
      expect(fixture.host.focusNode).toHaveBeenCalledWith("minimized-one");
    } finally {
      await mounted.unmount();
    }
  });

  it("restores a minimized stack card without replacing the stack anchor", async () => {
    const minimizedNodes = Array.from({ length: 6 }, (_, index) =>
      createMinimizedNode(`minimized-${index + 1}`, index + 1)
    );
    const fixture = createDockFixture([], minimizedNodes);
    const mounted = await mountDock(
      <WorkbenchHostDock
        {...fixture.props}
        dockEntries={[]}
        nodeDefinitions={minimizedNodeDefinitions()}
      />
    );

    try {
      const stackButton = mounted.container.querySelector<HTMLElement>(
        '[data-desktop-dock-anchor-key="minimized-stack"] [role="button"]'
      );
      expect(stackButton).not.toBeNull();
      await act(async () => {
        stackButton?.click();
      });
      const firstCard = document.body.querySelector<HTMLElement>(
        '[data-popup-variant="minimized-stack"] [data-desktop-dock-popup-card="true"] [role="button"]'
      );
      expect(firstCard).not.toBeNull();
      const selectedTitle = firstCard?.getAttribute("aria-label");
      await act(async () => {
        firstCard?.click();
      });

      await vi.waitFor(() => {
        expect(fixture.launchNodeFromAnchor).toHaveBeenCalledWith(
          "minimized-stack",
          selectedTitle,
          expect.any(Function)
        );
      });
      expect(fixture.host.focusNode).toHaveBeenCalledWith(selectedTitle);
    } finally {
      await mounted.unmount();
    }
  });
});

function entry(
  id: string,
  overrides: Partial<WorkbenchHostDockEntry> = {}
): WorkbenchHostDockEntry {
  return {
    icon: null,
    id,
    label: id,
    typeId: id,
    visibility: "always",
    ...overrides
  };
}

function createNode(
  id: string,
  dockEntryId: string
): WorkbenchNode<WorkbenchHostNodeData> {
  return {
    data: {
      dockEntryId,
      instanceId: id,
      instanceKey: null,
      typeId: dockEntryId
    },
    displayMode: "floating",
    frame: { height: 560, width: 1040, x: 20, y: 20 },
    id,
    isMinimized: false,
    kind: dockEntryId,
    restoreFrame: null,
    title: id
  };
}

function createMinimizedNode(
  id: string,
  minimizedAtUnixMs: number
): WorkbenchNode<WorkbenchHostNodeData> {
  return {
    ...createNode(id, "agent"),
    isMinimized: true,
    minimizedAtUnixMs,
    title: id
  };
}

function minimizedNodeDefinitions(): Map<string, WorkbenchHostNodeDefinition> {
  return new Map([
    [
      "agent",
      {
        frame: { height: 560, width: 1040, x: 20, y: 20 },
        renderBody: () => null,
        title: "Agent",
        typeId: "agent",
        window: {
          minimizedDock: {
            kind: "component",
            providePreview: () => ({ element: null, kind: "component" })
          }
        }
      } as WorkbenchHostNodeDefinition
    ]
  ]);
}

function createDockFixture(
  nodes: readonly WorkbenchNode<WorkbenchHostNodeData>[] = [],
  minimizedNodes: readonly WorkbenchNode<WorkbenchHostNodeData>[] = []
) {
  const allNodes = [...nodes, ...minimizedNodes];
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
    nodes: allNodes,
    nodeStack: allNodes.map((node) => node.id),
    surfaceSize: { height: 800, width: 1200 }
  };
  const controller: WorkbenchController<WorkbenchHostNodeData> = {
    commands: {
      enterFullscreen: vi.fn(),
      restoreNode: vi.fn()
    } as unknown as WorkbenchController<WorkbenchHostNodeData>["commands"],
    dispatch() {},
    getSnapshot: () => state,
    subscribe: () => () => {}
  };
  const launchNodeFromAnchor = vi.fn(
    (_anchorKey: string, _nodeId: string, launch: () => unknown) => {
      void launch();
    }
  );
  const context: WorkbenchDockContext<WorkbenchHostNodeData> = {
    controller,
    focusedNodeId: null,
    genie: {
      isPendingMinimizedDockNode: () => false,
      launchNodeFromAnchor,
      registerDockAnchor() {},
      shouldAnimateMinimizedDockEnter: () => false
    },
    minimizedNodes: [...minimizedNodes],
    nodes: allNodes
  };
  const host: WorkbenchHostHandle = {
    activateNode() {},
    closeNode() {},
    collectWindowCloseEffects: async () => [],
    dispose() {},
    exitFullscreenNode() {},
    focusNode: vi.fn(),
    getSnapshot: () => state,
    launchNode: vi.fn(async () => null),
    load: async () => {},
    minimizeNode: vi.fn(),
    reconcileProjectedNodes() {},
    requestNodeClose: vi.fn(),
    setNodeRuntimeState() {},
    setNodeSizeConstraints() {},
    setNodeTitle() {},
    setSnapshotNodeState() {}
  };

  return {
    host,
    launchNodeFromAnchor,
    props: {
      context,
      host,
      i18n: createWorkbenchHostI18nRuntime(undefined),
      nodeDefinitions: new Map(),
      workspaceId: "workspace-interactions"
    }
  };
}

async function mountDock(element: React.ReactNode): Promise<{
  container: HTMLDivElement;
  unmount(): Promise<void>;
}> {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      disconnect() {}
      observe() {}
      unobserve() {}
    }
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root: Root = createRoot(container);
  const previousActEnvironment = (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT;
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => {
    root.render(element);
  });
  return {
    container,
    async unmount() {
      await act(async () => {
        root.unmount();
      });
      container.remove();
      (
        globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
      ).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
      vi.unstubAllGlobals();
    }
  };
}

async function clickDockEntry(container: HTMLElement, entryId: string) {
  await act(async () => {
    dockEntryButton(container, entryId).click();
  });
}

function dockEntryButton(
  container: HTMLElement,
  entryId: string
): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(
    `[data-desktop-dock-anchor-key="${entryId}"] > button`
  );
  if (!button) {
    throw new Error(`Expected dock entry button for ${entryId}`);
  }
  return button;
}

function deferred(): {
  promise: Promise<void>;
  resolve(): void;
} {
  let resolvePromise = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}
