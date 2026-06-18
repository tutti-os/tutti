import type { ReactNode } from "react";
import { createDecorator } from "@tutti-os/infra/di";
import type { I18nRuntime } from "@tutti-os/ui-i18n-runtime";
import type { WorkspaceFileManagerPersistedState } from "@tutti-os/workspace-file-manager/services";
import type {
  WorkbenchHostDockEntry,
  WorkbenchHostDockEntryStateSource,
  WorkbenchDockPreviewCache,
  WorkbenchHostActivation,
  WorkbenchHostCloseEffect,
  WorkbenchHostCloseDialogRequest,
  WorkbenchContribution,
  WorkbenchHostExternalStateSource,
  WorkbenchHostHandle,
  WorkbenchHostClosePreparer,
  WorkbenchDebugDiagnostics,
  WorkbenchHostProps,
  WorkbenchHostLaunchRequest,
  WorkbenchHostLaunchResult,
  WorkbenchHostNodeCloseDecision,
  WorkbenchHostNodeCloseRequest,
  WorkbenchHostNodeDefinition,
  WorkbenchHostSnapshotRepository
} from "@tutti-os/workbench-surface";
import type { WorkspaceWorkbenchDesktopI18nRuntime } from "@shared/i18n";
import type { DesktopDockIconStyle } from "@shared/preferences";
import type { DesktopThemeAppearance } from "@shared/theme";
import type {
  WorkspaceWallpaperDisplayMode,
  WorkspaceWallpaperId
} from "./workspaceWallpaper";
import type {
  DesktopHostNotificationNavigationPayload,
  DesktopWorkspaceOpenFeatureRequest
} from "@shared/contracts/ipc";
import type {
  TuttiExternalAtQueryInput,
  TuttiExternalAtQueryResult
} from "@tutti-os/workspace-external-core/contracts";
import type { WorkspaceFileReferenceAdapter } from "@tutti-os/workspace-file-reference/contracts";
import type { DesktopWorkspaceAppOpenFileResolvedPayload } from "@shared/contracts/ipc";

export type WorkspaceCustomWallpaperStatus = "idle" | "saving" | "removing";

export interface WorkspaceCustomWallpaperSnapshot {
  exists: boolean;
  fullUrl: string | null;
  status: WorkspaceCustomWallpaperStatus;
  thumbnailUrl: string | null;
}

export interface WorkspaceFilesNodeActivationPayload {
  path: string;
}

export interface WorkspaceWorkbenchBodyRendererContext {
  activation: WorkbenchHostActivation<WorkspaceFilesNodeActivationPayload> | null;
  externalNodeState: WorkspaceFileManagerPersistedState | null;
  workspaceId: string;
}

export type WorkspaceWorkbenchCapabilitySettingsTarget =
  | "browserUse"
  | "computerUse";

export interface WorkspaceWorkbenchHostInput {
  readonly captureNodePreviewImage?: WorkbenchHostProps["captureNodePreviewImage"];
  readonly contributions?: readonly WorkbenchContribution[];
  readonly debugDiagnostics?: WorkbenchDebugDiagnostics;
  readonly dockPreviewCache?: WorkbenchDockPreviewCache;
  readonly dockEntries?: readonly WorkbenchHostDockEntry[];
  readonly dockStateSource?: WorkbenchHostDockEntryStateSource;
  readonly createWindowCloseDialogRequest?: (
    effects: readonly WorkbenchHostCloseEffect[]
  ) => WorkbenchHostCloseDialogRequest | null;
  readonly externalStateSource?: WorkbenchHostExternalStateSource;
  readonly nodes?: readonly WorkbenchHostNodeDefinition[];
  readonly onLaunchRequest?: (
    request: WorkbenchHostLaunchRequest
  ) =>
    | Promise<WorkbenchHostLaunchResult | null>
    | WorkbenchHostLaunchResult
    | null;
  readonly onDockEntryAction?: WorkbenchHostProps["onDockEntryAction"];
  readonly onDockEntryClick?: WorkbenchHostProps["onDockEntryClick"];
  readonly onNodeCloseRequest?: (
    request: WorkbenchHostNodeCloseRequest
  ) =>
    | Promise<WorkbenchHostNodeCloseDecision | void>
    | WorkbenchHostNodeCloseDecision
    | void;
  readonly prepareHostClose?: WorkbenchHostClosePreparer;
  readonly snapshotRepository: WorkbenchHostSnapshotRepository;
  readonly workspaceId: string;
}

export interface IWorkspaceWorkbenchHostService {
  readonly _serviceBrand: undefined;

  approveWindowClose(): Promise<void>;
  createHostInput(input: {
    appI18n: I18nRuntime<string>;
    appCenterRevision?: number;
    confirmCloseGuard: (
      request: WorkbenchHostCloseDialogRequest
    ) => Promise<boolean> | boolean;
    defaultAgentProvider?: string | null;
    dockIconStyle: DesktopDockIconStyle;
    i18n: WorkspaceWorkbenchDesktopI18nRuntime;
    onCapabilitySettingsRequest?: (
      target: WorkspaceWorkbenchCapabilitySettingsTarget
    ) => void;
    renderFilesNodeBody: (
      context: WorkspaceWorkbenchBodyRendererContext
    ) => ReactNode;
    themeAppearance: DesktopThemeAppearance;
    workspaceId: string;
  }): WorkspaceWorkbenchHostInput;
  createWorkspaceAppExternalFileReferenceAdapter(
    workspaceId: string
  ): WorkspaceFileReferenceAdapter;
  queryWorkspaceAppExternalAt(input: {
    query: TuttiExternalAtQueryInput;
    workspaceId: string;
  }): Promise<TuttiExternalAtQueryResult[]>;
  onWindowCloseRequest(listener: () => void): () => void;
  onNotificationNavigate(
    listener: (payload: DesktopHostNotificationNavigationPayload) => void
  ): () => void;
  onOpenFeatureRequest(
    listener: (request: DesktopWorkspaceOpenFeatureRequest) => void
  ): () => void;
  onOpenFileRequest(
    listener: (request: DesktopWorkspaceAppOpenFileResolvedPayload) => void
  ): () => void;
  readWallpaperDisplayMode(workspaceId: string): WorkspaceWallpaperDisplayMode;
  readWallpaperId(workspaceId: string): WorkspaceWallpaperId;
  ensureAgentProviderStatusesLoaded(): Promise<void>;
  getHomeDirectory(): string;
  getWallpaperRevision(): number;
  getCustomWallpaperSnapshot(): WorkspaceCustomWallpaperSnapshot;
  getCustomWallpaperUrl(): string | null;
  uploadCustomWallpaper(file: File): Promise<void>;
  removeCustomWallpaper(): Promise<void>;
  requestWindowClose(input: {
    confirmCloseGuard(
      request: WorkbenchHostCloseDialogRequest
    ): Promise<boolean>;
    host: WorkbenchHostHandle | null;
    hostInput: WorkspaceWorkbenchHostInput;
  }): Promise<void>;
  writeWallpaperDisplayMode(
    workspaceId: string,
    displayMode: WorkspaceWallpaperDisplayMode
  ): void;
  writeWallpaperId(
    workspaceId: string,
    wallpaperId: WorkspaceWallpaperId
  ): void;
  subscribeWallpaperChanges(listener: () => void): () => void;
}

export const IWorkspaceWorkbenchHostService =
  createDecorator<IWorkspaceWorkbenchHostService>(
    "workspace-workbench-host-service"
  );
