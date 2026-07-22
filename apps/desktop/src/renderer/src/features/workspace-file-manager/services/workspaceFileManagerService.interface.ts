import { createDecorator } from "@tutti-os/infra/di";
import type { ReferenceSourceAggregator } from "@tutti-os/workspace-file-reference/core";
import type { DesktopLocale } from "@shared/i18n";
import type {
  WorkspaceFileEntry,
  WorkspaceFileManagerI18nRuntime,
  WorkspaceFileManagerPersistedState,
  WorkspaceFileManagerSession as SharedWorkspaceFileManagerSession
} from "@tutti-os/workspace-file-manager/services";
import type { WorkspaceFilePreviewActivationTarget } from "@tutti-os/workspace-file-preview";
export type WorkspaceFileManagerSession = SharedWorkspaceFileManagerSession;

export interface IWorkspaceFileManagerService {
  readonly _serviceBrand: undefined;
  readonly hostOs: NodeJS.Platform;

  entryExists(input: { path: string; workspaceID: string }): Promise<boolean>;
  getSession(
    workspaceID: string,
    i18n: WorkspaceFileManagerI18nRuntime,
    restoredState?: WorkspaceFileManagerPersistedState | null
  ): WorkspaceFileManagerSession;
  getReferenceSourceAggregator(
    workspaceID: string,
    locale?: DesktopLocale
  ): ReferenceSourceAggregator;
  getSnapshotState(
    workspaceID: string
  ): WorkspaceFileManagerPersistedState | null;
  openCanvasFilePreview(
    workspaceID: string,
    target: WorkspaceFilePreviewActivationTarget
  ): Promise<boolean>;
  resolveEntryIconUrl(
    workspaceID: string,
    entry: WorkspaceFileEntry
  ): Promise<string | null>;
  subscribe(workspaceID: string, listener: () => void): () => void;
}

export const IWorkspaceFileManagerService =
  createDecorator<IWorkspaceFileManagerService>(
    "workspace-file-manager-service"
  );
