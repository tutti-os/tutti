import {
  BrowserWindow,
  app,
  ipcMain,
  session,
  type WebContents
} from "electron";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { registerBrowserNodeElectronMain } from "@tutti-os/browser-node/electron-main";
import { desktopIpcChannels } from "../../shared/contracts/ipc.ts";
import { registerBrowserGuestWebContents } from "../browser/browserGuestRegistry.ts";
import { registerTuttiAssetProtocolForSession } from "../host/tuttiAssetProtocol.ts";
import { registerWorkspaceAppGuestContext } from "./workspaceAppGuestContextRegistry.ts";
import type { DesktopLogger } from "../logging.ts";
import { installWorkspaceWindowWebviewSecurity } from "../windows/workspaceWebviewSecurity.ts";
import { createWorkspaceAppSessionPartition } from "../../shared/contracts/workspaceAppSessionPartition.ts";

const resultPrefix = "WORKSPACE_APP_POPUP_INTEGRATION=";
const rendererAckChannel = "workspace-app-popup-test:browser-event";
const rendererObservationChannel = "workspace-app-popup-test:observation";
const rendererReadyChannel = "workspace-app-popup-test:renderer-ready";
const workspaceAppPartition = createWorkspaceAppSessionPartition({
  appID: "popup-integration",
  workspaceID: "popup-integration"
});

type FixtureMainHandler = (
  event: unknown,
  payload: unknown
) => Promise<unknown> | unknown;

app.disableHardwareAcceleration();

void runWorkspaceAppPopupIntegration()
  .then((result) => {
    console.log(`${resultPrefix}${JSON.stringify(result)}`);
    app.quit();
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    app.exit(1);
  });

