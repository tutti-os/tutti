import type {
  WorkspaceFileDirectoryListing,
  WorkspaceFileActivationTarget,
  WorkspaceFileEntry,
  WorkspaceFileManagerFileActivationRequest,
  WorkspaceFileManagerHost,
  WorkspaceFileManagerHostActionResult,
  WorkspaceFileManagerHostFileActivationResult,
  WorkspaceFileSearchResult
} from "@tutti-os/workspace-file-manager/services";
import { requestWorkspaceBrowserHostFileLaunch } from "../../../workspace-workbench/services/workspaceBrowserLaunchCoordinator.ts";
import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import { resolveDesktopErrorMessage } from "../../../../lib/desktopErrors.ts";
import type { DesktopLocale } from "../../../../../../shared/i18n/index.ts";
import { extractDesktopDroppedPaths } from "../desktopDroppedPaths.ts";
import type { WorkspaceFileManagerServiceDependencies } from "./workspaceFileManagerService.ts";

interface DesktopWorkspaceFileManagerAdapterDependencies extends WorkspaceFileManagerServiceDependencies {
  notifyPreviewUnsupportedFallback(): void;
  notifyRevealFailed(message: string): void;
  reportFileCreated?(): void;
  reportFileOpened?(): void;
}

export function createDesktopWorkspaceFileManagerAdapter(
  dependencies: DesktopWorkspaceFileManagerAdapterDependencies,
  getLocale: () => DesktopLocale,
  canvasPreview?: {
    openCanvasPreview(
      target: WorkspaceFileActivationTarget,
      workspaceID: string
    ): Promise<boolean>;
  }
): WorkspaceFileManagerHost {
  const hostFilesApi = dependencies.hostFilesApi;
  const tuttidClient = dependencies.tuttidClient;
  const platformApi = dependencies.platformApi;

  return {
    async createDirectory(input): Promise<WorkspaceFileEntry> {
      const response = await tuttidClient.createWorkspaceFileDirectory(
        input.workspaceID,
        input.path
      );
      return fileEntryFromDesktop(response.entry);
    },
    async createFile(input): Promise<WorkspaceFileEntry> {
      const response = await tuttidClient.createWorkspaceFile(
        input.workspaceID,
        input.path
      );
      dependencies.reportFileCreated?.();
      return fileEntryFromDesktop(response.entry);
    },
    async deleteEntry(input): Promise<void> {
      await tuttidClient.deleteWorkspaceFileEntry(input.workspaceID, {
        kind: input.kind,
        path: input.path
      });
    },
    async moveEntry(input): Promise<WorkspaceFileEntry> {
      const response = await tuttidClient.moveWorkspaceFileEntry(
        input.workspaceID,
        {
          path: input.path,
          targetDirectoryPath: input.targetDirectoryPath
        }
      );
      return fileEntryFromDesktop(response.entry);
    },
    async renameEntry(input): Promise<WorkspaceFileEntry> {
      const response = await tuttidClient.renameWorkspaceFileEntry(
        input.workspaceID,
        {
          newName: input.newName,
          path: input.path
        }
      );
      return fileEntryFromDesktop(response.entry);
    },
    async copyEntriesToClipboard(input): Promise<void> {
      await hostFilesApi.copyFilesToClipboard(input.paths);
    },
    async listOpenWithApplications(input) {
      return hostFilesApi.listOpenWithApplications(
        input.workspaceID,
        input.path
      );
    },
    async openFileWithApplication(input): Promise<void> {
      await hostFilesApi.openFileWithApplication(
        input.workspaceID,
        input.path,
        input.applicationPath
      );
    },
    async openFileWithOtherApplication(input): Promise<void> {
      await hostFilesApi.openFileWithOtherApplication(
        input.workspaceID,
        input.path,
        input.applicationPickerPrompt
      );
    },
    async openFileInAppBrowser(input): Promise<void> {
      const fileUrl = await hostFilesApi.resolveWorkspaceFileFileUrl(
        input.workspaceID,
        input.path
      );
      const launched = await requestWorkspaceBrowserHostFileLaunch({
        url: fileUrl,
        workspaceId: input.workspaceID
      });
      if (!launched) {
        throw new Error("Failed to open file in app browser");
      }
    },
    async openFileInDefaultBrowser(input): Promise<void> {
      await hostFilesApi.openFileInBrowser(input.workspaceID, input.path);
    },
    async revealEntry(input): Promise<void> {
      try {
        await hostFilesApi.revealWorkspaceFile(input.workspaceID, input.path);
      } catch (error) {
        dependencies.notifyRevealFailed(
          resolveDesktopErrorMessage(error, getLocale())
        );
        throw error;
      }
    },
    async activateFile(
      request: WorkspaceFileManagerFileActivationRequest,
      workspaceID: string
    ): Promise<WorkspaceFileManagerHostFileActivationResult> {
      if (
        request.target &&
        (await canvasPreview?.openCanvasPreview(request.target, workspaceID))
      ) {
        dependencies.reportFileOpened?.();
        return { disposition: "handled" };
      }

      dependencies.notifyPreviewUnsupportedFallback();
      await hostFilesApi.openFile(workspaceID, request.entry.path);
      dependencies.reportFileOpened?.();
      return { disposition: "handled" };
    },
    async listDirectory(input): Promise<WorkspaceFileDirectoryListing> {
      const response = await tuttidClient.listWorkspaceFileDirectory(
        input.workspaceID,
        { includeHidden: input.includeHidden, path: input.path }
      );
      return {
        directoryPath: response.directoryPath,
        entries: response.entries.map(fileEntryFromDesktop),
        root: response.root,
        workspaceID: response.workspaceId
      };
    },
    readPreviewFile(workspaceID: string, path: string): Promise<Uint8Array> {
      return hostFilesApi.readPreviewFile(workspaceID, path);
    },
    resolveDroppedPaths(
      dataTransfer: Pick<DataTransfer, "files" | "items">
    ): string[] {
      return extractDesktopDroppedPaths(dataTransfer, (files) =>
        platformApi.resolveDroppedPaths(files)
      );
    },
    resolveErrorMessage(
      error: unknown,
      overrides?: Record<string, string>
    ): string {
      return resolveDesktopErrorMessage(error, getLocale(), overrides);
    },
    async search(input): Promise<WorkspaceFileSearchResult> {
      const response = await tuttidClient.searchWorkspaceFiles(
        input.workspaceID,
        {
          includeKinds: input.includeKinds,
          limit: input.limit,
          query: input.query
        }
      );
      return {
        entries: response.entries.map((entry) => ({
          directoryPath: entry.directoryPath,
          kind: entry.kind,
          matchIndices: entry.matchIndices,
          matchTarget: entry.matchTarget,
          name: entry.name,
          path: entry.path,
          score: entry.score
        })),
        root: response.root,
        workspaceID: response.workspaceId
      };
    },
    async importFiles(
      workspaceID: string,
      targetDirectoryPath: string
    ): Promise<WorkspaceFileManagerHostActionResult> {
      const sourcePaths = await hostFilesApi.selectUploadFiles();
      return uploadSourcePaths(
        tuttidClient,
        workspaceID,
        targetDirectoryPath,
        sourcePaths
      );
    },
    async importPaths(
      workspaceID: string,
      targetDirectoryPath: string,
      sourcePaths: string[]
    ): Promise<WorkspaceFileManagerHostActionResult> {
      return uploadSourcePaths(
        tuttidClient,
        workspaceID,
        targetDirectoryPath,
        sourcePaths
      );
    }
  };
}

