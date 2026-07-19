import type { BrowserNodeHostApi } from "../core/types.ts";
import type { BrowserNodeElectronMainChannels } from "../electron-main/registerElectronMain.ts";

export interface BrowserNodeElectronRendererTransport {
  invoke<TResult>(channel: string, payload: unknown): Promise<TResult>;
  on(
    channel: string,
    listener: (event: unknown, payload: unknown) => void
  ): void;
  removeListener(
    channel: string,
    listener: (event: unknown, payload: unknown) => void
  ): void;
}

export function createBrowserNodeElectronRendererApi(input: {
  channels: BrowserNodeElectronMainChannels;
  transport: BrowserNodeElectronRendererTransport;
}): BrowserNodeHostApi {
  const { channels, transport } = input;
  const invoke = <TResult>(channel: string, payload: unknown) =>
    transport.invoke<TResult>(channel, payload);

  return {
    activate: (payload) => invoke<void>(channels.activate, payload),
    ...(channels.capturePreview
      ? {
          capturePreview: (payload) =>
            invoke<string | null>(channels.capturePreview!, payload)
        }
      : {}),
    ...(channels.chooseDownloadDirectory
      ? {
          chooseDownloadDirectory: (payload) =>
            invoke(channels.chooseDownloadDirectory!, payload)
        }
      : {}),
    ...(channels.clearBrowsingData
      ? {
          clearBrowsingData: (payload) =>
            invoke<void>(channels.clearBrowsingData!, payload)
        }
      : {}),
    ...(channels.cancelChromeCookieImport
      ? {
          cancelChromeCookieImport: (payload) =>
            invoke<void>(channels.cancelChromeCookieImport!, payload)
        }
      : {}),
    close: (payload) => invoke<void>(channels.close, payload),
    ...(channels.discoverChromeCookieProfiles
      ? {
          discoverChromeCookieProfiles: () =>
            invoke(channels.discoverChromeCookieProfiles!, undefined)
        }
      : {}),
    ...(channels.findInPage
      ? {
          findInPage: (payload) => invoke<void>(channels.findInPage!, payload)
        }
      : {}),
    ...(channels.importCookies
      ? {
          importCookies: (payload) => invoke(channels.importCookies!, payload)
        }
      : {}),
    ...(channels.importChromeCookies
      ? {
          importChromeCookies: (payload) =>
            invoke(channels.importChromeCookies!, payload)
        }
      : {}),
    goBack: (payload) => invoke<void>(channels.goBack, payload),
    goForward: (payload) => invoke<void>(channels.goForward, payload),
    navigate: (payload) => invoke<void>(channels.navigate, payload),
    onEvent(listener) {
      const handler = (_event: unknown, payload: unknown): void => {
        listener(payload as Parameters<typeof listener>[0]);
      };
      transport.on(channels.event, handler);
      return () => transport.removeListener(channels.event, handler);
    },
    ...(channels.openDevTools
      ? {
          openDevTools: (payload) =>
            invoke<void>(channels.openDevTools!, payload)
        }
      : {}),
    ...(channels.openExternal
      ? {
          openExternal: (payload) =>
            invoke<void>(channels.openExternal!, payload)
        }
      : {}),
    ...(channels.performDownloadAction
      ? {
          performDownloadAction: (payload) =>
            invoke<void>(channels.performDownloadAction!, payload)
        }
      : {}),
    prepareSession: (payload) => invoke<void>(channels.prepareSession, payload),
    ...(channels.printPage
      ? {
          printPage: (payload) => invoke<void>(channels.printPage!, payload)
        }
      : {}),
    registerGuest: (payload) => invoke<void>(channels.registerGuest, payload),
    reload: (payload) => invoke<void>(channels.reload, payload),
    ...(channels.saveScreenshot
      ? {
          saveScreenshot: (payload) => invoke(channels.saveScreenshot!, payload)
        }
      : {}),
    ...(channels.setDeviceEmulation
      ? {
          setDeviceEmulation: (payload) =>
            invoke<void>(channels.setDeviceEmulation!, payload)
        }
      : {}),
    ...(channels.setZoomFactor
      ? {
          setZoomFactor: (payload) =>
            invoke<void>(channels.setZoomFactor!, payload)
        }
      : {}),
    ...(channels.showDevToolsContextMenu
      ? {
          showDevToolsContextMenu: (payload) =>
            invoke<void>(channels.showDevToolsContextMenu!, payload)
        }
      : {}),
    ...(channels.stopFindInPage
      ? {
          stopFindInPage: (payload) =>
            invoke<void>(channels.stopFindInPage!, payload)
        }
      : {}),
    unregisterGuest: (payload) =>
      invoke<void>(channels.unregisterGuest, payload)
  };
}
