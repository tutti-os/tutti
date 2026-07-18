import type { ReactNode } from "react";
import type { AgentGUIProvider } from "@tutti-os/agent-gui";
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
import type {
  DesktopLocale,
  WorkspaceWorkbenchDesktopI18nRuntime
} from "@shared/i18n";
import type { DesktopDockIconStyle } from "@shared/preferences";
import type { DesktopThemeAppearance } from "@shared/theme";
import type {
  WorkspaceWallpaperDisplayMode,
  WorkspaceWallpaperId
} from "./workspaceWallpaper";
import type {
  DesktopHostNotificationNavigationPayload,
  DesktopHostWindowCloseRequestPayload,
  DesktopWorkspaceOpenFeatureRequest
} from "@shared/contracts/ipc";
import type {
  TuttiExternalAtQueryInput,
  TuttiExternalAtQueryResult,
  TuttiExternalAtResolveInput,
  TuttiExternalAtResolveResult
} from "@tutti-os/workspace-external-core/contracts";
import type { WorkspaceFileReferenceAdapter } from "@tutti-os/workspace-file-reference/contracts";
import type { WorkspaceUserProjectApi } from "@tutti-os/workspace-user-project/contracts";
import type { DesktopWorkspaceAppOpenFileResolvedPayload } from "@shared/contracts/ipc";

export type WorkspaceCustomWallpaperStatus = "idle" | "saving" | "removing";

export type WorkspaceWorkbenchSnapshotPersistence = "durable" | "window-local";

export interface WorkspaceCustomWallpaperSnapshot {
  exists: boolean;
  fullUrl: string | null;
  status: WorkspaceCustomWallpaperStatus;
  thumbnailUrl: string | null;
}

export interface WorkspaceOnboardingAutoOpenDiagnostic {
  details?: Record<string, unknown>;
  event: string;
  level: "debug" | "info" | "warn" | "error";
  workspaceId: string;
}

export interface WorkspaceFilesNodeActivationPayload {
  mode?: "reveal" | "open-directory";
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

export interface WorkspaceWorkbenchHostSessionUpdate {
  appI18n: I18nRuntime<string>;
  appLocale: DesktopLocale;
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
  comingSoonAgentProviders?: readonly AgentGUIProvider[];
  renderFilesNodeBody: (
    context: WorkspaceWorkbenchBodyRendererContext
  ) => ReactNode;
  themeAppearance: DesktopThemeAppearance;
  workspaceId: string;
}

export interface WorkspaceWorkbenchHostSessionBinding {
  readonly bindingId: number;
  readonly isActive: boolean;
  readonly workspaceId: string;
  attachSurface(handle: WorkbenchHostHandle | null): void;
  createHostInput(
    input: WorkspaceWorkbenchHostSessionUpdate
  ): WorkspaceWorkbenchHostInput;
  release(): void;
  subscribe(listener: () => void): () => void;
}

export interface IWorkspaceWorkbenchHostService {
  readonly _serviceBrand: undefined;

  approveWindowClose(): Promise<void>;
  openHostSession(workspaceId: string): WorkspaceWorkbenchHostSessionBinding;
  createWorkspaceAppExternalFileReferenceAdapter(
    workspaceId: string
  ): WorkspaceFileReferenceAdapter;
  createWorkspaceAppExternalUserProjectApi(): WorkspaceUserProjectApi;
  openExternal(url: string): Promise<void>;
  queryWorkspaceAppExternalAt(input: {
    query: TuttiExternalAtQueryInput;
    workspaceId: string;
  }): Promise<TuttiExternalAtQueryResult[]>;
  resolveWorkspaceAppExternalAt(input: {
    mention: TuttiExternalAtResolveInput;
    workspaceId: string;
  }): Promise<TuttiExternalAtResolveResult | null>;
  onWindowCloseRequest(
    listener: (payload: DesktopHostWindowCloseRequestPayload) => void
  ): () => void;
  onNotificationNavigate(
    listener: (payload: DesktopHostNotificationNavigationPayload) => void
  ): () => void;
  onOpenFeatureRequest(
    listener: (request: DesktopWorkspaceOpenFeatureRequest) => void
  ): () => void;
  onOpenFileRequest(
    listener: (request: DesktopWorkspaceAppOpenFileResolvedPayload) => void
  ): () => void;
  hasWorkspaceOnboardingAutoOpened(workspaceId: string): Promise<boolean>;
  logWorkspaceOnboardingAutoOpenDiagnostic(
    diagnostic: WorkspaceOnboardingAutoOpenDiagnostic
  ): void;
  markWorkspaceOnboardingAutoOpened(workspaceId: string): Promise<void>;
  readWallpaperDisplayMode(workspaceId: string): WorkspaceWallpaperDisplayMode;
  readWallpaperId(workspaceId: string): WorkspaceWallpaperId;
  resolveWindowCloseRequest(input: {
    outcome: "approved" | "blocked";
    requestId: string;
  }): void;
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
    reason: DesktopHostWindowCloseRequestPayload["reason"];
  }): Promise<"approved" | "blocked">;
  writeWallpaperDisplayMode(
    workspaceId: string,
    displayMode: WorkspaceWallpaperDisplayMode
  ): void;
  writeWallpaperId(
    workspaceId: string,
    wallpaperId: WorkspaceWallpaperId
  ): void;
  subscribeWallpaperChanges(listener: () => void): () => void;
  broadcastAgentStatus(payload: { agentBound: boolean }): void;
}

export const IWorkspaceWorkbenchHostService =
  createDecorator<IWorkspaceWorkbenchHostService>(
    "workspace-workbench-host-service"
  );
