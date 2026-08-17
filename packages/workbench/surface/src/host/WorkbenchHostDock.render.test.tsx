import { act, StrictMode, useRef } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { WorkbenchNode, WorkbenchState } from "../core/types.ts";
import type { WorkbenchDockContext } from "../react/types.ts";
import * as genieAnimation from "../react/useWorkbenchGenieAnimation.tsx";
import type { WorkbenchController } from "../store/types.ts";
import { WorkbenchHostDock } from "./WorkbenchHostDock.tsx";
import { WorkbenchHostDockPopup } from "./WorkbenchHostDockPopup.tsx";
import { useDockMagnification } from "./dockMagnification.ts";
import type {
  WorkbenchHostDockPopupPreviewProvider,
  WorkbenchHostHandle,
  WorkbenchHostNodeData
} from "./types.ts";
import { createWorkbenchHostI18nRuntime } from "./workbenchHostI18n.ts";

describe("WorkbenchHostDock", () => {
  it("reads slot geometry once during a dock magnification session", async () => {
    const frames = installAnimationFrameQueue();
    let magnification: ReturnType<typeof useDockMagnification> | null = null;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const previousActEnvironment = (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT;
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;

    function Harness(): React.JSX.Element {
      const dockPlateRef = useRef<HTMLDivElement>(null);
      const dockRootRef = useRef<HTMLDivElement>(null);
      const dockViewportRef = useRef<HTMLDivElement>(null);
      const slotRefs = useRef(new Map<string, HTMLElement>());
      magnification = useDockMagnification({
        dockPlateRef,
        dockPlacement: "bottom",
        dockRootRef,
        dockViewportRef,
        slotRefs
      });
      const registerSlot =
        (anchorKey: string) => (element: HTMLDivElement | null) => {
          if (element) {
            slotRefs.current.set(anchorKey, element);
          } else {
            slotRefs.current.delete(anchorKey);
          }
        };

      return (
        <div ref={dockPlateRef}>
          <div ref={dockRootRef}>
            <div ref={dockViewportRef} data-testid="viewport">
              <div
                ref={registerSlot("a")}
                data-desktop-dock-anchor-key="a"
                data-testid="slot-a"
              >
                <span data-desktop-dock-icon-shell />
              </div>
              <div
                ref={registerSlot("b")}
                data-desktop-dock-anchor-key="b"
                data-testid="slot-b"
              >
                <span data-desktop-dock-icon-shell />
              </div>
            </div>
          </div>
        </div>
      );
    }

    try {
      await act(async () => {
        root.render(<Harness />);
      });
      const viewport = container.querySelector<HTMLElement>(
        '[data-testid="viewport"]'
      );
      const slotA = container.querySelector<HTMLElement>(
        '[data-testid="slot-a"]'
      );
      const slotB = container.querySelector<HTMLElement>(
        '[data-testid="slot-b"]'
      );
      if (!viewport || !slotA || !slotB || !magnification) {
        throw new Error("Expected dock magnification harness");
      }
      const viewportRect = vi
        .spyOn(viewport, "getBoundingClientRect")
        .mockReturnValue(domRect(0, 0, 400, 100));
      const slotARect = vi
        .spyOn(slotA, "getBoundingClientRect")
        .mockReturnValue(domRect(100, 36.8, 43.2, 43.2));
      const slotBRect = vi
        .spyOn(slotB, "getBoundingClientRect")
        .mockReturnValue(domRect(160, 36.8, 43.2, 43.2));

      act(() => {
        magnification?.handlePointerMove(120, 60);
      });
      expect(viewportRect).toHaveBeenCalledOnce();
      expect(slotARect).toHaveBeenCalledOnce();
      expect(slotBRect).toHaveBeenCalledOnce();

      await act(async () => {
        frames.flushNext(0);
        frames.flushNext(16);
        frames.flushNext(32);
      });

      expect(viewportRect).toHaveBeenCalledOnce();
      expect(slotARect).toHaveBeenCalledOnce();
      expect(slotBRect).toHaveBeenCalledOnce();
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
      (
        globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
      ).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
      vi.restoreAllMocks();
    }
  });

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

  it("captures dock popup previews as images when no component preview exists", async () => {
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
    const captureNodePreviewImage = vi.fn(
      async () => "data:image/png;base64,AA=="
    );
    const dockEntry = {
      icon: null,
      id: "agent-gui",
      instanceMode: "multi" as const,
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
        root.render(
          <WorkbenchHostDock
            {...props}
            captureNodePreviewImage={captureNodePreviewImage}
            dockEntries={[dockEntry]}
          />
        );
      });
      const button = container.querySelector<HTMLButtonElement>(
        'button[aria-haspopup="dialog"]'
      );
      expect(button).not.toBeNull();

      await act(async () => {
        button?.click();
      });

      await vi.waitFor(() => {
        expect(captureNodePreviewImage).toHaveBeenCalledWith(node);
      });
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

  it("shows the node title when a popup item has no resolved title", async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        disconnect() {}
        observe() {}
        unobserve() {}
      }
    );
    const node = createNode();
    const { host } = createDockProps([node]);
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
        root.render(
          <WorkbenchHostDockPopup
            anchorRect={{ height: 40, left: 20, top: 100, width: 40 }}
            closeWindowLabel={() => "Close"}
            items={[
              {
                host,
                isFocused: false,
                isMinimized: false,
                node,
                preview: null,
                previewRevision: null,
                subtitle: null,
                title: null
              }
            ]}
            label="Agent"
            newWindowLabel="New"
            onClose={() => undefined}
            onCloseNode={() => undefined}
            onCreateNew={() => undefined}
            onSelectNode={() => undefined}
            showCreateNew={false}
          />
        );
      });

      expect(
        document.body.querySelector(".desktop-dock-popup__title-marquee")
          ?.textContent
      ).toBe("Agent");
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

  it("uses persisted previews before serialized background DOM fallbacks", async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        disconnect() {}
        observe() {}
        unobserve() {}
      }
    );
    const node = {
      ...createNode(),
      id: "agent-gui:background-preview"
    };
    const unavailableNode = {
      ...createNode(),
      id: "agent-gui:unavailable-preview"
    };
    const memoryPreviewNode = {
      ...createNode(),
      id: "agent-gui:memory-preview"
    };
    const sharedPersistedPreviewNode = {
      ...createNode(),
      id: "agent-gui:shared-persisted-preview"
    };
    const secondUnavailableNode = {
      ...createNode(),
      id: "agent-gui:second-unavailable-preview"
    };
    const { host } = createDockProps([
      node,
      memoryPreviewNode,
      sharedPersistedPreviewNode,
      unavailableNode,
      secondUnavailableNode
    ]);
    const capturePreview = vi.fn<
      NonNullable<
        React.ComponentProps<typeof WorkbenchHostDockPopup>["capturePreview"]
      >
    >(async () => null);
    const previewImageUrl = "data:image/png;base64,Q0FDSEU=";
    const memoryPreviewImageUrl = "data:image/png;base64,TUVNT1JZ";
    const sharedPersistedPreviewImageUrl = "data:image/png;base64,U0hBUkVE";
    const domPreviewImageUrl = "data:image/png;base64,RE9N";
    const secondDomPreviewImageUrl = "data:image/png;base64,RE9NLTI=";
    const pendingDomPreview = deferred<string>();
    const captureDomPreview = vi
      .spyOn(genieAnimation, "captureWorkbenchNodePreviewImage")
      .mockImplementation((nodeId) =>
        nodeId === unavailableNode.id
          ? pendingDomPreview.promise
          : Promise.resolve(secondDomPreviewImageUrl)
      );
    genieAnimation.writeCachedWorkbenchNodePreviewImage(
      memoryPreviewNode.id,
      memoryPreviewImageUrl
    );
    const readPersistedPreview = vi.fn(
      async (key: { nodeId: string; revision?: string | null }) => {
        if (key.nodeId === node.id && key.revision === "revision-1") {
          return previewImageUrl;
        }
        if (
          key.nodeId === sharedPersistedPreviewNode.id &&
          key.revision == null
        ) {
          return sharedPersistedPreviewImageUrl;
        }
        if (key.nodeId === sharedPersistedPreviewNode.id) {
          return "data:image/png;base64,U1RBTEU=";
        }
        return null;
      }
    );
    const writePersistedPreview = vi.fn();
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
        root.render(
          <WorkbenchHostDockPopup
            anchorRect={{ height: 40, left: 20, top: 100, width: 40 }}
            capturePreview={capturePreview}
            closeWindowLabel={() => "Close"}
            dockPreviewCache={{
              read: readPersistedPreview,
              write: writePersistedPreview
            }}
            items={[
              {
                host,
                isFocused: false,
                isMinimized: false,
                node,
                preview: null,
                previewRevision: "revision-1",
                subtitle: null,
                title: "Agent"
              },
              {
                host,
                isFocused: false,
                isMinimized: false,
                node: memoryPreviewNode,
                preview: null,
                previewRevision: "revision-1",
                subtitle: null,
                title: "Memory Agent"
              },
              {
                host,
                isFocused: false,
                isMinimized: false,
                node: sharedPersistedPreviewNode,
                preview: null,
                previewRevision: "revision-1",
                subtitle: null,
                title: "Shared Persisted Agent"
              },
              {
                host,
                isFocused: false,
                isMinimized: false,
                node: unavailableNode,
                preview: null,
                previewRevision: "revision-1",
                subtitle: null,
                title: "Background Agent"
              },
              {
                host,
                isFocused: false,
                isMinimized: false,
                node: secondUnavailableNode,
                preview: null,
                previewRevision: "revision-1",
                subtitle: null,
                title: "Second Background Agent"
              }
            ]}
            label="Agent"
            newWindowLabel="New"
            onClose={() => undefined}
            onCloseNode={() => undefined}
            onCreateNew={() => undefined}
            onSelectNode={() => undefined}
            resolveDockPreviewCacheKey={(candidate) => ({
              instanceId: candidate.data.instanceId,
              instanceKey: candidate.data.instanceKey,
              nodeId: candidate.id,
              typeId: candidate.data.typeId,
              workspaceId: "workspace-1"
            })}
          />
        );
      });

      await vi.waitFor(() => {
        expect(capturePreview).toHaveBeenCalledTimes(4);
        expect(readPersistedPreview).toHaveBeenCalledTimes(6);
        expect(captureDomPreview).toHaveBeenCalledOnce();
        expect(captureDomPreview).toHaveBeenCalledWith(unavailableNode.id, {
          bypassCache: true
        });
      });
      expect(capturePreview.mock.calls.map(([item]) => item.node.id)).toEqual([
        node.id,
        memoryPreviewNode.id,
        sharedPersistedPreviewNode.id,
        unavailableNode.id
      ]);

      pendingDomPreview.resolve(domPreviewImageUrl);
      await Promise.resolve();
      expect(captureDomPreview).toHaveBeenCalledOnce();

      await vi.waitFor(() => {
        expect(capturePreview).toHaveBeenCalledTimes(5);
        expect(readPersistedPreview).toHaveBeenCalledTimes(8);
        expect(captureDomPreview).toHaveBeenCalledTimes(2);
        expect(captureDomPreview).toHaveBeenLastCalledWith(
          secondUnavailableNode.id,
          { bypassCache: true }
        );
        expect(writePersistedPreview).toHaveBeenCalledTimes(4);
        for (const [candidate, expectedPreview] of [
          [node, previewImageUrl],
          [memoryPreviewNode, memoryPreviewImageUrl],
          [unavailableNode, domPreviewImageUrl],
          [secondUnavailableNode, secondDomPreviewImageUrl]
        ] as const) {
          expect(writePersistedPreview).toHaveBeenCalledWith({
            key: expect.objectContaining({
              nodeId: candidate.id,
              revision: undefined
            }),
            previewImageUrl: expectedPreview
          });
        }
        expect(
          Array.from(
            document.body.querySelectorAll<HTMLImageElement>(
              `[data-preview-kind="image"] img`
            ),
            (image) => image.src
          )
        ).toEqual([
          previewImageUrl,
          memoryPreviewImageUrl,
          sharedPersistedPreviewImageUrl,
          domPreviewImageUrl,
          secondDomPreviewImageUrl
        ]);
        expect(
          document.body.querySelector(`[data-preview-state="loading"]`)
        ).toBeNull();
      });
    } finally {
      pendingDomPreview.resolve(domPreviewImageUrl);
      captureDomPreview.mockRestore();
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

  it("retries a previously unavailable preview when the popup reopens", async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        disconnect() {}
        observe() {}
        unobserve() {}
      }
    );
    const node = {
      ...createNode(),
      id: "agent-gui:retry-unavailable-preview"
    };
    const { host } = createDockProps([node]);
    const previewImageUrl = "data:image/png;base64,UkVUUlk=";
    const capturePreview = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(previewImageUrl);
    const container = document.createElement("div");
    document.body.append(container);
    let root = createRoot(container);
    const previousActEnvironment = (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT;
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const popup = (
      <WorkbenchHostDockPopup
        anchorRect={{ height: 40, left: 20, top: 100, width: 40 }}
        capturePreview={capturePreview}
        closeWindowLabel={() => "Close"}
        items={[
          {
            host,
            isFocused: false,
            isMinimized: false,
            node,
            preview: null,
            previewRevision: "revision-1",
            subtitle: null,
            title: "Agent"
          }
        ]}
        label="Agent"
        newWindowLabel="New"
        onClose={() => undefined}
        onCloseNode={() => undefined}
        onCreateNew={() => undefined}
        onSelectNode={() => undefined}
      />
    );

    try {
      await act(async () => {
        root.render(popup);
      });
      await vi.waitFor(() => {
        expect(
          document.body.querySelector(`[data-preview-state="fallback"]`)
        ).not.toBeNull();
      });

      await act(async () => {
        root.unmount();
      });
      root = createRoot(container);
      await act(async () => {
        root.render(popup);
      });

      await vi.waitFor(() => {
        expect(capturePreview).toHaveBeenCalledTimes(2);
        expect(
          document.body.querySelector<HTMLImageElement>(
            `[data-preview-kind="image"] img`
          )?.src
        ).toBe(previewImageUrl);
      });
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

  it("does not restart an in-flight popup capture after a semantic no-op render", async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        disconnect() {}
        observe() {}
        unobserve() {}
      }
    );
    const node = {
      ...createNode(),
      id: "agent-gui:pending-preview"
    };
    const props = createDockProps([node]);
    const pendingCapture = deferred<string>();
    const captureNodePreviewImage = vi.fn(() => pendingCapture.promise);
    const dockEntry = {
      icon: null,
      id: "agent-gui",
      instanceMode: "multi" as const,
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
        root.render(
          <WorkbenchHostDock
            {...props}
            captureNodePreviewImage={captureNodePreviewImage}
            dockEntries={[dockEntry]}
          />
        );
      });
      const button = container.querySelector<HTMLButtonElement>(
        'button[aria-haspopup="dialog"]'
      );
      await act(async () => {
        button?.click();
      });
      await vi.waitFor(() => {
        expect(captureNodePreviewImage).toHaveBeenCalledTimes(1);
      });

      await act(async () => {
        root.render(
          <WorkbenchHostDock
            {...props}
            captureNodePreviewImage={captureNodePreviewImage}
            dockEntries={[dockEntry]}
          />
        );
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(captureNodePreviewImage).toHaveBeenCalledTimes(1);
      pendingCapture.resolve("data:image/png;base64,AA==");
    } finally {
      pendingCapture.resolve("data:image/png;base64,AA==");
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

  it("keeps an issued capture pending while the popup effect is replaced", async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        disconnect() {}
        observe() {}
        unobserve() {}
      }
    );
    const node = {
      ...createNode(),
      id: "agent-gui:replaced-preview-effect"
    };
    const { host } = createDockProps([node]);
    const pendingCapture = deferred<string>();
    const capturePreview = vi.fn(() => pendingCapture.promise);
    const item = {
      host,
      isFocused: false,
      isMinimized: false,
      node,
      preview: null,
      previewRevision: null,
      subtitle: null,
      title: "Agent"
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
    const renderPopup = (variant: "context-menu" | "default") => (
      <WorkbenchHostDockPopup
        anchorRect={{ height: 40, left: 20, top: 100, width: 40 }}
        capturePreview={capturePreview}
        closeWindowLabel={() => "Close"}
        items={[item]}
        label="Agent"
        newWindowLabel="New"
        onClose={() => undefined}
        onCloseNode={() => undefined}
        onCreateNew={() => undefined}
        onSelectNode={() => undefined}
        variant={variant}
      />
    );

    try {
      await act(async () => {
        root.render(renderPopup("default"));
      });
      await vi.waitFor(() => {
        expect(capturePreview).toHaveBeenCalledTimes(1);
      });

      await act(async () => {
        root.render(renderPopup("context-menu"));
      });
      await act(async () => {
        root.render(renderPopup("default"));
      });

      expect(capturePreview).toHaveBeenCalledTimes(1);
      pendingCapture.resolve("data:image/png;base64,AA==");
    } finally {
      pendingCapture.resolve("data:image/png;base64,AA==");
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

  it("commits an issued preview after StrictMode replays the capture effect", async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        disconnect() {}
        observe() {}
        unobserve() {}
      }
    );
    const node = {
      ...createNode(),
      id: "agent-gui:strict-preview-effect"
    };
    const replayNode = {
      ...createNode(),
      id: "agent-gui:strict-preview-replay"
    };
    const { host } = createDockProps([node, replayNode]);
    const pendingCapture = deferred<string>();
    const replayPreviewImageUrl = "data:image/png;base64,UkVQTEFZ";
    const capturePreview = vi.fn((item: { node: WorkbenchNode }) =>
      item.node.id === node.id
        ? pendingCapture.promise
        : Promise.resolve(replayPreviewImageUrl)
    );
    const previewEvents: string[] = [];
    const previewImageUrl = "data:image/png;base64,U1RSSUNU";
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
        root.render(
          <StrictMode>
            <WorkbenchHostDockPopup
              anchorRect={{ height: 40, left: 20, top: 100, width: 40 }}
              capturePreview={capturePreview}
              closeWindowLabel={() => "Close"}
              debugDiagnostics={{
                isEnabled: () => true,
                log: ({ event }) => {
                  previewEvents.push(event);
                }
              }}
              items={[
                {
                  host,
                  isFocused: true,
                  isMinimized: false,
                  node,
                  preview: null,
                  previewRevision: "revision-1",
                  subtitle: null,
                  title: "Agent"
                },
                {
                  host,
                  isFocused: false,
                  isMinimized: false,
                  node: replayNode,
                  preview: null,
                  previewRevision: "revision-1",
                  subtitle: null,
                  title: "Background Agent"
                }
              ]}
              label="Agent"
              newWindowLabel="New"
              onClose={() => undefined}
              onCloseNode={() => undefined}
              onCreateNew={() => undefined}
              onSelectNode={() => undefined}
            />
          </StrictMode>
        );
      });
      await vi.waitFor(() => {
        expect(capturePreview.mock.calls.map(([item]) => item.node.id)).toEqual(
          [node.id, replayNode.id]
        );
      });

      await act(async () => {
        pendingCapture.resolve(previewImageUrl);
        await Promise.resolve();
      });

      await vi.waitFor(() => {
        expect(previewEvents).toContain("dock.popup.preview_capture.resolved");
        expect(
          Array.from(
            document.body.querySelectorAll<HTMLImageElement>(
              `[data-preview-kind="image"] img`
            ),
            (image) => image.src
          )
        ).toEqual([previewImageUrl, replayPreviewImageUrl]);
        expect(capturePreview.mock.calls.map(([item]) => item.node.id)).toEqual(
          [node.id, replayNode.id]
        );
      });
    } finally {
      pendingCapture.resolve(previewImageUrl);
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

function installAnimationFrameQueue(): {
  flushNext(frameTime: number): void;
} {
  let nextID = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    const id = nextID;
    nextID += 1;
    callbacks.set(id, callback);
    return id;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    callbacks.delete(id);
  });
  return {
    flushNext(frameTime) {
      const first = callbacks.entries().next().value as
        | [number, FrameRequestCallback]
        | undefined;
      if (!first) {
        throw new Error("Expected a pending animation frame");
      }
      callbacks.delete(first[0]);
      first[1](frameTime);
    }
  };
}

function domRect(
  left: number,
  top: number,
  width: number,
  height: number
): DOMRect {
  return {
    bottom: top + height,
    height,
    left,
    right: left + width,
    top,
    width,
    x: left,
    y: top,
    toJSON: () => ({})
  };
}

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

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolvePromise = (_value: T): void => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}
