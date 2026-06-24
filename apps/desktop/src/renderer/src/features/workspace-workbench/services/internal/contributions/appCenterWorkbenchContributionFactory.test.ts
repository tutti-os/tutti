import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserNodeEvent } from "@tutti-os/browser-node";
import type { DesktopBrowserApi, DesktopRuntimeApi } from "@preload/types";
import {
  registerWorkspaceBrowserLaunchHandler,
  type WorkspaceBrowserLaunchRequest
} from "../../workspaceBrowserLaunchCoordinator.ts";
import { createWorkspaceAppBrowserFeature } from "./workspaceAppBrowserFeature.ts";
import { createWorkspaceBrowserService } from "../workspaceBrowserService.ts";

test("workspace app browser feature keeps browser events connected", async () => {
  const requests: WorkspaceBrowserLaunchRequest[] = [];
  let emitBrowserEvent = (_event: BrowserNodeEvent): void => undefined;
  const browserApi = createBrowserApi({
    onEvent(listener) {
      emitBrowserEvent = listener;
      return () => {
        emitBrowserEvent = () => undefined;
      };
    }
  });
  const feature = createWorkspaceAppBrowserFeature({
    browserApi,
    browserService: createWorkspaceBrowserService({ browserApi }),
    runtimeApi: createRuntimeApi(),
    workspaceId: "workspace-app-open-url"
  });
  const disposeLaunchHandler = registerWorkspaceBrowserLaunchHandler(
    "workspace-app-open-url",
    (request) => {
      requests.push(request);
      return true;
    }
  );

  emitBrowserEvent({
    reuseIfOpen: false,
    sourceNodeId: "workspace-app-webview:42",
    type: "open-url",
    url: "https://example.com/app-link"
  });
  await Promise.resolve();

  disposeLaunchHandler();
  assert.deepEqual(requests, [
    {
      reuseIfOpen: false,
      source: "workspace_app",
      url: "https://example.com/app-link",
      workspaceId: "workspace-app-open-url"
    }
  ]);

  emitBrowserEvent({
    code: "navigation-failed",
    diagnosticMessage: "ERR_CONNECTION_REFUSED",
    nodeId: "workspace-app-webview:42",
    type: "error"
  });
  assert.deepEqual(
    feature.runtimeStore.getNodeState("workspace-app-webview:42").error,
    {
      code: "navigation-failed",
      diagnosticMessage: "ERR_CONNECTION_REFUSED",
      params: undefined
    }
  );
});

test("workspace app browser feature launches workspace app window-open events", async () => {
  const requests: WorkspaceBrowserLaunchRequest[] = [];
  let emitBrowserEvent = (_event: BrowserNodeEvent): void => undefined;
  const browserApi = createBrowserApi({
    onEvent(listener) {
      emitBrowserEvent = listener;
      return () => {
        emitBrowserEvent = () => undefined;
      };
    }
  });
  createWorkspaceAppBrowserFeature({
    browserApi,
    browserService: createWorkspaceBrowserService({ browserApi }),
    runtimeApi: createRuntimeApi(),
    workspaceId: "workspace-app-window-open-url"
  });
  const disposeLaunchHandler = registerWorkspaceBrowserLaunchHandler(
    "workspace-app-window-open-url",
    (request) => {
      requests.push(request);
      return true;
    }
  );

  emitBrowserEvent({
    reuseIfOpen: false,
    sourceNodeId: "workspace-app:99",
    type: "open-url",
    url: "https://www.producthunt.com/products/vc-boom"
  });
  await Promise.resolve();

  disposeLaunchHandler();
  assert.deepEqual(requests, [
    {
      reuseIfOpen: false,
      source: "workspace_app",
      url: "https://www.producthunt.com/products/vc-boom",
      workspaceId: "workspace-app-window-open-url"
    }
  ]);
});

