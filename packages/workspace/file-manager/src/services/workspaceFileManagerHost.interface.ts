import type {
  WorkspaceFileDirectoryListing,
  WorkspaceFileEntry,
  WorkspaceFileEntryKind,
  WorkspaceFileManagerFileDefaultOpener,
  WorkspaceFileOpenWithApplication,
  WorkspaceFileLocationSection,
  WorkspaceFileSearchInput,
  WorkspaceFileSearchResult
} from "./workspaceFileManagerTypes.ts";
import type { WorkspaceFileManagerI18nRuntime } from "../i18n/workspaceFileManagerI18n.ts";
import type {
  WorkspaceFileManagerFileActivationRequest,
  WorkspaceFileManagerHostFileActivationResult
} from "./workspaceFileManagerHostTypes.ts";
import type { WorkspaceFileManagerPersistedState } from "./workspaceFileManagerTypes.ts";

export interface WorkspaceFileManagerMutationErrorMessage {
  actionKind: "copy" | "create" | "delete" | "move" | "rename";
  error: unknown;
  message: string;
}

export interface WorkspaceFileManagerHost {
  listDirectory(input: {
    includeHidden?: boolean;
    path: string;
    workspaceID: string;
  }): Promise<WorkspaceFileDirectoryListing>;
  search?(
    input: WorkspaceFileSearchInput & {
      workspaceID: string;
    }
  ): Promise<WorkspaceFileSearchResult>;
  listRecentEntries?(input: {
    limit?: number;
    workspaceID: string;
  }): Promise<WorkspaceFileDirectoryListing>;
  createDirectory?(input: {
    path: string;
    workspaceID: string;
  }): Promise<WorkspaceFileEntry>;
  createFile?(input: {
    path: string;
    workspaceID: string;
  }): Promise<WorkspaceFileEntry>;
  deleteEntry?(input: {
    kind?: Extract<WorkspaceFileEntryKind, "file" | "directory"> | null;
    path: string;
    workspaceID: string;
  }): Promise<void>;
  moveEntry?(input: {
    kind: Extract<WorkspaceFileEntryKind, "file" | "directory">;
    path: string;
    targetDirectoryPath: string;
    workspaceID: string;
  }): Promise<WorkspaceFileEntry>;
  renameEntry?(input: {
    path: string;
    newName: string;
    workspaceID: string;
  }): Promise<WorkspaceFileEntry>;
  copyEntriesToClipboard?(input: {
    paths: string[];
    workspaceID: string;
  }): Promise<void>;
  listOpenWithApplications?(input: {
    path: string;
    workspaceID: string;
  }): Promise<WorkspaceFileOpenWithApplication[]>;
  openFileWithApplication?(input: {
    applicationPath: string;
    path: string;
    workspaceID: string;
  }): Promise<void>;
  openFileWithOtherApplication?(input: {
    applicationPickerPrompt?: string;
    path: string;
    workspaceID: string;
  }): Promise<void>;
  openFileInAppBrowser?(input: {
    path: string;
    workspaceID: string;
  }): Promise<void>;
  openFileInDefaultBrowser?(input: {
    path: string;
    workspaceID: string;
  }): Promise<void>;
  openFileInSystemDefault?(input: {
    path: string;
    workspaceID: string;
  }): Promise<void>;
  revealEntry?(input: { path: string; workspaceID: string }): Promise<void>;
  activateFile?(
    request: WorkspaceFileManagerFileActivationRequest,
    workspaceID: string
  ): Promise<WorkspaceFileManagerHostFileActivationResult>;
  readPreviewFile?(
    workspaceID: string,
    path: string
  ): Promise<Uint8Array | ArrayBuffer>;
  resolveErrorMessage?(
    error: unknown,
    overrides?: Record<string, string>
  ): string;
}

export interface CreateWorkspaceFileManagerSessionInput {
  i18n: WorkspaceFileManagerI18nRuntime;
  host: WorkspaceFileManagerHost;
  initialDirectoryPath?: string;
  defaultLocationId?: string | null;
  locationSections?: WorkspaceFileLocationSection[];
  onMutationErrorMessage?: (
    message: WorkspaceFileManagerMutationErrorMessage
  ) => boolean | void;
  persistedState?: WorkspaceFileManagerPersistedState | null;
  persistence?: {
    load?(): WorkspaceFileManagerPersistedState | null | undefined;
    save(state: WorkspaceFileManagerPersistedState): void;
  };
  resolveFileDefaultOpener?: (
    entry: WorkspaceFileEntry
  ) => WorkspaceFileManagerFileDefaultOpener | null | undefined;
  workspaceID: string;
}
