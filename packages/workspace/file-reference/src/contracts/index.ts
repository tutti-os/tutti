export interface WorkspaceFileReference {
  displayName?: string;
  kind: "file" | "folder" | (string & {});
  mtimeMs?: number | null;
  path: string;
  sizeBytes?: number | null;
}

export interface WorkspaceFileReferenceDirectoryListing {
  directoryPath: string;
  entries: WorkspaceFileReference[];
  rootPath?: string | null;
}

export type WorkspaceFileReferencePrefetchState =
  | "loaded"
  | "partial"
  | "not_loaded"
  | "unavailable"
  | (string & {});

export type WorkspaceFileReferencePrefetchReason =
  | "budget_exhausted"
  | "depth_limit_reached"
  | "unreadable"
  | (string & {});

export interface WorkspaceFileReferenceTreeDirectory {
  directoryPath: string;
  entries: WorkspaceFileReferenceTreeEntry[];
  prefetchReason?: WorkspaceFileReferencePrefetchReason | null;
  prefetchState: WorkspaceFileReferencePrefetchState;
}

export interface WorkspaceFileReferenceTreeEntry extends WorkspaceFileReference {
  hasChildren?: boolean;
  prefetchReason?: WorkspaceFileReferencePrefetchReason | null;
  prefetchState?: WorkspaceFileReferencePrefetchState | null;
  prefetchedDirectory?: WorkspaceFileReferenceTreeDirectory | null;
}

export interface WorkspaceFileReferenceTreeSnapshot {
  budgetExceeded: boolean;
  directory: WorkspaceFileReferenceTreeDirectory;
  prefetchBudgetMs: number;
  prefetchDepth: number;
  rootPath: string;
}

export type WorkspaceFileReferencePreviewKind = "image" | "text";

export interface WorkspaceFileReferencePreview {
  bytes: Uint8Array | ArrayBuffer;
  contentType?: string | null;
  kind: WorkspaceFileReferencePreviewKind;
}

export interface WorkspaceFileReferenceScope {
  workspaceId: string;
}

export interface WorkspaceFileReferenceAdapter {
  loadReferenceTree?(
    input: WorkspaceFileReferenceScope & {
      path?: string | null;
      prefetchBudgetMs?: number;
      prefetchDepth?: number;
    }
  ): Promise<WorkspaceFileReferenceTreeSnapshot>;
  listDirectory?(
    input: WorkspaceFileReferenceScope & { path?: string | null }
  ): Promise<WorkspaceFileReferenceDirectoryListing>;
  listRecentReferences?(
    input: WorkspaceFileReferenceScope & {
      limit?: number;
      signal?: AbortSignal;
    }
  ): Promise<WorkspaceFileReference[]>;
  openReference?(reference: WorkspaceFileReference): Promise<void> | void;
  readReferencePreview?(
    input: WorkspaceFileReferenceScope & { reference: WorkspaceFileReference }
  ): Promise<WorkspaceFileReferencePreview | null>;
  refreshTree?(
    input: WorkspaceFileReferenceScope & {
      depth?: number;
      paths?: readonly string[];
    }
  ): Promise<void>;
  requestReferences?(
    input: WorkspaceFileReferenceScope
  ): Promise<WorkspaceFileReference[]>;
  searchReferences?(
    input: WorkspaceFileReferenceScope & {
      limit?: number;
      query: string;
      signal?: AbortSignal;
    }
  ): Promise<WorkspaceFileReference[]>;
}

export interface WorkspaceFileReferenceCopy {
  t(key: string, values?: Record<string, number | string>): string;
}

export type * from "./referenceSource.ts";
