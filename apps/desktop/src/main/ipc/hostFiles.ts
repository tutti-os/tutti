import {
  desktopIpcChannels,
  type DesktopClipboardImagePayload,
  type DesktopCreateUserDocumentsProjectDirectoryInput,
  type DesktopTerminalLinkPathPayload,
  type DesktopWorkspaceFileEntryIconPayload,
  type DesktopWorkspaceFilePathPayload
} from "../../shared/contracts/ipc";
import { app, shell } from "electron";
import {
  writeFilesToSystemClipboard,
  writeImageToSystemClipboard
} from "../host/clipboardFiles.ts";
import type { DesktopFileDialogAccess } from "../host/desktopFileDialogAccess";
import { createWorkspaceFileHostAccess } from "../host/workspaceFileHostAccess.ts";
import type { WorkspaceFileIconCacheStore } from "../host/workspaceFileIconCacheStore.ts";
import { registerDesktopIpcHandler } from "./handle";
import { resolveOwnerWindowFromEvent } from "./ownerWindow";

export interface HostFilesIpcDependencies {
  fileDialogs: Pick<
    DesktopFileDialogAccess,
    | "selectAppArchive"
    | "selectAppArchiveExportPath"
    | "selectAppIconImage"
    | "selectDirectory"
    | "selectUploadFiles"
  >;
  workspaceFileIconCache?: WorkspaceFileIconCacheStore;
}

export function registerHostFilesIpc(deps: HostFilesIpcDependencies): void {
  const hostAccess = createWorkspaceFileHostAccess({
    getDocumentsPath: () => app.getPath("documents"),
    workspaceFileIconCache: deps.workspaceFileIconCache
  });

  registerDesktopIpcHandler(
    desktopIpcChannels.host.files.createUserDocumentsProjectDirectory,
    (_event, payload: DesktopCreateUserDocumentsProjectDirectoryInput) =>
      hostAccess.createUserDocumentsProjectDirectory(payload)
  );

  registerDesktopIpcHandler(
    desktopIpcChannels.host.files.openFile,
    (_event, payload: DesktopWorkspaceFilePathPayload) =>
      hostAccess.openFile(payload)
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.host.files.listOpenWithApplications,
    (_event, payload: DesktopWorkspaceFilePathPayload) =>
      hostAccess.listOpenWithApplications(payload)
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.host.files.openFileWithApplication,
    (
      _event,
      payload: DesktopWorkspaceFilePathPayload & { applicationPath: string }
    ) => hostAccess.openFileWithApplication(payload)
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.host.files.openFileWithOtherApplication,
    (
      _event,
      payload: DesktopWorkspaceFilePathPayload & {
        applicationPickerPrompt?: string;
      }
    ) => hostAccess.openFileWithOtherApplication(payload)
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.host.files.openFileInBrowser,
    (_event, payload: DesktopWorkspaceFilePathPayload) =>
      hostAccess.openFileInBrowser(payload)
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.host.files.resolveWorkspaceFileFileUrl,
    (_event, payload: DesktopWorkspaceFilePathPayload) =>
      hostAccess.resolveWorkspaceFileFileUrl(payload)
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.host.files.revealInFolder,
    (_event, payload: string) => shell.showItemInFolder(payload)
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.host.files.revealWorkspaceFile,
    (_event, payload: DesktopWorkspaceFilePathPayload) =>
      hostAccess.revealWorkspaceFile(payload)
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.host.files.openTerminalLink,
    (_event, payload: DesktopTerminalLinkPathPayload) =>
      hostAccess.openTerminalLink(payload)
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.host.files.openExternal,
    (_event, payload: string) => hostAccess.openExternal(payload)
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.host.files.readLocalFileText,
    (_event, payload: string) => hostAccess.readLocalFileText(payload)
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.host.files.readLocalPreviewFile,
    (_event, payload: string) => hostAccess.readLocalPreviewFile(payload)
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.host.files.readPreviewFile,
    (_event, payload: DesktopWorkspaceFilePathPayload) =>
      hostAccess.readPreviewFile(payload)
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.host.files.resolveEntryIcon,
    (_event, payload: DesktopWorkspaceFileEntryIconPayload) =>
      hostAccess.resolveEntryIcon(payload)
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.host.files.selectDirectory,
    (event) =>
      deps.fileDialogs.selectDirectory(resolveOwnerWindowFromEvent(event))
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.host.files.selectAppArchive,
    (event) =>
      deps.fileDialogs.selectAppArchive(resolveOwnerWindowFromEvent(event))
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.host.files.selectAppArchiveExportPath,
    (event, payload) =>
      deps.fileDialogs.selectAppArchiveExportPath(
        payload.defaultPath,
        resolveOwnerWindowFromEvent(event)
      )
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.host.files.selectAppIconImage,
    (event) =>
      deps.fileDialogs.selectAppIconImage(resolveOwnerWindowFromEvent(event))
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.host.files.selectUploadFiles,
    (event, input) =>
      deps.fileDialogs.selectUploadFiles(
        resolveOwnerWindowFromEvent(event),
        input
      )
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.host.files.copyImageToClipboard,
    (_event, payload: DesktopClipboardImagePayload) => {
      writeImageToSystemClipboard(payload);
    }
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.host.files.copyFilesToClipboard,
    (_event, payload: string[]) => {
      writeFilesToSystemClipboard(payload);
    }
  );
}
