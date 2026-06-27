import { createDecorator } from "@tutti-os/infra/di";
import type {
  WorkspaceFileActivationTarget,
  WorkspaceFileEntry,
  WorkspaceFileManagerI18nRuntime,
  WorkspaceFileManagerPersistedState,
  WorkspaceFileManagerSession as SharedWorkspaceFileManagerSession
} from "@tutti-os/workspace-file-manager/services";
export type WorkspaceFileManagerSession = SharedWorkspaceFileManagerSession;

export type WorkspaceFileManagerCanvasPreviewLauncher = (
  target: WorkspaceFileActivationTarget
) => Promise<boolean> | boolean;

export interface IWorkspaceFileManagerService {
  readonly _serviceBrand: undefined;
  readonly hostOs: NodeJS.Platform;

  entryExists(input: { path: string; workspaceID: string }): Promise<boolean>;
  getSession(
    workspaceID: string,
    i18n: WorkspaceFileManagerI18nRuntime,
    restoredState?: WorkspaceFileManagerPersistedState | null
  ): WorkspaceFileManagerSession;
  getSnapshotState(
    workspaceID: string
  ): WorkspaceFileManagerPersistedState | null;
  resolveEntryIconUrl(
    workspaceID: string,
    entry: WorkspaceFileEntry
  ): Promise<string | null>;
  setCanvasFilePreviewLauncher(
    workspaceID: string,
    launcher: WorkspaceFileManagerCanvasPreviewLauncher | null
  ): void;
  subscribe(workspaceID: string, listener: () => void): () => void;
}

export const IWorkspaceFileManagerService =
  createDecorator<IWorkspaceFileManagerService>(
    "workspace-file-manager-service"
  );