function fileEntryFromDesktop(entry: {
  createdTimeMs: number | null;
  hasChildren: boolean;
  kind: WorkspaceFileEntry["kind"];
  lastOpenedMs: number | null;
  mtimeMs: number | null;
  name: string;
  path: string;
  sizeBytes: number | null;
}): WorkspaceFileEntry {
  return {
    createdTimeMs: entry.createdTimeMs,
    hasChildren: entry.hasChildren,
    kind: entry.kind,
    lastOpenedMs: entry.lastOpenedMs,
    mtimeMs: entry.mtimeMs,
    name: entry.name,
    path: entry.path,
    sizeBytes: entry.sizeBytes
  };
}

async function uploadSourcePaths(
  tuttidClient: TuttidClient,
  workspaceID: string,
  targetDirectoryPath: string,
  sourcePaths: string[]
): Promise<WorkspaceFileManagerHostActionResult> {
  if (sourcePaths.length === 0) {
    return { supported: true };
  }

  const preflight = await tuttidClient.preflightUploadWorkspaceFiles(
    workspaceID,
    {
      sourcePaths,
      targetDirectoryPath
    }
  );
  if (preflight.conflicts.length > 0) {
    const conflicts = preflight.conflicts.map((conflict) => ({
      conflictKind: conflict.kind,
      destinationKind: conflict.destinationKind,
      destinationPath: conflict.destinationPath,
      name: conflict.name,
      sourcePath: conflict.sourcePath
    }));
    const hasBlockedConflict = conflicts.some(
      (conflict) => conflict.conflictKind === "type_mismatch"
    );
    return {
      supported: true,
      importConflict: {
        conflicts,
        onConfirm: hasBlockedConflict
          ? undefined
          : async () => {
              await tuttidClient.uploadWorkspaceFiles(workspaceID, {
                overwrite: true,
                sourcePaths,
                targetDirectoryPath
              });
              return { supported: true };
            }
      }
    };
  }

  await tuttidClient.uploadWorkspaceFiles(workspaceID, {
    sourcePaths,
    targetDirectoryPath
  });
  return { supported: true };
}
