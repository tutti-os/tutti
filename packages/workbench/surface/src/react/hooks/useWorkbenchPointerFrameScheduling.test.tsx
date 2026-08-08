import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getWorkbenchSnapRect } from "../../core/geometry.ts";
import type { WorkbenchNode } from "../../core/types.ts";
import { createWorkbenchController } from "../../store/createWorkbenchController.ts";
import { WorkbenchProvider } from "../WorkbenchProvider.tsx";
import { useWorkbenchDrag } from "./useWorkbenchDrag.ts";
import { useWorkbenchResize } from "./useWorkbenchResize.ts";

interface AnimationFrameQueue {
  flushNext(): void;
  pendingCount(): number;
  restore(): void;
}

function installAnimationFrameQueue(): AnimationFrameQueue {
  let nextID = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  const requestSpy = vi
    .spyOn(window, "requestAnimationFrame")
    .mockImplementation((callback) => {
      const id = nextID++;
      callbacks.set(id, callback);
      return id;
    });
  const cancelSpy = vi
    .spyOn(window, "cancelAnimationFrame")
    .mockImplementation((id) => {
      callbacks.delete(id);
    });

  return {
    flushNext() {
      const next = callbacks.entries().next().value as
        | [number, FrameRequestCallback]
        | undefined;
      if (!next) {
        throw new Error("Expected a pending animation frame");
      }
      callbacks.delete(next[0]);
      next[1](performance.now());
    },
    pendingCount() {
      return callbacks.size;
    },
    restore() {
      callbacks.clear();
      requestSpy.mockRestore();
      cancelSpy.mockRestore();
    }
  };
}

function createPointerEvent(
  type: "pointercancel" | "pointerdown" | "pointermove" | "pointerup",
  input: {
    button?: number;
    clientX: number;
    clientY: number;
    pointerId?: number;
  }
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    button: { value: input.button ?? 0 },
    clientX: { value: input.clientX },
    clientY: { value: input.clientY },
    pointerId: { value: input.pointerId ?? 1 }
  });
  return event;
}

const initialNode: WorkbenchNode = {
  data: null,
  displayMode: "floating",
  frame: { x: 100, y: 100, width: 320, height: 240 },
  id: "node-1",
  isMinimized: false,
  kind: "test",
  restoreFrame: null,
  title: "Test"
};

function readNodeFrame(
  controller: ReturnType<typeof createWorkbenchController>
) {
  const frame = controller.getSnapshot().nodes[0]?.frame;
  if (!frame) {
    throw new Error("Expected a workbench node frame");
  }
  return frame;
}

