import { ipcRenderer } from "electron";
import { createRoot } from "react-dom/client";
import type { BrowserNodeEvent } from "@tutti-os/browser-node";
import { createBrowserWorkbenchLaunchHandler } from "@tutti-os/browser-node/workbench";
import {
  createWorkbenchSnapshotFromState,
  WorkbenchHost,
  type WorkbenchHostHandle,
  type WorkbenchHostNodeDefinition
} from "@tutti-os/workbench-surface";
import type { DesktopBrowserApi } from "../../src/preload/types.ts";
import { desktopIpcChannels } from "../../src/shared/contracts/ipc.ts";
import { createTranslator } from "../../src/shared/i18n/index.ts";
import { registerWorkspaceAppPopupNotifications } from "../../src/renderer/src/app/windows/workspace/workspaceAppPopupNotifications.ts";
import { createWorkspaceBrowserService } from "../../src/renderer/src/features/workspace-workbench/services/internal/workspaceBrowserService.ts";
import { createWorkbenchWorkspaceBrowserPresenter } from "../../src/renderer/src/features/workspace-workbench/services/workbenchWorkspaceBrowserPresenter.ts";
import { registerWorkspaceBrowserLaunchHandler } from "../../src/renderer/src/features/workspace-workbench/services/workspaceBrowserLaunchCoordinator.ts";

const rendererReadyChannel = "workspace-app-popup-test:renderer-ready";
const rendererAckChannel = "workspace-app-popup-test:browser-event";
const rendererObservationChannel = "workspace-app-popup-test:observation";
const workspaceId = "workspace-app-popup-integration";
const browserTypeId = "browser";

const browserEventListeners = new Set<(event: BrowserNodeEvent) => void>();
const popupRejectedListeners = new Set<
  (event: {
    reason: "deferred-navigation-unsupported" | "post-unsupported";
  }) => void
>();
let browserEvents = 0;
let rejectionNotifications = 0;
let workbenchLaunches = 0;
let workbenchHost: WorkbenchHostHandle | null = null;
let releaseLaunchHandler: (() => void) | null = null;

const browserApi = {
  onEvent(listener: (event: BrowserNodeEvent) => void) {
    browserEventListeners.add(listener);
    return () => browserEventListeners.delete(listener);
  },
  onWorkspaceAppPopupRejected(
    listener: (event: {
      reason: "deferred-navigation-unsupported" | "post-unsupported";
    }) => void
  ) {
    popupRejectedListeners.add(listener);
    return () => popupRejectedListeners.delete(listener);
  }
} as unknown as DesktopBrowserApi;

ipcRenderer.on(desktopIpcChannels.browser.event, (_event, payload) => {
  const browserEvent = payload as BrowserNodeEvent;
  browserEvents += 1;
  ipcRenderer.send(rendererAckChannel, browserEvent);
  reportObservation();
  for (const listener of browserEventListeners) {
    listener(browserEvent);
  }
  void reportWhenBrowserSurfacesReach(browserEvents);
});

ipcRenderer.on(
  desktopIpcChannels.browser.workspaceAppPopupRejected,
  (_event, payload) => {
    for (const listener of popupRejectedListeners) {
      listener(
        payload as {
          reason: "deferred-navigation-unsupported" | "post-unsupported";
        }
      );
    }
    reportObservation();
  }
);

const workspaceBrowserService = createWorkspaceBrowserService({ browserApi });
const featureHostApi = workspaceBrowserService.createFeatureHostApi({
  acceptsEvent: (event) =>
    event.type !== "open-url" ||
    event.sourceNodeId.startsWith("workspace-app:"),
  source: "workspace_app",
  workspaceId
});
featureHostApi.onEvent(() => undefined);

registerWorkspaceAppPopupNotifications({
  browserApi,
  notifications: {
    error() {
      rejectionNotifications += 1;
    }
  } as never,
  translate: createTranslator("en").t
});

const browserNodeDefinition: WorkbenchHostNodeDefinition = {
  frame: { height: 560, width: 900, x: 220, y: 130 },
  instance: { mode: "multi" },
  renderBody: () => null,
  title: "Browser",
  typeId: browserTypeId,
  window: {
    defaultOpen: false,
    restoreOnLoad: true
  }
};
const resolveBrowserLaunch = createBrowserWorkbenchLaunchHandler({
  browserInstancePrefix: "workspace-app-popup-integration",
  typeId: browserTypeId
});

const rootElement = document.querySelector("#root");
if (!(rootElement instanceof HTMLElement)) {
  throw new Error("Workspace App popup fixture root is unavailable");
}

createRoot(rootElement).render(
  <WorkbenchHost
    nodes={[browserNodeDefinition]}
    onHandleReady={(host) => {
      workbenchHost = host;
      releaseLaunchHandler?.();
      releaseLaunchHandler = null;
      if (!host) {
        return;
      }
      const countingHost = {
        activateNode: host.activateNode.bind(host),
        focusNode: host.focusNode.bind(host),
        getSnapshot: host.getSnapshot.bind(host),
        async launchNode(request) {
          workbenchLaunches += 1;
          reportObservation();
          const nodeId = await host.launchNode(request);
          reportObservation();
          return nodeId;
        }
      } as WorkbenchHostHandle;
      releaseLaunchHandler = registerWorkspaceBrowserLaunchHandler(
        workspaceId,
        createWorkbenchWorkspaceBrowserPresenter({ host: countingHost })
      );
      ipcRenderer.send(rendererReadyChannel);
    }}
    onLaunchRequest={resolveBrowserLaunch}
    snapshotRepository={{
      async load() {
        return createWorkbenchSnapshotFromState(
          { nodeStack: [], nodes: [] },
          { metadata: { workbenchHostInitialized: true } }
        );
      },
      save(_workspaceId, snapshot) {
        return snapshot;
      }
    }}
    workspaceId={workspaceId}
  />
);

async function reportWhenBrowserSurfacesReach(
  expectedBrowserSurfaces: number
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (
    workbenchLaunches < expectedBrowserSurfaces ||
    countBrowserSurfaces() < expectedBrowserSurfaces
  ) {
    if (Date.now() >= deadline) {
      reportObservation();
      throw new Error("timed out waiting for Workbench Browser surfaces");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  reportObservation();
}

function countBrowserSurfaces(): number {
  return (
    workbenchHost
      ?.getSnapshot()
      .nodes.filter((node) => node.data.typeId === browserTypeId).length ?? 0
  );
}

function reportObservation(): void {
  ipcRenderer.send(rendererObservationChannel, {
    browserEvents,
    browserSurfaces: countBrowserSurfaces(),
    rejectionNotifications,
    workbenchLaunches
  });
}