async function runWorkspaceAppPopupIntegration() {
  await app.whenReady();
  const preloadPath =
    process.env.TUTTI_WORKSPACE_APP_POPUP_PRELOAD_PATH?.trim();
  const rendererPath =
    process.env.TUTTI_WORKSPACE_APP_POPUP_RENDERER_PATH?.trim();
  if (!preloadPath || !rendererPath) {
    throw new Error(
      "Workspace App popup fixture requires fixture bundle paths"
    );
  }
  const popupServer = createPopupTargetServer();
  const popupOrigin = await listenOnLoopback(popupServer);
  const workspaceAppServer = createWorkspaceAppTestServer(
    popupOrigin,
    rendererPath
  );
  const workspaceAppOrigin = await listenOnLoopback(workspaceAppServer);
  const counts = {
    browserEvents: 0,
    browserSurfaces: 0,
    deferredPopupRejections: 0,
    nativeChildWindows: 0,
    postPopupRejections: 0,
    producerCallbacks: 0,
    rejectionNotifications: 0,
    workbenchLaunches: 0
  };
  const events: unknown[] = [];
  const mainHandlers = new Map<string, FixtureMainHandler>();
  let attachedGuestContents: WebContents | null = null;
  const logger: DesktopLogger = {
    async close() {},
    debug(message) {
      if (message === "workspace app guest window-open callback") {
        counts.producerCallbacks += 1;
      }
    },
    error() {},
    info() {},
    warn(message) {
      if (message === "workspace app guest rejected POST popup") {
        counts.postPopupRejections += 1;
      } else if (message === "workspace app guest rejected deferred popup") {
        counts.deferredPopupRejections += 1;
      }
    }
  };
  const ownerWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true,
      sandbox: false,
      webviewTag: true
    }
  });
  ipcMain.on(rendererAckChannel, (event, payload) => {
    if (
      event.sender.id !== ownerWindow.webContents.id ||
      !payload ||
      payload.type !== "open-url"
    ) {
      return;
    }
    counts.browserEvents += 1;
    events.push(payload);
  });
  ipcMain.on(rendererObservationChannel, (event, payload) => {
    if (event.sender.id !== ownerWindow.webContents.id || !payload) {
      return;
    }
    counts.browserSurfaces = Number(payload.browserSurfaces) || 0;
    counts.rejectionNotifications = Number(payload.rejectionNotifications) || 0;
    counts.workbenchLaunches = Number(payload.workbenchLaunches) || 0;
  });
  registerBrowserNodeElectronMain({
    channels: desktopIpcChannels.browser,
    getOwnerWindow: () => ownerWindow,
    openExternal: () => {
      throw new Error("Workspace App popup must keep its host route");
    },
    registerHandler(channel, handler) {
      mainHandlers.set(channel, handler as FixtureMainHandler);
    },
    resolveWebContents({ webContentsId }) {
      return attachedGuestContents?.id === webContentsId
        ? attachedGuestContents
        : null;
    }
  });
  const cleanupWebviewSecurity = installWorkspaceWindowWebviewSecurity({
    contents: ownerWindow.webContents,
    logger,
    ownerWindow,
    runtime: {
      openExternal() {
        throw new Error("workspace app popup must not use the default handler");
      },
      registerBrowserGuest(window, guestContents) {
        registerBrowserGuestWebContents(window, guestContents, logger);
      },
      registerWorkspaceAppAssetProtocol(partition) {
        registerTuttiAssetProtocolForSession(session.fromPartition(partition));
      },
      registerWorkspaceAppGuest(window, guestContents, partition) {
        return registerWorkspaceAppGuestContext({
          contents: guestContents,
          logger,
          ownerWindow: window,
          partition
        });
      }
    },
    workspaceAppPreloadPath: preloadPath
  });

  try {
    const guestAttached = waitForGuestAttachment(ownerWindow.webContents);
    const rendererReady = waitForRendererReady(ownerWindow.webContents);
    await ownerWindow.loadURL(`${workspaceAppOrigin}/host`);
    await rendererReady;
    const guestContents = await guestAttached;
    attachedGuestContents = guestContents;
    guestContents.on("did-create-window", () => {
      counts.nativeChildWindows += 1;
    });
    if (guestContents.isLoading()) {
      await once(guestContents, "did-finish-load");
    }
    const registerGuest = mainHandlers.get(
      desktopIpcChannels.browser.registerGuest
    );
    if (!registerGuest) {
      throw new Error("Browser Node registerGuest handler was not registered");
    }
    await registerGuest(
      {},
      {
        nodeId: "workspace-app-popup-integration",
        profileId: null,
        sessionMode: "shared",
        sessionPartition: workspaceAppPartition,
        url: guestContents.getURL(),
        webContentsId: guestContents.id
      }
    );

    const cases = [];
    cases.push(
      await triggerPopup({
        counts,
        expectedBrowserEvents: 0,
        expectedGuestUrl: `${workspaceAppOrigin}/internal?kind=blank-link`,
        expectedPostPopupRejections: 0,
        expectedProducerCallbacks: 1,
        expectedRejectionNotifications: 0,
        guestContents,
        kind: "internal-blank-link",
        script: "document.querySelector('#internal-blank-link').click(); true"
      })
    );
    await guestContents.loadURL(`${workspaceAppOrigin}/guest`);
    cases.push(
      await triggerPopup({
        counts,
        expectedBrowserEvents: 0,
        expectedGuestUrl: `${workspaceAppOrigin}/internal?kind=window-open`,
        expectedPostPopupRejections: 0,
        expectedProducerCallbacks: 1,
        expectedRejectionNotifications: 0,
        guestContents,
        kind: "internal-window-open",
        script: `window.open(${JSON.stringify(`${workspaceAppOrigin}/internal?kind=window-open`)}, '_blank') === null`
      })
    );
    await guestContents.loadURL(`${workspaceAppOrigin}/guest`);
    cases.push(
      await triggerPopup({
        counts,
        expectedBrowserEvents: 1,
        expectedPostPopupRejections: 0,
        expectedProducerCallbacks: 1,
        expectedRejectionNotifications: 0,
        guestContents,
        kind: "blank-link",
        script: "document.querySelector('#blank-link').click(); true"
      })
    );
    cases.push(
      await triggerPopup({
        counts,
        expectedBrowserEvents: 1,
        expectedPostPopupRejections: 0,
        expectedProducerCallbacks: 1,
        expectedRejectionNotifications: 0,
        guestContents,
        kind: "window-open",
        script: `void window.open(${JSON.stringify(`${popupOrigin}/popup?kind=window-open`)}, '_blank'); true`
      })
    );
    cases.push(
      await triggerPopup({
        counts,
        expectedBrowserEvents: 1,
        expectedPostPopupRejections: 0,
        expectedProducerCallbacks: 1,
        expectedRejectionNotifications: 0,
        guestContents,
        kind: "get-form",
        script: "document.querySelector('#get-form').requestSubmit(); true"
      })
    );
    cases.push(
      await triggerPopup({
        counts,
        expectedBrowserEvents: 2,
        expectedPostPopupRejections: 0,
        expectedProducerCallbacks: 2,
        expectedRejectionNotifications: 0,
        guestContents,
        kind: "double-window-open",
        script: `void window.open(${JSON.stringify(`${popupOrigin}/popup?kind=double-window-open-1`)}, '_blank'); void window.open(${JSON.stringify(`${popupOrigin}/popup?kind=double-window-open-2`)}, '_blank'); true`
      })
    );
    cases.push(
      await triggerPopup({
        counts,
        expectedBrowserEvents: 0,
        expectedDeferredPopupRejections: 1,
        expectedPostPopupRejections: 0,
        expectedProducerCallbacks: 1,
        expectedRejectionNotifications: 1,
        guestContents,
        kind: "deferred-window-open",
        script: "window.open('', '_blank') === null"
      })
    );
    cases.push(
      await triggerPopup({
        counts,
        expectedBrowserEvents: 0,
        expectedPostPopupRejections: 1,
        expectedProducerCallbacks: 1,
        expectedRejectionNotifications: 1,
        guestContents,
        kind: "post-form",
        script: "document.querySelector('#post-form').requestSubmit(); true"
      })
    );

    return {
      cases,
      counts,
      events,
      origins: { popup: popupOrigin, workspaceApp: workspaceAppOrigin }
    };
  } finally {
    cleanupWebviewSecurity();
    ipcMain.removeAllListeners(rendererAckChannel);
    ipcMain.removeAllListeners(rendererObservationChannel);
    ipcMain.removeAllListeners(rendererReadyChannel);
    if (!ownerWindow.isDestroyed()) {
      ownerWindow.destroy();
    }
    await Promise.all([
      closeServer(workspaceAppServer),
      closeServer(popupServer)
    ]);
  }
}