function countFrameMutations(
  controller: ReturnType<typeof createWorkbenchController>
) {
  let count = 0;
  let previousFrame = readNodeFrame(controller);
  const unsubscribe = controller.subscribe(() => {
    const nextFrame = readNodeFrame(controller);
    if (nextFrame !== previousFrame) {
      count += 1;
      previousFrame = nextFrame;
    }
  });
  return { count: () => count, unsubscribe };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("workbench pointer frame scheduling", () => {
  it("coalesces drag moves and flushes the latest frame before pointerup", async () => {
    const animationFrames = installAnimationFrameQueue();
    const controller = createWorkbenchController({
      nodes: [initialNode],
      nodeStack: [initialNode.id]
    });
    const frameMutations = countFrameMutations(controller);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    function DragProbe() {
      const onPointerDown = useWorkbenchDrag(initialNode);
      return <button data-drag-handle onPointerDown={onPointerDown} />;
    }

    try {
      await act(async () => {
        root.render(
          <WorkbenchProvider controller={controller}>
            <DragProbe />
          </WorkbenchProvider>
        );
      });
      const handle = container.querySelector(
        "[data-drag-handle]"
      ) as HTMLButtonElement | null;
      if (!handle) {
        throw new Error("Expected a drag handle");
      }
      handle.setPointerCapture = vi.fn();

      await act(async () => {
        handle.dispatchEvent(
          createPointerEvent("pointerdown", { clientX: 200, clientY: 200 })
        );
        window.dispatchEvent(
          createPointerEvent("pointermove", { clientX: 210, clientY: 210 })
        );
        window.dispatchEvent(
          createPointerEvent("pointermove", { clientX: 220, clientY: 225 })
        );
        window.dispatchEvent(
          createPointerEvent("pointermove", { clientX: 230, clientY: 235 })
        );
      });

      expect(animationFrames.pendingCount()).toBe(1);
      expect(frameMutations.count()).toBe(0);
      expect(readNodeFrame(controller)).toEqual(initialNode.frame);

      await act(async () => {
        animationFrames.flushNext();
      });
      expect(frameMutations.count()).toBe(1);
      expect(readNodeFrame(controller)).toEqual({
        ...initialNode.frame,
        x: 130,
        y: 135
      });

      await act(async () => {
        window.dispatchEvent(
          createPointerEvent("pointermove", { clientX: 245, clientY: 250 })
        );
        window.dispatchEvent(
          createPointerEvent("pointerup", { clientX: 245, clientY: 250 })
        );
      });
      expect(animationFrames.pendingCount()).toBe(0);
      expect(frameMutations.count()).toBe(2);
      expect(readNodeFrame(controller)).toEqual({
        ...initialNode.frame,
        x: 145,
        y: 150
      });
      expect(controller.getSnapshot().activeDragNodeId).toBeNull();
    } finally {
      frameMutations.unsubscribe();
      await act(async () => {
        root.unmount();
      });
      container.remove();
      animationFrames.restore();
    }
  });

  it("coalesces resize moves and flushes the latest frame before pointercancel", async () => {
    const animationFrames = installAnimationFrameQueue();
    const controller = createWorkbenchController({
      nodes: [initialNode],
      nodeStack: [initialNode.id]
    });
    const frameMutations = countFrameMutations(controller);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    function ResizeProbe() {
      const onPointerDown = useWorkbenchResize(initialNode, "south-east");
      return <button data-resize-handle onPointerDown={onPointerDown} />;
    }

    try {
      await act(async () => {
        root.render(
          <WorkbenchProvider controller={controller}>
            <ResizeProbe />
          </WorkbenchProvider>
        );
      });
      const handle = container.querySelector(
        "[data-resize-handle]"
      ) as HTMLButtonElement | null;
      if (!handle) {
        throw new Error("Expected a resize handle");
      }
      handle.setPointerCapture = vi.fn();

      await act(async () => {
        handle.dispatchEvent(
          createPointerEvent("pointerdown", { clientX: 300, clientY: 300 })
        );
        window.dispatchEvent(
          createPointerEvent("pointermove", { clientX: 310, clientY: 315 })
        );
        window.dispatchEvent(
          createPointerEvent("pointermove", { clientX: 320, clientY: 325 })
        );
      });

      expect(animationFrames.pendingCount()).toBe(1);
      expect(frameMutations.count()).toBe(0);

      await act(async () => {
        animationFrames.flushNext();
      });
      expect(frameMutations.count()).toBe(1);
      expect(readNodeFrame(controller)).toEqual({
        ...initialNode.frame,
        width: 340,
        height: 265
      });

      await act(async () => {
        window.dispatchEvent(
          createPointerEvent("pointermove", { clientX: 335, clientY: 345 })
        );
        window.dispatchEvent(
          createPointerEvent("pointercancel", { clientX: 335, clientY: 345 })
        );
      });
      expect(animationFrames.pendingCount()).toBe(0);
      expect(frameMutations.count()).toBe(2);
      expect(readNodeFrame(controller)).toEqual({
        ...initialNode.frame,
        width: 355,
        height: 285
      });
      expect(controller.getSnapshot().activeResizeNodeId).toBeNull();
    } finally {
      frameMutations.unsubscribe();
      await act(async () => {
        root.unmount();
      });
      container.remove();
      animationFrames.restore();
    }
  });

  it("flushes the latest locked drag frame before settling the layout", async () => {
    const animationFrames = installAnimationFrameQueue();
    const siblingNode: WorkbenchNode = {
      ...initialNode,
      id: "node-2",
      title: "Sibling"
    };
    const controller = createWorkbenchController({
      nodes: [initialNode, siblingNode],
      nodeStack: [initialNode.id, siblingNode.id],
      surfaceSize: { width: 1024, height: 720 }
    });
    controller.commands.applyLayoutPreset(
      [initialNode.id, siblingNode.id],
      { kind: "row" },
      true
    );
    const draggedNode = controller
      .getSnapshot()
      .nodes.find((candidate) => candidate.id === initialNode.id);
    const siblingFrame = controller
      .getSnapshot()
      .nodes.find((candidate) => candidate.id === siblingNode.id)?.frame;
    if (!draggedNode || !siblingFrame) {
      throw new Error("Expected locked layout nodes");
    }
    const lockedDraggedNode = draggedNode;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    function DragProbe() {
      const onPointerDown = useWorkbenchDrag(lockedDraggedNode);
      return <button data-locked-drag-handle onPointerDown={onPointerDown} />;
    }

    try {
      await act(async () => {
        root.render(
          <WorkbenchProvider controller={controller}>
            <DragProbe />
          </WorkbenchProvider>
        );
      });
      const handle = container.querySelector(
        "[data-locked-drag-handle]"
      ) as HTMLButtonElement | null;
      if (!handle) {
        throw new Error("Expected a locked drag handle");
      }
      handle.setPointerCapture = vi.fn();
      const origin = { x: 200, y: 200 };
      const target = {
        x: origin.x + siblingFrame.x + 10 - lockedDraggedNode.frame.x,
        y: origin.y + siblingFrame.y + 10 - lockedDraggedNode.frame.y
      };

      await act(async () => {
        handle.dispatchEvent(
          createPointerEvent("pointerdown", {
            clientX: origin.x,
            clientY: origin.y
          })
        );
        window.dispatchEvent(
          createPointerEvent("pointermove", {
            clientX: target.x,
            clientY: target.y
          })
        );
        window.dispatchEvent(
          createPointerEvent("pointerup", {
            clientX: target.x,
            clientY: target.y
          })
        );
      });

      expect(animationFrames.pendingCount()).toBe(0);
      expect(
        controller
          .getSnapshot()
          .nodes.find((candidate) => candidate.id === initialNode.id)?.frame
      ).toEqual(siblingFrame);
      expect(controller.getSnapshot().lockedLayout?.nodeIDs).toEqual([
        siblingNode.id,
        initialNode.id
      ]);
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
      animationFrames.restore();
    }
  });

  it("flushes the latest drag frame before applying the final snap target", async () => {
    const animationFrames = installAnimationFrameQueue();
    const controller = createWorkbenchController({
      nodes: [initialNode],
      nodeStack: [initialNode.id],
      surfaceSize: { width: 1024, height: 720 }
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    function DragProbe() {
      const onPointerDown = useWorkbenchDrag(initialNode, {
        edgeSnapEnabled: true
      });
      return <button data-snap-drag-handle onPointerDown={onPointerDown} />;
    }

    try {
      await act(async () => {
        root.render(
          <WorkbenchProvider controller={controller}>
            <DragProbe />
          </WorkbenchProvider>
        );
      });
      const handle = container.querySelector(
        "[data-snap-drag-handle]"
      ) as HTMLButtonElement | null;
      if (!handle) {
        throw new Error("Expected a snap drag handle");
      }
      handle.setPointerCapture = vi.fn();

      await act(async () => {
        handle.dispatchEvent(
          createPointerEvent("pointerdown", { clientX: 300, clientY: 300 })
        );
        window.dispatchEvent(
          createPointerEvent("pointermove", { clientX: 0, clientY: 300 })
        );
        window.dispatchEvent(
          createPointerEvent("pointerup", { clientX: 0, clientY: 300 })
        );
      });

      const snapshot = controller.getSnapshot();
      expect(animationFrames.pendingCount()).toBe(0);
      expect(readNodeFrame(controller)).toEqual(
        getWorkbenchSnapRect(
          "left",
          snapshot.surfaceSize,
          snapshot.layoutConstraints
        )
      );
      expect(snapshot.activeDragNodeId).toBeNull();
      expect(snapshot.activeSnapTarget).toBeNull();
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
      animationFrames.restore();
    }
  });
});
