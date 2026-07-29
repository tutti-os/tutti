import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import type { WorkspaceFileEntry } from "@tutti-os/workspace-file-manager/services";
import type {
  WorkspaceFileReference,
  WorkspaceFileReferenceAdapter,
  WorkspaceFileReferenceTreeDirectory,
  WorkspaceFileReferenceTreeEntry,
  WorkspaceFileReferenceTreeSnapshot
} from "@tutti-os/workspace-file-reference/contracts";
import {
  classifyWorkspaceFilePreviewKind,
  resolveWorkspaceFileBuiltinRenderKind,
  resolveWorkspaceFilePreviewName,
  resolveWorkspaceFilePreviewTarget,
  resolveWorkspaceImageMimeType,
  resolveWorkspaceVideoMimeType,
  type WorkspaceFilePreviewTarget
} from "@tutti-os/workspace-file-preview";
import type { DesktopHostFilesApi } from "@preload/types";

export function createDesktopWorkspaceFileReferenceAdapter(input: {
  hostFilesApi: DesktopHostFilesApi;
  presentFilePreview?: (
    target: WorkspaceFilePreviewTarget,
    workspaceId: string
  ) => Promise<boolean> | boolean;
  tuttidClient: TuttidClient;
  workspaceId: string;
}): WorkspaceFileReferenceAdapter {
  const { hostFilesApi, presentFilePreview, tuttidClient, workspaceId } = input;

  return {
    async loadReferenceTree({
      path,
      prefetchBudgetMs = 500,
      prefetchDepth = 4,
      workspaceId
    }) {
      const response = await tuttidClient.getWorkspaceFileTreeSnapshot(
        workspaceId,
        {
          path: path ?? undefined,
          prefetchBudgetMs,
          prefetchDepth
        }
      );
      return {
        budgetExceeded: response.budgetExceeded,
        directory: mapReferenceTreeDirectory(response.directory),
        prefetchBudgetMs: response.prefetchBudgetMs,
        prefetchDepth: response.prefetchDepth,
        rootPath: response.root
      } satisfies WorkspaceFileReferenceTreeSnapshot;
    },
    async listDirectory({ path, workspaceId }) {
      const response = await tuttidClient.listWorkspaceFileDirectory(
        workspaceId,
        { path: path ?? undefined }
      );
      return {
        directoryPath: response.directoryPath,
        entries: response.entries.map((entry) => mapFileReferenceEntry(entry)),
        rootPath: response.root
      };
    },
    async listRecentReferences({ limit = 30, signal, workspaceId }) {
      const response = await tuttidClient.listWorkspaceRecentFiles(
        workspaceId,
        { limit },
        { signal }
      );
      return response.entries.map((entry) => mapFileReferenceEntry(entry));
    },
    async openReference(reference) {
      const trimmedPath = reference.path.trim();
      if (trimmedPath === "~" || trimmedPath.startsWith("~/")) {
        await hostFilesApi.openTerminalLink({
          path: trimmedPath,
          workspaceID: workspaceId
        });
        return;
      }
      const entry = referenceToWorkspaceFileEntry({
        ...reference,
        path: trimmedPath
      });
      const target =
        entry.kind === "file" ? resolveWorkspaceFilePreviewTarget(entry) : null;
      if (
        target &&
        (await presentFilePreview?.(target, workspaceId)) === true
      ) {
        return;
      }
      await hostFilesApi.openFile(workspaceId, trimmedPath);
    },
    async listOpenWithApplications(reference) {
      return hostFilesApi.listOpenWithApplications(
        workspaceId,
        reference.path.trim()
      );
    },
    async openReferenceWithApplication(reference, applicationPath) {
      await hostFilesApi.openFileWithApplication(
        workspaceId,
        reference.path.trim(),
        applicationPath
      );
    },
    async openReferenceWithOtherApplication(
      reference,
      applicationPickerPrompt
    ) {
      await hostFilesApi.openFileWithOtherApplication(
        workspaceId,
        reference.path.trim(),
        applicationPickerPrompt
      );
    },
    async revealReference(reference) {
      await hostFilesApi.revealWorkspaceFile(
        workspaceId,
        reference.path.trim()
      );
    },
    async readReferencePreview({ reference, workspaceId }) {
      // References use displayName; map to preview entry.name so classification
      // matches openReference → referenceToWorkspaceFileEntry.
      const name = resolveWorkspaceFilePreviewName({
        name: reference.displayName,
        path: reference.path
      });
      const previewKind = classifyWorkspaceFilePreviewKind({
        kind: reference.kind === "folder" ? "directory" : reference.kind,
        name,
        path: reference.path
      });
      if (
        resolveWorkspaceFileBuiltinRenderKind(previewKind) === null ||
        isTerminalReferencePath(reference.path)
      ) {
        return null;
      }
      const path = reference.path.trim();
      return {
        bytes: await hostFilesApi.readPreviewFile(workspaceId, path),
        contentType:
          previewKind === "image"
            ? resolveWorkspaceImageMimeType(name)
            : previewKind === "video"
              ? resolveWorkspaceVideoMimeType(name)
              : "text/plain;charset=utf-8",
        kind: previewKind
      };
    },
    async refreshTree() {
      // The desktop host has no dedicated tree invalidation surface yet.
    },
    async searchReferences({
      limit = 30,
      query,
      filters,
      kinds,
      within,
      signal,
      workspaceId
    }) {
      const response = await tuttidClient.searchWorkspaceFiles(
        workspaceId,
        {
          limit,
          query,
          ...(kinds && kinds.length > 0
            ? {
                includeKinds: kinds.map((kind) =>
                  kind === "folder" ? "directory" : "file"
                )
              }
            : {}),
          ...(filters && filters.length > 0 ? { filters } : {}),
          ...(within ? { within } : {})
        },
        { signal }
      );
      return response.entries.map((entry) => mapFileReferenceEntry(entry));
    }
  };
}

