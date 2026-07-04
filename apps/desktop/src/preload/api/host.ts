import { desktopIpcChannels } from "../../shared/contracts/ipc";
import type { DesktopHostApi } from "../types";
import { invokeDesktopApi } from "./invoke";
import { ipcRenderer, type IpcRendererEvent } from "electron";

export function createHostDesktopApi(): DesktopHostApi {
  return {
    files: {
      createUserDocumentsProjectDirectory(input) {
        return invokeDesktopApi(
          desktopIpcChannels.host.files.createUserDocumentsProjectDirectory,
          input
        );
      },
      selectAppArchive() {
        return invokeDesktopApi(desktopIpcChannels.host.files.selectAppArchive);
      },
      selectAppArchiveExportPath(input) {
        return invokeDesktopApi(
          desktopIpcChannels.host.files.selectAppArchiveExportPath,
          input
        );
      },
      selectAppIconImage() {
        return invokeDesktopApi(
          desktopIpcChannels.host.files.selectAppIconImage
        );
      },
      selectDirectory() {
        return invokeDesktopApi(desktopIpcChannels.host.files.selectDirectory);
      },
      openExternal(url: string): Promise<void> {
        return invokeDesktopApi(
          desktopIpcChannels.host.files.openExternal,
          url
        );
      },
      openFile(workspaceID: string, path: string): Promise<void> {
        return invokeDesktopApi(desktopIpcChannels.host.files.openFile, {
          path,
          workspaceID
        });
      },
      listOpenWithApplications(workspaceID: string, path: string) {
        return invokeDesktopApi(
          desktopIpcChannels.host.files.listOpenWithApplications,
          {
            path,
            workspaceID
          }
        );
      },
      openFileWithApplication(
        workspaceID: string,
        path: string,
        applicationPath: string
      ): Promise<void> {
        return invokeDesktopApi(
          desktopIpcChannels.host.files.openFileWithApplication,
          {
            applicationPath,
            path,
            workspaceID
          }
        );
      },
      openFileWithOtherApplication(
        workspaceID: string,
        path: string,
        applicationPickerPrompt?: string
      ): Promise<void> {
        return invokeDesktopApi(
          desktopIpcChannels.host.files.openFileWithOtherApplication,
          {
            applicationPickerPrompt,
            path,
            workspaceID
          }
        );
      },
      openFileInBrowser(workspaceID: string, path: string): Promise<void> {
        return invokeDesktopApi(
          desktopIpcChannels.host.files.openFileInBrowser,
          {
            path,
            workspaceID
          }
        );
      },
      resolveWorkspaceFileFileUrl(
        workspaceID: string,
        path: string
      ): Promise<string> {
        return invokeDesktopApi(
          desktopIpcChannels.host.files.resolveWorkspaceFileFileUrl,
          {
            path,
            workspaceID
          }
        );
      },
      revealInFolder(path: string): Promise<void> {
        return invokeDesktopApi(
          desktopIpcChannels.host.files.revealInFolder,
          path
        );
      },
      revealWorkspaceFile(workspaceID: string, path: string): Promise<void> {
        return invokeDesktopApi(
          desktopIpcChannels.host.files.revealWorkspaceFile,
          {
            path,
            workspaceID
          }
        );
      },
      openTerminalLink(input): Promise<void> {
        return invokeDesktopApi(
          desktopIpcChannels.host.files.openTerminalLink,
          input
        );
      },
      readLocalFileText(path: string) {
        return invokeDesktopApi(
          desktopIpcChannels.host.files.readLocalFileText,
          path
        );
      },
      readLocalPreviewFile(path: string): Promise<Uint8Array> {
        return invokeDesktopApi(
          desktopIpcChannels.host.files.readLocalPreviewFile,
          path
        );
      },
      archiveAgentPromptFile(input) {
        return invokeDesktopApi(
          desktopIpcChannels.host.files.archiveAgentPromptFile,
          input
        );
      },
      readPreviewFile(workspaceID: string, path: string): Promise<Uint8Array> {
        return invokeDesktopApi(desktopIpcChannels.host.files.readPreviewFile, {
          path,
          workspaceID
        });
      },
      resolveEntryIcon(
        workspaceID: string,
        entry: {
          kind: string;
          mtimeMs: number | null;
          name: string;
          path: string;
        }
      ): Promise<string | null> {
        return invokeDesktopApi(
          desktopIpcChannels.host.files.resolveEntryIcon,
          {
            entryKind: entry.kind,
            entryMtimeMs: entry.mtimeMs,
            entryName: entry.name,
            path: entry.path,
            workspaceID
          }
        );
      },
      selectUploadFiles(input): Promise<string[]> {
        return invokeDesktopApi(
          desktopIpcChannels.host.files.selectUploadFiles,
          input
        );
      },
      copyImageToClipboard(input): Promise<void> {
        return invokeDesktopApi(
          desktopIpcChannels.host.files.copyImageToClipboard,
          input
        );
      },
      copyFilesToClipboard(paths: string[]): Promise<void> {
        return invokeDesktopApi(
          desktopIpcChannels.host.files.copyFilesToClipboard,
          paths
        );
      }
    },
    window: {
      approveClose(): Promise<void> {
        return invokeDesktopApi(desktopIpcChannels.host.window.approveClose);
      },
      capturePreview(input): Promise<string | null> {
        return invokeDesktopApi(
          desktopIpcChannels.host.window.capturePreview,
          input
        );
      },
      onCloseRequest(listener): () => void {
        const handler = (
          _event: Electron.IpcRendererEvent,
          payload?: { reason?: unknown; requestId?: unknown }
        ) =>
          listener({
            requestId:
              typeof payload?.requestId === "string"
                ? payload.requestId
                : undefined,
            reason: payload?.reason === "quit" ? "quit" : "window-close"
          });
        ipcRenderer.on(desktopIpcChannels.host.window.closeRequest, handler);
        return () => {
          ipcRenderer.removeListener(
            desktopIpcChannels.host.window.closeRequest,
            handler
          );
        };
      },
      onQuitShortcutToast(listener): () => void {
        const handler = () => {
          listener();
        };
        ipcRenderer.on(
          desktopIpcChannels.host.window.quitShortcutToast,
          handler
        );
        return () => {
          ipcRenderer.removeListener(
            desktopIpcChannels.host.window.quitShortcutToast,
            handler
          );
        };
      },
      resolveCloseRequest(payload): void {
        ipcRenderer.send(
          desktopIpcChannels.host.window.closeRequestResolved,
          payload
        );
      }
    },
    notifications: {
      show(input) {
        return invokeDesktopApi(
          desktopIpcChannels.host.notifications.show,
          input
        );
      },
      onNavigate(listener): () => void {
        const handler = (_event: IpcRendererEvent, payload: unknown) =>
          listener(payload as Parameters<typeof listener>[0]);
        ipcRenderer.on(desktopIpcChannels.host.notifications.navigate, handler);
        return () => {
          ipcRenderer.removeListener(
            desktopIpcChannels.host.notifications.navigate,
            handler
          );
        };
      }
    },
    workspace: {
      broadcastAgentStatus(payload: { agentBound: boolean }): void {
        ipcRenderer.send(
          desktopIpcChannels.appContext.agentStatusBroadcast,
          payload
        );
      },
      onOpenFeatureRequest(listener): () => void {
        const handler = (_event: IpcRendererEvent, payload: unknown) =>
          listener(payload as Parameters<typeof listener>[0]);
        ipcRenderer.on(
          desktopIpcChannels.appContext.openFeatureRequested,
          handler
        );
        return () => {
          ipcRenderer.removeListener(
            desktopIpcChannels.appContext.openFeatureRequested,
            handler
          );
        };
      },
      onOpenFileRequest(listener): () => void {
        const handler = (_event: IpcRendererEvent, payload: unknown) =>
          listener(payload as Parameters<typeof listener>[0]);
        ipcRenderer.on(
          desktopIpcChannels.appContext.openFileRequested,
          handler
        );
        return () => {
          ipcRenderer.removeListener(
            desktopIpcChannels.appContext.openFileRequested,
            handler
          );
        };
      },
      openWorkspaceAppFolder(input): Promise<void> {
        return invokeDesktopApi(
          desktopIpcChannels.host.workspace.openWorkspaceAppFolder,
          input
        );
      },
      showWorkspace(workspaceID: string): Promise<void> {
        return invokeDesktopApi(
          desktopIpcChannels.host.workspace.showWorkspace,
          workspaceID
        );
      }
    }
  };
}