function createWorkspaceAppTestServer(
  popupOrigin: string,
  rendererPath: string
): Server {
  return createServer((request, response) => {
    const origin = `http://${request.headers.host}`;
    if (request.url === "/host") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(`<!doctype html>
        <div id="root"></div>
        <script>require(${JSON.stringify(rendererPath)});</script>
        <webview
          allowpopups
          data-browser-node-webview="true"
          partition="${workspaceAppPartition}"
          src="${origin}/guest"
        ></webview>`);
      return;
    }
    if (request.url === "/guest") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(`<!doctype html>
        <a id="internal-blank-link" href="${origin}/internal?kind=blank-link" target="_blank">open internal</a>
        <a id="blank-link" href="${popupOrigin}/popup?kind=blank-link" target="_blank">open</a>
        <form id="get-form" action="${popupOrigin}/popup" method="get" target="_blank">
          <input name="kind" value="get-form" />
        </form>
        <form id="post-form" action="${popupOrigin}/popup" method="post" target="_blank">
          <input name="kind" value="post-form" />
        </form>`);
      return;
    }
    if (request.url?.startsWith("/internal?")) {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end("<!doctype html><title>internal popup target</title>");
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });
}

function createPopupTargetServer(): Server {
  return createServer((_request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end("<!doctype html><title>popup target</title>");
  });
}

async function listenOnLoopback(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function waitForGuestAttachment(contents: WebContents): Promise<WebContents> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("timed out waiting for Electron webview attachment"));
    }, 10_000);
    contents.once("did-attach-webview", (_event, guestContents) => {
      clearTimeout(timeout);
      resolve(guestContents);
    });
  });
}

