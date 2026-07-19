import assert from "node:assert/strict";
import test from "node:test";
import type {
  WorkbenchController,
  WorkbenchHostNodeData
} from "@tutti-os/workbench-surface";
import {
  createWorkspaceChromeController,
  shouldHideWorkspaceWindowButtons
} from "./workspaceChromeController.ts";

test("native workspace buttons hide only for immersive fullscreen on macOS", () => {
  assert.equal(
    shouldHideWorkspaceWindowButtons({
      autoHideChromeEnabled: true,
      hasFullscreenWorkbenchWindow: true,
      platform: "darwin"
    }),
    true
  );
  assert.equal(
    shouldHideWorkspaceWindowButtons({
      autoHideChromeEnabled: false,
      hasFullscreenWorkbenchWindow: true,
      platform: "darwin"
    }),
    false
  );
  assert.equal(
    shouldHideWorkspaceWindowButtons({
      autoHideChromeEnabled: true,
      hasFullscreenWorkbenchWindow: true,
      platform: "win32"
    }),
    false
  );
});

test("workspace chrome controller derives workbench chrome state", () => {
  const workbenchController = createWorkbenchController([
    createNode("node-1"),
    createNode("node-2", { displayMode: "fullscreen" }),
    createNode("node-3", { isMinimized: true })
  ]);
  const controller = createWorkspaceChromeController({
    hostLayout: createHostLayout(false),
    platform: "darwin",
    workbenchController
  });

  assert.deepEqual(controller.getSnapshot(), {
    hasFullscreenWorkbenchWindow: true,
    hasNativeCompactTitlebar: false,
    lockedWorkbenchLayoutPreset: null,
    missionControlDisabled: false,
    useCompactTitlebar: true,
    visibleWorkbenchWindowCount: 2
  });
});

test("workspace chrome controller publishes workbench controller updates", () => {
  const workbenchController = createWorkbenchController([createNode("node-1")]);
  const controller = createWorkspaceChromeController({
    hostLayout: createHostLayout(false),
    platform: "linux",
    workbenchController
  });
  const disabledStates: boolean[] = [];
  controller.subscribe(() => {
    disabledStates.push(controller.getSnapshot().missionControlDisabled);
  });

  workbenchController.setNodes([createNode("node-1"), createNode("node-2")]);

  assert.equal(controller.getSnapshot().visibleWorkbenchWindowCount, 2);
  assert.deepEqual(disabledStates, [false]);
});

test("workspace chrome controller follows host compact titlebar events on macOS", () => {
  const hostLayout = createHostLayout(false);
  const controller = createWorkspaceChromeController({
    hostLayout,
    platform: "darwin"
  });
  const compactStates: boolean[] = [];
  controller.subscribe(() => {
    compactStates.push(controller.getSnapshot().useCompactTitlebar);
  });

  hostLayout.setCompact(true);

  assert.equal(controller.getSnapshot().hasNativeCompactTitlebar, true);
  assert.equal(controller.getSnapshot().useCompactTitlebar, true);
  assert.deepEqual(compactStates, [true]);
});

test("workspace chrome controller ignores host compact titlebar on non-macOS platforms", () => {
  const hostLayout = createHostLayout(true);
  const controller = createWorkspaceChromeController({
    hostLayout,
    platform: "win32"
  });

  assert.deepEqual(controller.getSnapshot(), {
    hasFullscreenWorkbenchWindow: false,
    hasNativeCompactTitlebar: false,
    lockedWorkbenchLayoutPreset: null,
    missionControlDisabled: true,
    useCompactTitlebar: false,
    visibleWorkbenchWindowCount: 0
  });
  assert.equal(hostLayout.subscriberCount(), 0);
});

test("workspace chrome controller resubscribes when the workbench controller changes", () => {
  const firstWorkbenchController = createWorkbenchController([
    createNode("node-1")
  ]);
  const secondWorkbenchController = createWorkbenchController([
    createNode("node-1"),
    createNode("node-2")
  ]);
  const controller = createWorkspaceChromeController({
    hostLayout: createHostLayout(false),
    platform: "linux",
    workbenchController: firstWorkbenchController
  });

  controller.update({
    hostLayout: createHostLayout(false),
    platform: "linux",
    workbenchController: secondWorkbenchController
  });
  firstWorkbenchController.setNodes([
    createNode("node-1"),
    createNode("node-2")
  ]);
  secondWorkbenchController.setNodes([createNode("node-1")]);

  assert.equal(controller.getSnapshot().visibleWorkbenchWindowCount, 1);
});

function createHostLayout(initialCompact: boolean) {
  let compact = initialCompact;
  const listeners = new Set<() => void>();

  return {
    isNativeCompactTitlebar() {
      return compact;
    },
    setCompact(nextCompact: boolean) {
      compact = nextCompact;
      for (const listener of listeners) {
        listener();
      }
    },
    subscribe(listener: () => void) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    subscriberCount() {
      return listeners.size;
    }
  };
}

function createWorkbenchController(
  nodes: ReturnType<typeof createNode>[]
): WorkbenchController<WorkbenchHostNodeData> & {
  setNodes(nextNodes: ReturnType<typeof createNode>[]): void;
} {
  let currentNodes = nodes;
  const listeners = new Set<() => void>();

  return {
    commands: {} as never,
    dispatch() {
      return undefined;
    },
    getSnapshot() {
      return {
        activeDragNodeId: null,
        activeResizeNodeId: null,
        activeSnapTarget: null,
        lockedLayout: null,
        layoutConstraints: {
          minHeight: 160,
          minWidth: 280,
          safeArea: {
            bottom: 88,
            left: 0,
            right: 0,
            top: 52
          },
          surfacePadding: 0
        },
        nodeStack: currentNodes.map((node) => node.id),
        nodes: currentNodes,
        surfaceSize: {
          height: 600,
          width: 800
        }
      };
    },
    setNodes(nextNodes) {
      currentNodes = nextNodes;
      for (const listener of listeners) {
        listener();
      }
    },
    subscribe(listener) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    }
  };
}

function createNode(
  id: string,
  overrides: Partial<{
    displayMode: "floating" | "fullscreen";
    isMinimized: boolean;
  }> = {}
) {
  return {
    data: {} as WorkbenchHostNodeData,
    displayMode: overrides.displayMode ?? "floating",
    frame: {
      height: 320,
      width: 480,
      x: 0,
      y: 0
    },
    id,
    isMinimized: overrides.isMinimized ?? false,
    kind: "test",
    restoreFrame: null,
    title: id
  };
}
