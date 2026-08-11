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

const resultPrefix = "WORKSPACE_APP_POPUP_INTEGRATION=";
const rendererAckChannel = "workspace-app-popup-test:browser-event";
const workspaceAppDiagnosticChannel = "workspace-app-context:diagnostic";
const workspaceAppPartition = "persist:tutti-app:popup-integration";

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
  if (!preloadPath) {
    throw new Error("Workspace App popup fixture requires a preload path");
  }
  const popupServer = createPopupTargetServer();
  const popupOrigin = await listenOnLoopback(popupServer);
  const workspaceAppServer = createWorkspaceAppTestServer(popupOrigin);
  const workspaceAppOrigin = await listenOnLoopback(workspaceAppServer);
  const counts = {
    browserEvents: 0,
    nativeChildWindows: 0,
    postPopupRejections: 0,
    producerCallbacks: 0
  };
  const events: unknown[] = [];
  const preload = {
    delegatedCrossOriginLinks: 0,
    installed: false
  };
  const mainHandlers = new Map<string, FixtureMainHandler>();
  let attachedGuestContents: WebContents | null = null;
  const logger: DesktopLogger = {
    async close() {},
    debug() {},
    error() {},
    info(message) {
      if (message === "workspace app emitted open-url") {
        counts.producerCallbacks += 1;
      }
    },
    warn(message) {
      if (message === "workspace app guest rejected POST popup") {
        counts.postPopupRejections += 1;
        counts.producerCallbacks += 1;
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
  ipcMain.on(workspaceAppDiagnosticChannel, (_event, payload) => {
    if (payload?.event !== "workspace-app-link-interception") {
      return;
    }
    if (payload.action === "installed") {
      preload.installed = true;
    } else if (payload.action === "delegate-window-open") {
      preload.delegatedCrossOriginLinks += 1;
    }
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
    await ownerWindow.loadURL(`${workspaceAppOrigin}/host`);
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
        expectBrowserEvent: true,
        guestContents,
        kind: "blank-link",
        script: "document.querySelector('#blank-link').click(); true"
      })
    );
    cases.push(
      await triggerPopup({
        counts,
        expectBrowserEvent: true,
        guestContents,
        kind: "window-open",
        script: `void window.open(${JSON.stringify(`${popupOrigin}/popup?kind=window-open`)}, '_blank'); true`
      })
    );
    cases.push(
      await triggerPopup({
        counts,
        expectBrowserEvent: true,
        guestContents,
        kind: "get-form",
        script: "document.querySelector('#get-form').requestSubmit(); true"
      })
    );
    cases.push(
      await triggerPopup({
        counts,
        expectBrowserEvent: false,
        guestContents,
        kind: "post-form",
        script: "document.querySelector('#post-form').requestSubmit(); true"
      })
    );

    return {
      cases,
      counts,
      events,
      origins: { popup: popupOrigin, workspaceApp: workspaceAppOrigin },
      preload
    };
  } finally {
    cleanupWebviewSecurity();
    ipcMain.removeAllListeners(rendererAckChannel);
    ipcMain.removeAllListeners(workspaceAppDiagnosticChannel);
    if (!ownerWindow.isDestroyed()) {
      ownerWindow.destroy();
    }
    await Promise.all([
      closeServer(workspaceAppServer),
      closeServer(popupServer)
    ]);
  }
}

function createWorkspaceAppTestServer(popupOrigin: string): Server {
  return createServer((request, response) => {
    const origin = `http://${request.headers.host}`;
    if (request.url === "/host") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(`<!doctype html>
        <script>
          const { ipcRenderer } = require("electron");
          ipcRenderer.on(${JSON.stringify(desktopIpcChannels.browser.event)}, (_event, payload) => {
            ipcRenderer.send(${JSON.stringify(rendererAckChannel)}, payload);
          });
        </script>
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
        <a id="blank-link" href="${popupOrigin}/popup?kind=blank-link" target="_blank">open</a>
        <form id="get-form" action="${popupOrigin}/popup" method="get" target="_blank">
          <input name="kind" value="get-form" />
        </form>
        <form id="post-form" action="${popupOrigin}/popup" method="post" target="_blank">
          <input name="kind" value="post-form" />
        </form>`);
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

async function triggerPopup(input: {
  counts: {
    browserEvents: number;
    nativeChildWindows: number;
    postPopupRejections: number;
    producerCallbacks: number;
  };
  expectBrowserEvent: boolean;
  guestContents: WebContents;
  kind: string;
  script: string;
}) {
  const before = { ...input.counts };
  await input.guestContents.executeJavaScript(input.script, true);
  if (input.expectBrowserEvent) {
    await waitForCondition(
      () => input.counts.browserEvents === before.browserEvents + 1
    );
  } else {
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return {
    browserEvents: input.counts.browserEvents - before.browserEvents,
    kind: input.kind,
    nativeChildWindows:
      input.counts.nativeChildWindows - before.nativeChildWindows,
    postPopupRejections:
      input.counts.postPopupRejections - before.postPopupRejections,
    producerCallbacks: input.counts.producerCallbacks - before.producerCallbacks
  };
}

async function waitForCondition(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for Workspace App popup event");
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