export function mapDesktopWorkspaceFileReferenceEntry(entry: {
  createdTimeMs?: number | null;
  kind: string;
  mtimeMs?: number | null;
  name?: string;
  path: string;
  sizeBytes?: number | null;
}): WorkspaceFileReference {
  return mapFileReferenceEntry(entry);
}

function mapReferenceTreeDirectory(
  directory:
    | WorkspaceFileReferenceTreeDirectory
    | {
        directoryPath: string;
        entries: readonly ReferenceTreeTransportEntry[];
        prefetchReason?: string | null;
        prefetchState: string;
      }
): WorkspaceFileReferenceTreeDirectory {
  return {
    directoryPath: directory.directoryPath,
    entries: directory.entries.map((entry) => mapReferenceTreeEntry(entry)),
    prefetchReason: directory.prefetchReason,
    prefetchState: directory.prefetchState
  };
}

type ReferenceTreeTransportEntry = {
  createdTimeMs?: number | null;
  hasChildren?: boolean;
  kind: string;
  mtimeMs?: number | null;
  name?: string;
  path: string;
  prefetchReason?: string | null;
  prefetchState?: string | null;
  prefetchedDirectory?: {
    directoryPath: string;
    entries: readonly ReferenceTreeTransportEntry[];
    prefetchReason?: string | null;
    prefetchState: string;
  } | null;
  sizeBytes?: number | null;
};

function mapReferenceTreeEntry(
  entry: ReferenceTreeTransportEntry
): WorkspaceFileReferenceTreeEntry {
  return {
    displayName: entry.name,
    hasChildren: entry.hasChildren,
    kind: entry.kind === "directory" ? "folder" : "file",
    path: entry.path,
    prefetchReason: entry.prefetchReason,
    prefetchState: entry.prefetchState,
    prefetchedDirectory: entry.prefetchedDirectory
      ? mapReferenceTreeDirectory(entry.prefetchedDirectory)
      : null,
    ...(entry.createdTimeMs === undefined
      ? {}
      : { createdTimeMs: entry.createdTimeMs }),
    ...(entry.mtimeMs === undefined ? {} : { mtimeMs: entry.mtimeMs }),
    ...(entry.sizeBytes === undefined ? {} : { sizeBytes: entry.sizeBytes })
  };
}

function mapFileReferenceEntry(entry: {
  createdTimeMs?: number | null;
  kind: string;
  mtimeMs?: number | null;
  name?: string;
  path: string;
  sizeBytes?: number | null;
}): WorkspaceFileReference {
  return {
    displayName: entry.name,
    kind: entry.kind === "directory" ? "folder" : "file",
    path: entry.path,
    ...(entry.createdTimeMs === undefined
      ? {}
      : { createdTimeMs: entry.createdTimeMs }),
    ...(entry.mtimeMs === undefined ? {} : { mtimeMs: entry.mtimeMs }),
    ...(entry.sizeBytes === undefined ? {} : { sizeBytes: entry.sizeBytes })
  };
}

function referenceToWorkspaceFileEntry(
  reference: WorkspaceFileReference
): WorkspaceFileEntry {
  return {
    createdTimeMs: reference.createdTimeMs ?? null,
    hasChildren: reference.kind === "folder",
    kind: reference.kind === "folder" ? "directory" : "file",
    mtimeMs: reference.mtimeMs ?? null,
    name: reference.displayName?.trim() || basename(reference.path),
    path: reference.path,
    sizeBytes: reference.sizeBytes ?? null
  };
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}

function isTerminalReferencePath(path: string): boolean {
  const trimmedPath = path.trim();
  return trimmedPath === "~" || trimmedPath.startsWith("~/");
}