test("workspace app browser feature keeps current app runtime URLs inside the app webview", async () => {
  const requests: WorkspaceBrowserLaunchRequest[] = [];
  let emitBrowserEvent = (_event: BrowserNodeEvent): void => undefined;
  const browserApi = createBrowserApi({
    onEvent(listener) {
      emitBrowserEvent = listener;
      return () => {
        emitBrowserEvent = () => undefined;
      };
    }
  });
  createWorkspaceAppBrowserFeature({
    browserApi,
    browserService: createWorkspaceBrowserService({ browserApi }),
    getAppLaunchUrlForNodeId: (nodeId) =>
      nodeId === "workspace-app-webview:app:group-chat"
        ? "http://127.0.0.1:4173/"
        : null,
    runtimeApi: createRuntimeApi(),
    workspaceId: "workspace-app-runtime-open-url"
  });
  const disposeLaunchHandler = registerWorkspaceBrowserLaunchHandler(
    "workspace-app-runtime-open-url",
    (request) => {
      requests.push(request);
      return true;
    }
  );

  emitBrowserEvent({
    reuseIfOpen: true,
    sourceNodeId: "workspace-app-webview:app:group-chat",
    type: "open-url",
    url: "http://127.0.0.1:4173/rooms/123"
  });
  emitBrowserEvent({
    reuseIfOpen: true,
    sourceNodeId: "workspace-app-webview:app:group-chat",
    type: "open-url",
    url: "http://127.0.0.1:5678/local-preview"
  });
  await Promise.resolve();

  disposeLaunchHandler();
  assert.deepEqual(requests, [
    {
      reuseIfOpen: true,
      source: "workspace_app",
      url: "http://127.0.0.1:5678/local-preview",
      workspaceId: "workspace-app-runtime-open-url"
    }
  ]);
});

test("workspace app browser feature keeps dock entry runtime URLs inside the app webview", async () => {
  const requests: WorkspaceBrowserLaunchRequest[] = [];
  let emitBrowserEvent = (_event: BrowserNodeEvent): void => undefined;
  const browserApi = createBrowserApi({
    onEvent(listener) {
      emitBrowserEvent = listener;
      return () => {
        emitBrowserEvent = () => undefined;
      };
    }
  });
  createWorkspaceAppBrowserFeature({
    browserApi,
    browserService: createWorkspaceBrowserService({ browserApi }),
    getAppLaunchUrlForNodeId: (nodeId) =>
      nodeId === "workspace-app:group-chat" ? "http://127.0.0.1:4173/" : null,
    runtimeApi: createRuntimeApi(),
    workspaceId: "workspace-app-dock-entry-open-url"
  });
  const disposeLaunchHandler = registerWorkspaceBrowserLaunchHandler(
    "workspace-app-dock-entry-open-url",
    (request) => {
      requests.push(request);
      return true;
    }
  );

  emitBrowserEvent({
    reuseIfOpen: true,
    sourceNodeId: "workspace-app:group-chat",
    type: "open-url",
    url: "http://127.0.0.1:4173/rooms/123"
  });
  await Promise.resolve();

  disposeLaunchHandler();
  assert.deepEqual(requests, []);
});

test("workspace app browser feature ignores workspace browser open-url events", async () => {
  const requests: WorkspaceBrowserLaunchRequest[] = [];
  let emitBrowserEvent = (_event: BrowserNodeEvent): void => undefined;
  const browserApi = createBrowserApi({
    onEvent(listener) {
      emitBrowserEvent = listener;
      return () => {
        emitBrowserEvent = () => undefined;
      };
    }
  });
  createWorkspaceAppBrowserFeature({
    browserApi,
    browserService: createWorkspaceBrowserService({ browserApi }),
    runtimeApi: createRuntimeApi(),
    workspaceId: "workspace-app-ignored-browser-open-url"
  });
  const disposeLaunchHandler = registerWorkspaceBrowserLaunchHandler(
    "workspace-app-ignored-browser-open-url",
    (request) => {
      requests.push(request);
      return true;
    }
  );

  emitBrowserEvent({
    reuseIfOpen: false,
    sourceNodeId: "browser:browser-1",
    type: "open-url",
    url: "https://example.com/browser-popup"
  });
  await Promise.resolve();

  disposeLaunchHandler();
  assert.deepEqual(requests, []);
});

function createBrowserApi(
  overrides: Partial<DesktopBrowserApi> = {}
): DesktopBrowserApi {
  return {
    activate: async () => undefined,
    capturePreview: async () => null,
    close: async () => undefined,
    goBack: async () => undefined,
    goForward: async () => undefined,
    navigate: async () => undefined,
    onEvent: () => () => undefined,
    openExternal: async () => undefined,
    prepareSession: async () => undefined,
    registerGuest: async () => undefined,
    reload: async () => undefined,
    unregisterGuest: async () => undefined,
    ...overrides
  };
}

function createRuntimeApi(): Pick<DesktopRuntimeApi, "logRendererDiagnostic"> {
  return {
    logRendererDiagnostic: async () => undefined
  };
}
