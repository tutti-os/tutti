import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserNodeRuntimeState } from "@tutti-os/browser-node";
import {
  createWorkspaceBrowserNodeExternalStateSource,
  resolveWorkspaceBrowserSearchUrl
} from "./workspaceBrowserContributionCore.ts";
import { workspaceBrowserNodeID } from "./workspaceWorkbenchComposition.ts";

test("resolveWorkspaceBrowserSearchUrl encodes search queries", () => {
  assert.equal(
    resolveWorkspaceBrowserSearchUrl("tutti browser contribution"),
    "https://www.google.com/search?q=tutti+browser+contribution"
  );
});

test("createWorkspaceBrowserNodeExternalStateSource exposes runtime state for workbench snapshots", () => {
  const restoreStorage = installForbiddenLocalStorage();
  try {
    const listenerRef: { current: (() => void) | null } = {
      current: null
    };
    const tabsListenerRef: { current: (() => void) | null } = {
      current: null
    };
    const runtimeSnapshot: Record<string, BrowserNodeRuntimeState | undefined> =
      {
        "browser:node-1:tab:1": createBrowserRuntimeState({
          title: " Example ",
          url: " https://example.com "
        }),
        "browser:node-2:tab:1": createBrowserRuntimeState({
          title: "   ",
          url: "   "
        })
      };
    const source = createWorkspaceBrowserNodeExternalStateSource({
      runtimeStore: {
        getSnapshot() {
          return runtimeSnapshot;
        },
        subscribe(nextListener) {
          listenerRef.current = nextListener;
          return () => {
            listenerRef.current = null;
          };
        }
      },
      tabsStore: {
        getActiveNodeId(surfaceNodeId) {
          return `${surfaceNodeId}:tab:1`;
        },
        subscribe(nextListener) {
          tabsListenerRef.current = nextListener;
          return () => {
            tabsListenerRef.current = null;
          };
        }
      }
    });

    assert.deepEqual(
      source.getNodeState({
        instanceId: "node-1",
        nodeId: "browser:node-1",
        typeId: workspaceBrowserNodeID,
        workspaceId: "workspace-1"
      }),
      {
        title: "Example",
        url: "https://example.com"
      }
    );
    assert.deepEqual(
      source.getSnapshotNodeState?.({
        instanceId: "node-1",
        nodeId: "browser:node-1",
        typeId: workspaceBrowserNodeID,
        workspaceId: "workspace-1"
      }),
      {
        title: "Example",
        url: "https://example.com"
      }
    );
    assert.equal(
      source.getNodeState({
        instanceId: "node-2",
        nodeId: "browser:node-2",
        typeId: workspaceBrowserNodeID,
        workspaceId: "workspace-1"
      }),
      null
    );
    assert.equal(
      source.getNodeState({
        instanceId: "node-1",
        nodeId: "browser:node-1",
        typeId: "workspace-files",
        workspaceId: "workspace-1"
      }),
      null
    );

    const dispose = source.subscribe?.(() => {});
    runtimeSnapshot["browser:node-2:tab:1"] = createBrowserRuntimeState({
      title: "Tutti",
      url: "https://tutti.example"
    });
    listenerRef.current?.();

    assert.deepEqual(
      source.getNodeState({
        instanceId: "node-2",
        nodeId: "browser:node-2",
        typeId: workspaceBrowserNodeID,
        workspaceId: "workspace-1"
      }),
      {
        title: "Tutti",
        url: "https://tutti.example"
      }
    );

    dispose?.();
    assert.equal(listenerRef.current, null);
    assert.equal(tabsListenerRef.current, null);
  } finally {
    restoreStorage();
  }
});

function createBrowserRuntimeState(
  overrides: Partial<BrowserNodeRuntimeState>
): BrowserNodeRuntimeState {
  return {
    canGoBack: false,
    canGoForward: false,
    downloads: [],
    error: null,
    findResult: null,
    isAttachedToWindow: true,
    isLoading: false,
    isOccluded: false,
    lifecycle: "active",
    title: null,
    url: null,
    zoomFactor: 1,
    ...overrides
  };
}

function installForbiddenLocalStorage(): () => void {
  const previousDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage"
  );

  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new Error("localStorage should not be accessed");
    }
  });

  return () => {
    if (previousDescriptor) {
      Object.defineProperty(globalThis, "localStorage", previousDescriptor);
      return;
    }
    Reflect.deleteProperty(globalThis, "localStorage");
  };
}
