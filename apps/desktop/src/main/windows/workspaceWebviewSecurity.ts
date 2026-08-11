import type { BrowserWindow, WebContents } from "electron";
import {
  installBrowserWebviewSecurity,
  isBrowserNodeWebviewAttach,
  type BrowserNodeElectronLogger,
  type BrowserWebviewGuestAttachment
} from "@tutti-os/browser-node/electron-main";

export const workspaceAppBrowserPartitionPrefix = "persist:tutti-app:";

interface WorkspaceWindowWebviewSecurityRuntime {
  openExternal(url: string): Promise<void> | void;
  registerBrowserGuest(
    ownerWindow: BrowserWindow,
    guestContents: WebContents
  ): void;
  registerWorkspaceAppAssetProtocol(partition: string): void;
  registerWorkspaceAppGuest(
    ownerWindow: BrowserWindow,
    guestContents: WebContents,
    partition: string
  ): BrowserWebviewGuestAttachment;
}

export function installWorkspaceWindowWebviewSecurity(input: {
  browserNodeGuestPreloadPath?: string;
  contents: WebContents;
  logger?: BrowserNodeElectronLogger;
  ownerWindow: BrowserWindow;
  runtime: WorkspaceWindowWebviewSecurityRuntime;
  workspaceAppPreloadPath?: string;
}): () => void {
  return installBrowserWebviewSecurity({
    allowedSessionPartitions: {
      additionalAllowedPrefixes: [workspaceAppBrowserPartitionPrefix]
    },
    contents: input.contents,
    logger: input.logger,
    openExternal: input.runtime.openExternal,
    resolveGuestAttachment(guestContents, { params }) {
      input.runtime.registerBrowserGuest(input.ownerWindow, guestContents);
      const partition = params.partition;
      if (!isWorkspaceAppSessionPartition(partition)) {
        return undefined;
      }
      return input.runtime.registerWorkspaceAppGuest(
        input.ownerWindow,
        guestContents,
        partition
      );
    },
    resolvePreload({ params }) {
      const partition = params.partition;
      if (
        input.workspaceAppPreloadPath &&
        isWorkspaceAppSessionPartition(partition)
      ) {
        input.runtime.registerWorkspaceAppAssetProtocol(partition);
        input.logger?.info?.("applying workspace app guest preload", {
          partition,
          preloadPath: input.workspaceAppPreloadPath,
          src: params.src ?? null
        });
        return input.workspaceAppPreloadPath;
      }
      if (
        input.browserNodeGuestPreloadPath &&
        isBrowserNodeWebviewAttach(params, {
          additionalAllowedPrefixes: [workspaceAppBrowserPartitionPrefix]
        }) &&
        !isWorkspaceAppSessionPartition(partition)
      ) {
        input.logger?.info?.("applying browser node guest preload", {
          partition: partition ?? null,
          preloadPath: input.browserNodeGuestPreloadPath,
          src: params.src ?? null
        });
        return input.browserNodeGuestPreloadPath;
      }
      return null;
    }
  });
}

function isWorkspaceAppSessionPartition(
  partition: string | undefined
): partition is string {
  return (partition ?? "").startsWith(workspaceAppBrowserPartitionPrefix);
}