function waitForRendererReady(contents: WebContents): Promise<void> {
  return new Promise((resolve, reject) => {
    const handleReady = (event: Electron.IpcMainEvent) => {
      if (event.sender.id !== contents.id) {
        return;
      }
      clearTimeout(timeout);
      ipcMain.removeListener(rendererReadyChannel, handleReady);
      resolve();
    };
    const timeout = setTimeout(() => {
      ipcMain.removeListener(rendererReadyChannel, handleReady);
      reject(new Error("timed out waiting for popup fixture renderer"));
    }, 10_000);
    ipcMain.on(rendererReadyChannel, handleReady);
  });
}

async function triggerPopup(input: {
  counts: {
    browserEvents: number;
    browserSurfaces: number;
    deferredPopupRejections: number;
    nativeChildWindows: number;
    postPopupRejections: number;
    producerCallbacks: number;
    rejectionNotifications: number;
    workbenchLaunches: number;
  };
  expectedBrowserEvents: number;
  expectedDeferredPopupRejections?: number;
  expectedGuestUrl?: string;
  expectedPostPopupRejections: number;
  expectedProducerCallbacks: number;
  expectedRejectionNotifications: number;
  guestContents: WebContents;
  kind: string;
  script: string;
}) {
  const before = { ...input.counts };
  const beforeGuestUrl = input.guestContents.getURL();
  const expectedDeferredPopupRejections =
    input.expectedDeferredPopupRejections ?? 0;
  const expectedGuestUrl = input.expectedGuestUrl ?? beforeGuestUrl;
  const scriptResult = await input.guestContents.executeJavaScript(
    input.script,
    true
  );
  await waitForCondition(
    () =>
      input.counts.browserEvents ===
        before.browserEvents + input.expectedBrowserEvents &&
      input.counts.browserSurfaces ===
        before.browserSurfaces + input.expectedBrowserEvents &&
      input.counts.deferredPopupRejections ===
        before.deferredPopupRejections + expectedDeferredPopupRejections &&
      input.counts.workbenchLaunches ===
        before.workbenchLaunches + input.expectedBrowserEvents &&
      input.counts.postPopupRejections ===
        before.postPopupRejections + input.expectedPostPopupRejections &&
      input.counts.producerCallbacks ===
        before.producerCallbacks + input.expectedProducerCallbacks &&
      input.counts.rejectionNotifications ===
        before.rejectionNotifications + input.expectedRejectionNotifications &&
      input.guestContents.getURL() === expectedGuestUrl &&
      !input.guestContents.isLoading(),
    () =>
      JSON.stringify({
        actual: input.counts,
        before,
        expected: {
          browserEvents: input.expectedBrowserEvents,
          deferredPopupRejections: expectedDeferredPopupRejections,
          guestUrl: expectedGuestUrl,
          postPopupRejections: input.expectedPostPopupRejections,
          producerCallbacks: input.expectedProducerCallbacks,
          rejectionNotifications: input.expectedRejectionNotifications
        },
        kind: input.kind
      })
  );
  return {
    browserEvents: input.counts.browserEvents - before.browserEvents,
    browserSurfaces: input.counts.browserSurfaces - before.browserSurfaces,
    deferredPopupRejections:
      input.counts.deferredPopupRejections - before.deferredPopupRejections,
    guestUrl: input.guestContents.getURL(),
    kind: input.kind,
    nativeChildWindows:
      input.counts.nativeChildWindows - before.nativeChildWindows,
    postPopupRejections:
      input.counts.postPopupRejections - before.postPopupRejections,
    producerCallbacks:
      input.counts.producerCallbacks - before.producerCallbacks,
    rejectionNotifications:
      input.counts.rejectionNotifications - before.rejectionNotifications,
    scriptResult,
    workbenchLaunches: input.counts.workbenchLaunches - before.workbenchLaunches
  };
}

async function waitForCondition(
  condition: () => boolean,
  describe: () => string = () => ""
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out waiting for Workspace App popup event ${describe()}`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}
