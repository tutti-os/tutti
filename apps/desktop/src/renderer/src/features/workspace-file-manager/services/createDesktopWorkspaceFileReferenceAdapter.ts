import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import type {
  WorkspaceFileReference,
  WorkspaceFileReferenceAdapter,
  WorkspaceFileReferenceTreeDirectory,
  WorkspaceFileReferenceTreeEntry,
  WorkspaceFileReferenceTreeSnapshot
} from "@tutti-os/workspace-file-reference/contracts";
import {
  classifyWorkspaceFilePreviewKind,
  resolveWorkspaceFilePreviewName,
  resolveWorkspaceImageMimeType
} from "@tutti-os/workspace-file-preview";
import type { DesktopHostFilesApi } from "@preload/types";

export function createDesktopWorkspaceFileReferenceAdapter(input: {
  hostFilesApi: DesktopHostFilesApi;
  tuttidClient: TuttidClient;
  workspaceId: string;
}): WorkspaceFileReferenceAdapter {
  const { hostFilesApi, tuttidClient, workspaceId } = input;

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
      await hostFilesApi.openFile(workspaceId, trimmedPath);
    },
    async readReferencePreview({ reference, workspaceId }) {
      const previewKind = classifyWorkspaceFilePreviewKind(reference);
      if (!previewKind || isTerminalReferencePath(reference.path)) {
        return null;
      }
      const name = resolveWorkspaceFilePreviewName(reference);
      const path = reference.path.trim();
      return {
        bytes: await hostFilesApi.readPreviewFile(workspaceId, path),
        contentType:
          previewKind === "image"
            ? resolveWorkspaceImageMimeType(name)
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
      within,
      signal,
      workspaceId
    }) {
      const response = await tuttidClient.searchWorkspaceFiles(
        workspaceId,
        {
          limit,
          query,
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
    ...(entry.mtimeMs === undefined ? {} : { mtimeMs: entry.mtimeMs }),
    ...(entry.sizeBytes === undefined ? {} : { sizeBytes: entry.sizeBytes })
  };
}

function mapFileReferenceEntry(entry: {
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
    ...(entry.mtimeMs === undefined ? {} : { mtimeMs: entry.mtimeMs }),
    ...(entry.sizeBytes === undefined ? {} : { sizeBytes: entry.sizeBytes })
  };
}

function isTerminalReferencePath(path: string): boolean {
  const trimmedPath = path.trim();
  return trimmedPath === "~" || trimmedPath.startsWith("~/");
}
