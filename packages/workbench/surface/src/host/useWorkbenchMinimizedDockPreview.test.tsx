import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { WorkbenchDockPreviewCache } from "../react/dockPreviewCache.ts";
import type { WorkbenchMinimizedDockNode } from "./minimizedDockSlots.ts";
import { useWorkbenchMinimizedDockPreview } from "./useWorkbenchMinimizedDockPreview.ts";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function createNode(
  id: string,
  minimizedAtUnixMs = 1
): WorkbenchMinimizedDockNode {
  return {
    data: {
      instanceId: `instance-${id}`,
      instanceKey: null,
      typeId: "test-node"
    },
    displayMode: "floating",
    frame: { height: 600, width: 800, x: 20, y: 20 },
    id,
    isMinimized: true,
    kind: "test",
    minimizedAtUnixMs,
    restoreFrame: null,
    title: id
  };
}

function deferred<T>() {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value: T) {
      resolvePromise?.(value);
    }
  };
}

function renderPreviewHook(
  initialNode: WorkbenchMinimizedDockNode,
  input: {
    capturePreview: (
      node: WorkbenchMinimizedDockNode
    ) => Promise<string | null>;
    dockPreviewCache?: WorkbenchDockPreviewCache;
    workspaceId: string;
  }
) {
  const container = document.createElement("div");
  const root = createRoot(container);
  let current: ReturnType<typeof useWorkbenchMinimizedDockPreview> | undefined;
  function Test({ node }: { node: WorkbenchMinimizedDockNode }): ReactNode {
    current = useWorkbenchMinimizedDockPreview({
      capturePreview: input.capturePreview,
      deferPreview: false,
      dockPreviewCache: input.dockPreviewCache,
      node,
      workspaceId: input.workspaceId
    });
    return null;
  }
  act(() => {
    root.render(<Test node={initialNode} />);
  });
  return {
    get current() {
      if (!current) {
        throw new Error("preview hook did not render");
      }
      return current;
    },
    rerender(node: WorkbenchMinimizedDockNode) {
      act(() => {
        root.render(<Test node={node} />);
      });
    },
    unmount() {
      act(() => root.unmount());
    }
  };
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("useWorkbenchMinimizedDockPreview", () => {
  it("deduplicates capture across concurrent slot and popup consumers", async () => {
    const node = createNode("dedupe-node");
    const captureResult = deferred<string | null>();
    const capturePreview = vi.fn(() => captureResult.promise);
    const input = {
      capturePreview,
      workspaceId: "workspace-dedupe"
    };

    const slot = renderPreviewHook(node, input);
    const popup = renderPreviewHook(node, input);
    await flushEffects();
    expect(capturePreview).toHaveBeenCalledTimes(1);

    await act(async () => {
      captureResult.resolve("data:image/png;base64,SHARED=");
      await captureResult.promise;
    });
    expect(slot.current.previewImageUrl).toBe("data:image/png;base64,SHARED=");
    expect(popup.current.previewImageUrl).toBe("data:image/png;base64,SHARED=");

    slot.unmount();
    popup.unmount();
  });

  it("fences a late result after switching nodes", async () => {
    const oldNode = createNode("stale-node", 1);
    const newNode = createNode("stale-node", 2);
    const oldResult = deferred<string | null>();
    const newResult = deferred<string | null>();
    const capturePreview = vi.fn((node: WorkbenchMinimizedDockNode) =>
      node.minimizedAtUnixMs === 1 ? oldResult.promise : newResult.promise
    );
    const hook = renderPreviewHook(oldNode, {
      capturePreview,
      workspaceId: "workspace-stale"
    });

    hook.rerender(newNode);
    await act(async () => {
      newResult.resolve("data:image/png;base64,NEW=");
      await newResult.promise;
    });
    expect(hook.current.previewImageUrl).toBe("data:image/png;base64,NEW=");

    await act(async () => {
      oldResult.resolve("data:image/png;base64,OLD=");
      await oldResult.promise;
    });
    expect(hook.current.previewImageUrl).toBe("data:image/png;base64,NEW=");
    hook.unmount();
  });

  it("uses persistent cache without starting live capture", async () => {
    const node = createNode("persistent-node");
    const capturePreview = vi.fn(async () => "data:image/png;base64,LIVE=");
    const dockPreviewCache = {
      read: vi.fn(async () => "data:image/png;base64,PERSISTED="),
      write: vi.fn()
    };
    const hook = renderPreviewHook(node, {
      capturePreview,
      dockPreviewCache,
      workspaceId: "workspace-persisted"
    });

    await flushEffects();
    expect(hook.current.previewImageUrl).toBe(
      "data:image/png;base64,PERSISTED="
    );
    expect(capturePreview).not.toHaveBeenCalled();
    expect(dockPreviewCache.read).toHaveBeenCalledWith(
      expect.objectContaining({ revision: "1" })
    );
    expect(dockPreviewCache.write).not.toHaveBeenCalled();
    hook.unmount();
  });

  it("falls back to the shared unrevisioned Dock preview identity", async () => {
    const node = createNode("genie-cache-node", 7);
    const capturePreview = vi.fn(async () => "data:image/png;base64,LIVE=");
    const dockPreviewCache = {
      read: vi.fn(async (key: { revision?: string | null }) =>
        key.revision ? null : "data:image/png;base64,GENIE="
      ),
      write: vi.fn()
    };
    const hook = renderPreviewHook(node, {
      capturePreview,
      dockPreviewCache,
      workspaceId: "workspace-genie"
    });

    await flushEffects();
    expect(hook.current.previewImageUrl).toBe("data:image/png;base64,GENIE=");
    expect(dockPreviewCache.read).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ revision: "7" })
    );
    expect(dockPreviewCache.read).toHaveBeenNthCalledWith(
      2,
      expect.not.objectContaining({ revision: expect.anything() })
    );
    expect(capturePreview).not.toHaveBeenCalled();
    hook.unmount();
  });
});
