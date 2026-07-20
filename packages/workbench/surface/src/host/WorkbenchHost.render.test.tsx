import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { WorkbenchSnapshot } from "@tutti-os/workbench-snapshot";
import { WorkbenchHost } from "./WorkbenchHost.tsx";
import type {
  WorkbenchContribution,
  WorkbenchHostDockEntryPresentationOverrides,
  WorkbenchHostHandle,
  WorkbenchHostSnapshotRepository
} from "./types.ts";

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
