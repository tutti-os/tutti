import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { BrowserNodeRuntimeState } from "@tutti-os/browser-node";
import {
  createWorkspaceBrowserNodeExternalStateSource,
  resolveWorkspaceBrowserNavigationAnalyticsParams,
  resolveWorkspaceBrowserSearchUrl
} from "./workspaceBrowserContributionCore.ts";
import { workspaceBrowserNodeID } from "./workspaceWorkbenchComposition.ts";

const browserFactorySource = readFileSync(
  new URL(
    "./contributions/browserWorkbenchContributionFactory.ts",
    import.meta.url
  ),
  "utf8"
);
const browserContributionSource = readFileSync(
  new URL("./workspaceBrowserContribution.ts", import.meta.url),
  "utf8"
);

test("workspace browser window injects unified traffic lights into the package header", () => {
  assert.match(
    browserContributionSource,
    /renderTrafficLights: input\.renderTrafficLights/
  );
  assert.match(browserFactorySource, /WorkspaceWorkbenchTrafficLights/);
  assert.match(
    browserFactorySource,
    /createElement\([\s\S]*WorkspaceWorkbenchTrafficLights[\s\S]*displayMode: headerContext\.displayMode[\s\S]*windowActions: headerContext\.windowActions/
  );
});

test("resolveWorkspaceBrowserSearchUrl encodes search queries", () => {
  assert.equal(
    resolveWorkspaceBrowserSearchUrl("tutti browser contribution"),
    "https://www.google.com/search?q=tutti+browser+contribution"
  );
});

test("resolveWorkspaceBrowserNavigationAnalyticsParams keeps only navigation host metadata", () => {
  assert.deepEqual(
    resolveWorkspaceBrowserNavigationAnalyticsParams(
      "https://github.com/tutti-os/tutti?token=secret#readme"
    ),
    {
      isLocalhost: false,
      urlDomain: "github.com"
    }
  );
  assert.deepEqual(
    resolveWorkspaceBrowserNavigationAnalyticsParams("http://127.0.0.1:5173/"),
    {
      isLocalhost: true,
      urlDomain: "127.0.0.1"
    }
  );
  assert.equal(
    resolveWorkspaceBrowserNavigationAnalyticsParams("about:blank"),
    null
  );
});

test("createWorkspaceBrowserNodeExternalStateSource exposes runtime state for workbench snapshots", () => {
  const restoreStorage = installForbiddenLocalStorage();
  try {
    const listenerRef: { current: (() => void) | null } = {
      current: null
    };
    const runtimeSnapshot: Record<string, BrowserNodeRuntimeState | undefined> =
      {
        "browser:node-1": createBrowserRuntimeState({
          title: " Example ",
          url: " https://example.com "
        }),
        "browser:node-2": createBrowserRuntimeState({
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
    runtimeSnapshot["browser:node-2"] = createBrowserRuntimeState({
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
    error: null,
    isAttachedToWindow: true,
    isLoading: false,
    isOccluded: false,
    lifecycle: "active",
    title: null,
    url: null,
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
