import type { WorkspaceFileOpenWithApplication } from "@tutti-os/workspace-file-manager/services";

export interface WorkspaceFileReference {
  createdTimeMs?: number | null;
  displayName?: string;
  hostPath?: string;
  kind: "file" | "folder" | (string & {});
  mtimeMs?: number | null;
  path: string;
  sizeBytes?: number | null;
  sourceId?: string;
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

export type WorkspaceFileReferencePreviewKind = "image" | "text" | "video";

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
  listOpenWithApplications?(
    reference: WorkspaceFileReference
  ): Promise<WorkspaceFileOpenWithApplication[]>;
  openReferenceWithApplication?(
    reference: WorkspaceFileReference,
    applicationPath: string
  ): Promise<void> | void;
  openReferenceWithOtherApplication?(
    reference: WorkspaceFileReference,
    applicationPickerPrompt?: string
  ): Promise<void> | void;
  revealReference?(reference: WorkspaceFileReference): Promise<void> | void;
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
      /** 搜索结果类型约束,必须在 limit 前执行。 */
      kinds?: Array<"file" | "folder">;
      /** 已选文件类型筛选分类 id;仅在有关键词的搜索中下钻。 */
      filters?: string[];
      /**
       * 可选:把搜索限定在工作区根下的某子路径(左栏选中的「位置」,如 文稿/下载/桌面)。
       * 相对工作区根的逻辑路径;缺省/空 = 跨整根搜索。
       */
      within?: string;
      signal?: AbortSignal;
    }
  ): Promise<WorkspaceFileReference[]>;
}

export interface WorkspaceFileReferenceCopy {
  t(key: string, values?: Record<string, number | string>): string;
}

export type * from "./referenceProvenance.ts";
export type * from "./referenceSource.ts";
