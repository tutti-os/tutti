import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkbenchNode } from "../core/types.ts";
import { createWorkbenchController } from "../store/createWorkbenchController.ts";
import { createWorkbenchGenieNodeVisibilityStore } from "./genieNodeVisibility.ts";
import { WorkbenchDockFrame } from "./WorkbenchDockFrame.tsx";
import { WorkbenchProvider } from "./WorkbenchProvider.tsx";
import type { WorkbenchGenieController } from "./useWorkbenchGenieAnimation.tsx";

function createTestGenieController(): WorkbenchGenieController & {
  nodeVisibility: ReturnType<typeof createWorkbenchGenieNodeVisibilityStore>;
} {
  return {
    genieLayer: null,
    isPendingMinimizedDockNode: () => false,
    launchNodeFromAnchor: () => {},
    minimizeNodeToAnchor: () => {},
    nodeVisibility: createWorkbenchGenieNodeVisibilityStore(),
    pendingMinimizedNode: null,
    registerDockAnchor: () => {},
    shouldAnimateMinimizedDockEnter: () => false
  };
}

function createNode(
  id: string,
  displayMode: WorkbenchNode["displayMode"] = "floating"
): WorkbenchNode {
  return {
    data: null,
    displayMode,
    frame: { height: 400, width: 500, x: 80, y: 80 },
    id,
    isMinimized: false,
    kind: "test",
    restoreFrame:
      displayMode === "fullscreen"
        ? { height: 400, width: 500, x: 80, y: 80 }
        : null,
    title: id
  };
}

function expectDockState(
  container: HTMLElement,
  state: "disabled" | "hidden"
): void {
  expect(
    container
      .querySelector(".workbench-dock-frame")
      ?.getAttribute("data-immersive-state")
  ).toBe(state);
  if (state === "hidden") {
    expect(
      container.querySelector(".workbench-dock-frame__immersive-hover-zone")
    ).not.toBeNull();
  } else {
    expect(
      container.querySelector(".workbench-dock-frame__immersive-hover-zone")
    ).toBeNull();
  }
}

describe("WorkbenchDockFrame immersive state", () => {
  const previousActEnvironment = (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  });

  it("keeps the Dock visible for an unlocked floating workspace", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const node = createNode("floating");
    const controller = createWorkbenchController({
      nodeStack: [node.id],
      nodes: [node]
    });
    const genie = createTestGenieController();

    try {
      await act(async () => {
        root.render(
          <WorkbenchProvider controller={controller}>
            <WorkbenchDockFrame
              genie={genie}
              renderDock={() => <div>Dock</div>}
            />
          </WorkbenchProvider>
        );
      });

      expectDockState(container, "disabled");
    } finally {
      await act(async () => {
        root.unmount();
      });
      genie.nodeVisibility.dispose();
      container.remove();
    }
  });

  it("keeps the existing immersive Dock behavior for fullscreen windows", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const node = createNode("fullscreen", "fullscreen");
    const controller = createWorkbenchController({
      nodeStack: [node.id],
      nodes: [node]
    });
    const genie = createTestGenieController();

    try {
      await act(async () => {
        root.render(
          <WorkbenchProvider controller={controller}>
            <WorkbenchDockFrame
              genie={genie}
              renderDock={() => <div>Dock</div>}
            />
          </WorkbenchProvider>
        );
      });

      expectDockState(container, "hidden");
    } finally {
      await act(async () => {
        root.unmount();
      });
      genie.nodeVisibility.dispose();
      container.remove();
    }
  });

  it("uses the fullscreen immersive behavior while a layout is locked", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const firstNode = createNode("first");
    const secondNode = createNode("second");
    const controller = createWorkbenchController({
      nodeStack: [firstNode.id, secondNode.id],
      nodes: [firstNode, secondNode]
    });
    const genie = createTestGenieController();

    try {
      await act(async () => {
        root.render(
          <WorkbenchProvider controller={controller}>
            <WorkbenchDockFrame
              genie={genie}
              renderDock={() => <div>Dock</div>}
            />
          </WorkbenchProvider>
        );
      });
      expectDockState(container, "disabled");

      await act(async () => {
        controller.commands.applyLayoutPreset(
          [firstNode.id, secondNode.id],
          { kind: "balanced" },
          true
        );
      });
      expectDockState(container, "hidden");

      await act(async () => {
        controller.commands.releaseLockedLayout();
      });
      expectDockState(container, "disabled");
    } finally {
      await act(async () => {
        root.unmount();
      });
      genie.nodeVisibility.dispose();
      container.remove();
    }
  });
});
