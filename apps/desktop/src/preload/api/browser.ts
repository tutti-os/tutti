import { ipcRenderer } from "electron";
import { createBrowserNodeElectronRendererApi } from "@tutti-os/browser-node/electron-renderer";
import {
  desktopIpcChannels,
  type DesktopInvokeChannel
} from "../../shared/contracts/ipc";
import { isDesktopDevelopmentRuntime } from "../../shared/runtimeEnvironment";
import type { DesktopBrowserApi } from "../types";
import { invokeDesktopApi } from "./invoke";

type BrowserInvokeChannel = Exclude<
  (typeof desktopIpcChannels.browser)[keyof typeof desktopIpcChannels.browser],
  | typeof desktopIpcChannels.browser.automationHostReady
  | typeof desktopIpcChannels.browser.automationRequest
  | typeof desktopIpcChannels.browser.automationResponse
  | typeof desktopIpcChannels.browser.event
> &
  DesktopInvokeChannel;

export function createBrowserDesktopApi(): DesktopBrowserApi {
  const browserApi = createBrowserNodeElectronRendererApi({
    channels: {
      ...desktopIpcChannels.browser,
      openDevTools: isBrowserDevToolsEnabled()
        ? desktopIpcChannels.browser.openDevTools
        : undefined,
      showDevToolsContextMenu: isBrowserDevToolsEnabled()
        ? desktopIpcChannels.browser.showDevToolsContextMenu
        : undefined
    },
    transport: {
      invoke: <TResult>(channel: string, payload: unknown) =>
        invokeDesktopApi(
          channel as BrowserInvokeChannel,
          payload as never
        ) as Promise<TResult>,
      on: (channel, listener) => ipcRenderer.on(channel, listener),
      removeListener: (channel, listener) =>
        ipcRenderer.removeListener(channel, listener)
    }
  });
  return {
    ...browserApi,
    announceAutomationHostReady(input) {
      ipcRenderer.send(desktopIpcChannels.browser.automationHostReady, input);
    },
    onAutomationRequest(listener) {
      const handleRequest = (
        _event: Electron.IpcRendererEvent,
        request: unknown
      ) => {
        listener(request as Parameters<typeof listener>[0]);
      };
      ipcRenderer.on(
        desktopIpcChannels.browser.automationRequest,
        handleRequest
      );
      return () =>
        ipcRenderer.removeListener(
          desktopIpcChannels.browser.automationRequest,
          handleRequest
        );
    },
    respondAutomationRequest(response) {
      ipcRenderer.send(desktopIpcChannels.browser.automationResponse, response);
    }
  };
}

function isBrowserDevToolsEnabled(): boolean {
  return isDesktopDevelopmentRuntime({
    tuttiEnv: process.env.TUTTI_ENV,
    nodeEnv: process.env.NODE_ENV
  });
}
