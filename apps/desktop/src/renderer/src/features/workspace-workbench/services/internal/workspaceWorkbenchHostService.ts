import type { ReactNode } from "react";
import type { AgentGUIProviderTarget } from "@tutti-os/agent-gui";
import type { I18nRuntime } from "@tutti-os/ui-i18n-runtime";
import {
  workspaceWorkbenchDesktopI18nKeys,
  type WorkspaceWorkbenchDesktopI18nRuntime
} from "@shared/i18n";
import type { DesktopDockIconStyle } from "@shared/preferences";
import type { DesktopThemeAppearance } from "@shared/theme";
import type {
  WorkbenchHostCloseDialogRequest,
  WorkbenchDebugDiagnostics,
  WorkbenchHostHandle
} from "@tutti-os/workbench-surface";
import { resolveWorkbenchHostPrepareClose } from "@tutti-os/workbench-surface";
import type {
  IWorkspaceWorkbenchHostService,
  WorkspaceOnboardingAutoOpenDiagnostic,
  WorkspaceCustomWallpaperSnapshot,
  WorkspaceCustomWallpaperStatus,
  WorkspaceWorkbenchBodyRendererContext,
  WorkspaceWorkbenchCapabilitySettingsTarget,
  WorkspaceWorkbenchHostInput
} from "../workspaceWorkbenchHostService.interface";
import type {
  DesktopBrowserApi,
  DesktopComputerUseApi,
  DesktopDockPreviewCacheApi,
  DesktopHostFilesApi,
  DesktopHostNotificationsApi,
  DesktopHostWindowApi,
  DesktopHostWorkspaceApi,
  DesktopPlatformApi,
  DesktopRuntimeApi,
  DesktopWallpaperApi
} from "@preload/types";
import type { DesktopCustomWallpaperImage } from "@shared/contracts/ipc";
import { processCustomWallpaperImage } from "./customWallpaperImageProcessing";
import type {
  TuttidClient,
  TuttidEventStreamClient
} from "@tutti-os/client-tuttid-ts";
import type { DesktopWorkspaceWorkbenchRepository } from "./adapters/desktopWorkspaceWorkbenchRepository";
import { createDesktopWorkspaceWorkbenchRepository } from "./adapters/desktopWorkspaceWorkbenchRepository";
import { IDesktopRichTextAtService } from "../../../rich-text-at/services/richTextAtService.interface.ts";
import {
  IAgentProviderStatusService,
  type IAgentProviderStatusService as AgentProviderStatusService
} from "../../../workspace-agent/services/agentProviderStatusService.interface.ts";
import {
  IWorkspaceAgentActivityService,
  type IWorkspaceAgentActivityService as WorkspaceAgentActivityService
} from "../../../workspace-agent/services/workspaceAgentActivityService.interface.ts";
import {
  IWorkspaceAgentPromptSessionService,
  type IWorkspaceAgentPromptSessionService as WorkspaceAgentPromptSessionService
} from "../../../workspace-agent/services/workspaceAgentPromptSessionService.interface.ts";
import {
  createWorkspaceAppCenterDockEntries,
  IWorkspaceAppCenterService,
  reportWorkspaceAppOpenedFromDockEntry
} from "@renderer/features/workspace-app-center";
import { createDesktopAgentGeneratedFileMentionProvider } from "@renderer/features/workspace-agent";
import { IWorkspaceFileManagerService } from "../../../workspace-file-manager/services/workspaceFileManagerService.interface.ts";
import { createDesktopWorkspaceFileReferenceAdapter } from "../../../workspace-file-manager/services/createDesktopWorkspaceFileReferenceAdapter.ts";
import { IWorkspaceUserProjectService } from "../../../workspace-user-project/services/workspaceUserProjectService.interface.ts";
import { defaultWorkspaceWorkbenchContributionFactories } from "./contributions/defaultWorkspaceWorkbenchContributionFactories.ts";
import { createWorkspaceWorkbenchContributionRegistryResult } from "./workspaceWorkbenchContributionRegistry.ts";
import { createWorkspaceWorkbenchHostInputWithDockEntries } from "./workspaceWorkbenchHostInput.ts";
import { confirmWorkspaceWindowClose } from "./workspaceWindowCloseCoordinator.ts";
import {
  readWorkspaceWallpaperDisplayModeFromSnapshot,
  readWorkspaceWallpaperIdFromSnapshot,
  type WorkspaceWallpaperDisplayMode,
  type WorkspaceWallpaperId,
  writeWorkspaceWallpaperDisplayModeToSnapshot,
  writeWorkspaceWallpaperIdToSnapshot
} from "../workspaceWallpaper";
import {
  hasWorkspaceOnboardingAutoOpened,
  writeWorkspaceOnboardingAutoOpenedToSnapshot
} from "../workspaceOnboarding.ts";
import { createWorkspaceAgentProviderDockStateSource } from "./workspaceAgentProviderDockStateSource.ts";
import { createWindowCloseRequestTracker } from "../windowCloseRequestTracker";
import { runWorkspaceAgentProviderDockAction } from "./workspaceAgentProviderDockActions.ts";
import { createWindowCloseDialogRequest } from "./workspaceCloseDialogRequests.ts";
import { assignWorkspaceTaskDockSection } from "./workspaceDockSections.ts";
import { createWorkspaceDynamicDockSignature } from "./workspaceDynamicDockSignature.ts";
import { createWorkbenchLaunchpadDockEntry } from "@tutti-os/workbench-launchpad";
import { createDesktopWorkspaceDockPreviewCache } from "./desktopWorkspaceDockPreviewCache.ts";
import type { IReporterService } from "../../../analytics/services/reporterService.interface.ts";
import type {
  DesktopHostNotificationNavigationPayload,
  DesktopWorkspaceAppOpenFileResolvedPayload,
  DesktopWorkspaceOpenFeatureRequest
} from "@shared/contracts/ipc";
import { SettingsCustomWallpaperClearedReporter } from "../../../analytics/reporters/settings-custom-wallpaper-cleared/settingsCustomWallpaperClearedReporter.ts";
import { SettingsCustomWallpaperUploadedReporter } from "../../../analytics/reporters/settings-custom-wallpaper-uploaded/settingsCustomWallpaperUploadedReporter.ts";
import {
  createWorkspaceBrowserService,
  type WorkspaceBrowserService
} from "./workspaceBrowserService.ts";
import {
  createWorkspaceDockImageIcon,
  resolveWorkspaceDockIconSet,
  type WorkspaceDockIconSet
} from "../workspaceDockIconStyle.ts";
import { createRichTextTriggerRegistry } from "@tutti-os/ui-rich-text/plugins";
import type { RichTextTriggerProvider } from "@tutti-os/ui-rich-text/types";
import { tuttiExternalAtProviderIds } from "@tutti-os/workspace-external-core/core";
import type {
  TuttiExternalAtQueryInput,
  TuttiExternalAtQueryResult
} from "@tutti-os/workspace-external-core/contracts";
import type { WorkspaceFileReferenceAdapter } from "@tutti-os/workspace-file-reference/contracts";
import type { WorkspaceUserProjectApi } from "@tutti-os/workspace-user-project/contracts";
import { serializeWorkspaceAppExternalAtMatch } from "./workspaceAppExternalAtSerialization.ts";
import { requestWorkspaceWorkbenchNodeLaunch } from "../workspaceWorkbenchNodeLaunchCoordinator.ts";
import {
  IAgentsService,
  type IAgentsService as AgentsService
} from "../../../workspace-agent/services/agentsService.interface.ts";

const workspaceDockNativePreviewMaxWidthPx = 260;
const workspaceDockNativePreviewMaxHeightPx = 170;
const workspaceDockNativePreviewTimeoutMs = 2_500;

export interface WorkspaceWorkbenchHostServiceDependencies {
  agentProviderStatusService: AgentProviderStatusService;
  agentsService: AgentsService;
  appCenterService: IWorkspaceAppCenterService;
  browserApi?: DesktopBrowserApi;
  browserService: WorkspaceBrowserService;
  computerUseApi: DesktopComputerUseApi;
  dockPreviewCacheApi: DesktopDockPreviewCacheApi;
  hostFilesApi: DesktopHostFilesApi;
  hostNotificationsApi: Pick<DesktopHostNotificationsApi, "onNavigate">;
  hostWindowApi: DesktopHostWindowApi;
  hostWorkspaceApi: Pick<
    DesktopHostWorkspaceApi,
    "broadcastAgentStatus" | "onOpenFeatureRequest" | "onOpenFileRequest"
  >;
  workspaceFileManagerService: IWorkspaceFileManagerService;
  workspaceUserProjectService: IWorkspaceUserProjectService;
  workspaceAgentActivityService: WorkspaceAgentActivityService;
  workspaceAgentPromptSessionService: WorkspaceAgentPromptSessionService;
  eventStreamClient?: TuttidEventStreamClient;
  tuttidClient: TuttidClient;
  platformApi: Pick<
    DesktopPlatformApi,
    "homeDirectory" | "os" | "resolveDroppedEntries" | "resolveDroppedPaths"
  >;
  repository: DesktopWorkspaceWorkbenchRepository;
  reporterService?: Pick<IReporterService, "trackEvents">;
  richTextAtService: IDesktopRichTextAtService;
  runtimeApi: DesktopRuntimeApi;
  wallpaperApi: DesktopWallpaperApi;
}

export interface WorkspaceWorkbenchHostExternalDependencies {
  browserApi?: DesktopBrowserApi;
  computerUseApi: DesktopComputerUseApi;
  dockPreviewCacheApi: DesktopDockPreviewCacheApi;
  eventStreamClient?: TuttidEventStreamClient;
  hostFilesApi: DesktopHostFilesApi;
  hostNotificationsApi: Pick<DesktopHostNotificationsApi, "onNavigate">;
  hostWindowApi: DesktopHostWindowApi;
  hostWorkspaceApi: Pick<
    DesktopHostWorkspaceApi,
    "broadcastAgentStatus" | "onOpenFeatureRequest" | "onOpenFileRequest"
  >;
  tuttidClient: TuttidClient;
  platformApi: Pick<
    DesktopPlatformApi,
    "homeDirectory" | "os" | "resolveDroppedEntries" | "resolveDroppedPaths"
  >;
  reporterService?: Pick<IReporterService, "trackEvents">;
  runtimeApi: DesktopRuntimeApi;
  wallpaperApi: DesktopWallpaperApi;
}

export class WorkspaceWorkbenchHostService implements IWorkspaceWorkbenchHostService {
  readonly _serviceBrand = undefined;
  private readonly cachedHostInputs = new Map<
    string,
    CachedWorkspaceWorkbenchHostInput
  >();
  private readonly dependencies: WorkspaceWorkbenchHostServiceDependencies;
  private readonly pendingWallpaperDisplayModes = new Map<
    string,
    WorkspaceWallpaperDisplayMode
  >();
  private readonly pendingWallpaperIds = new Map<
    string,
    WorkspaceWallpaperId
  >();
  private readonly wallpaperListeners = new Set<() => void>();
  private wallpaperRevision = 0;
  private readonly wallpaperWriteQueues = new Map<string, Promise<void>>();
  private customWallpaperFullUrl: string | null = null;
  private customWallpaperThumbnailUrl: string | null = null;
  private customWallpaperStatus: WorkspaceCustomWallpaperStatus = "idle";
  private customWallpaperSnapshot: WorkspaceCustomWallpaperSnapshot = {
    exists: false,
    fullUrl: null,
    status: "idle",
    thumbnailUrl: null
  };
  private readonly windowCloseRequestTracker =
    createWindowCloseRequestTracker();
  private agentGuiProviderTargetsPromise: Promise<
    readonly AgentGUIProviderTarget[]
  > | null = null;

  constructor(
    externalDependencies: WorkspaceWorkbenchHostExternalDependencies,
    richTextAtService: IDesktopRichTextAtService,
    agentsService: AgentsService,
    agentProviderStatusService: AgentProviderStatusService,
    workspaceAgentActivityService: WorkspaceAgentActivityService,
    workspaceAgentPromptSessionService: WorkspaceAgentPromptSessionService,
    appCenterService: IWorkspaceAppCenterService,
    workspaceFileManagerService: IWorkspaceFileManagerService,
    workspaceUserProjectService: IWorkspaceUserProjectService
  ) {
    const repository = createDesktopWorkspaceWorkbenchRepository(
      externalDependencies.tuttidClient
    );
    this.dependencies = {
      agentProviderStatusService,
      agentsService,
      appCenterService,
      browserApi: externalDependencies.browserApi,
      browserService: createWorkspaceBrowserService({
        browserApi: externalDependencies.browserApi
      }),
      computerUseApi: externalDependencies.computerUseApi,
      dockPreviewCacheApi: externalDependencies.dockPreviewCacheApi,
      eventStreamClient: externalDependencies.eventStreamClient,
      hostFilesApi: externalDependencies.hostFilesApi,
      hostNotificationsApi: externalDependencies.hostNotificationsApi,
      hostWindowApi: externalDependencies.hostWindowApi,
      hostWorkspaceApi: externalDependencies.hostWorkspaceApi,
      workspaceFileManagerService,
      workspaceUserProjectService,
      workspaceAgentActivityService,
      workspaceAgentPromptSessionService,
      tuttidClient: externalDependencies.tuttidClient,
      platformApi: externalDependencies.platformApi,
      repository,
      reporterService: externalDependencies.reporterService,
      richTextAtService,
      runtimeApi: externalDependencies.runtimeApi,
      wallpaperApi: externalDependencies.wallpaperApi
    };
    this.dependencies.repository.subscribe(() => {
      this.notifyWallpaperListeners();
    });
    this.subscribeWorkbenchNodeLaunchRequests();
    void this.loadCustomWallpaper();
  }

  approveWindowClose(): Promise<void> {
    return this.dependencies.hostWindowApi.approveClose();
  }

  loadAgentGuiProviderTargets(): Promise<readonly AgentGUIProviderTarget[]> {
    if (!this.agentGuiProviderTargetsPromise) {
      this.agentGuiProviderTargetsPromise = this.dependencies.agentsService
        .load()
        .then((snapshot) => snapshot.providerTargets)
        .catch(() => []);
    }
    return this.agentGuiProviderTargetsPromise;
  }

  onWindowCloseRequest(
    listener: Parameters<
      IWorkspaceWorkbenchHostService["onWindowCloseRequest"]
    >[0]
  ): () => void {
    return this.dependencies.hostWindowApi.onCloseRequest(listener);
  }

  onNotificationNavigate(
    listener: (payload: DesktopHostNotificationNavigationPayload) => void
  ): () => void {
    return this.dependencies.hostNotificationsApi.onNavigate(listener);
  }

  onOpenFeatureRequest(
    listener: (request: DesktopWorkspaceOpenFeatureRequest) => void
  ): () => void {
    return this.dependencies.hostWorkspaceApi.onOpenFeatureRequest(listener);
  }

  createWorkspaceAppExternalFileReferenceAdapter(
    workspaceId: string
  ): WorkspaceFileReferenceAdapter {
    return createDesktopWorkspaceFileReferenceAdapter({
      hostFilesApi: this.dependencies.hostFilesApi,
      tuttidClient: this.dependencies.tuttidClient,
      workspaceId
    });
  }

  createWorkspaceAppExternalUserProjectApi(): WorkspaceUserProjectApi {
    return createWorkspaceAppExternalUserProjectApi(
      this.dependencies.workspaceUserProjectService
    );
  }

  openExternal(url: string): Promise<void> {
    return this.dependencies.hostFilesApi.openExternal(url);
  }

  async queryWorkspaceAppExternalAt(input: {
    query: TuttiExternalAtQueryInput;
    workspaceId: string;
  }): Promise<TuttiExternalAtQueryResult[]> {
    const providerIds = new Set(
      input.query.providers !== undefined
        ? input.query.providers
        : tuttiExternalAtProviderIds
    );
    const richTextCapabilities = [...providerIds].filter(
      (providerId) => providerId !== "agent-generated-file"
    );
    const providers: RichTextTriggerProvider[] = [
      ...this.dependencies.richTextAtService.getProviders({
        capabilities: richTextCapabilities,
        surface: "workspace-app-external",
        target: "workspace-app",
        workspaceId: input.workspaceId
      })
    ];
    if (providerIds.has("agent-generated-file")) {
      const agentGeneratedFileProvider =
        createDesktopAgentGeneratedFileMentionProvider({
          agentActivityRuntime: this.dependencies.workspaceAgentActivityService,
          workspaceId: input.workspaceId
        });
      providers.push({
        ...agentGeneratedFileProvider,
        trigger: "@"
      });
    }
    const registry = createRichTextTriggerRegistry(providers);
    const matches = await registry.query({
      keyword: input.query.keyword,
      maxResults: input.query.maxResults,
      trigger: "@",
      context: {
        metadata: {
          workspaceId: input.workspaceId
        }
      }
    });
    return matches
      .map(serializeWorkspaceAppExternalAtMatch)
      .filter(
        (result): result is TuttiExternalAtQueryResult => result !== null
      );
  }

  onOpenFileRequest(
    listener: (request: DesktopWorkspaceAppOpenFileResolvedPayload) => void
  ): () => void {
    return this.dependencies.hostWorkspaceApi.onOpenFileRequest(listener);
  }

  async hasWorkspaceOnboardingAutoOpened(
    workspaceId: string
  ): Promise<boolean> {
    const cachedSnapshot = this.dependencies.repository.readCached(workspaceId);
    const snapshot = cachedSnapshot
      ? cachedSnapshot
      : await this.dependencies.repository.load(workspaceId);
    return hasWorkspaceOnboardingAutoOpened(snapshot);
  }

  logWorkspaceOnboardingAutoOpenDiagnostic(
    diagnostic: WorkspaceOnboardingAutoOpenDiagnostic
  ): void {
    void this.dependencies.runtimeApi
      .logRendererDiagnostic({
        details: diagnostic.details ?? {},
        event: diagnostic.event,
        level: diagnostic.level,
        source: "workspace-workbench",
        workspaceId: diagnostic.workspaceId
      })
      .catch(() => undefined);
  }

  async markWorkspaceOnboardingAutoOpened(workspaceId: string): Promise<void> {
    const cachedSnapshot = this.dependencies.repository.readCached(workspaceId);
    const snapshot = cachedSnapshot
      ? cachedSnapshot
      : await this.dependencies.repository.load(workspaceId);
    await this.dependencies.repository.save(
      workspaceId,
      writeWorkspaceOnboardingAutoOpenedToSnapshot(snapshot)
    );
  }

  readWallpaperDisplayMode(workspaceId: string) {
    return (
      this.pendingWallpaperDisplayModes.get(workspaceId) ??
      readWorkspaceWallpaperDisplayModeFromSnapshot(
        this.dependencies.repository.readCached(workspaceId)
      )
    );
  }

  readWallpaperId(workspaceId: string) {
    return (
      this.pendingWallpaperIds.get(workspaceId) ??
      readWorkspaceWallpaperIdFromSnapshot(
        this.dependencies.repository.readCached(workspaceId)
      )
    );
  }

  resolveWindowCloseRequest(input: {
    outcome: "approved" | "blocked";
    requestId: string;
  }): void {
    this.dependencies.hostWindowApi.resolveCloseRequest(input);
  }

  requestWindowClose(input: {
    confirmCloseGuard(
      request: WorkbenchHostCloseDialogRequest
    ): Promise<boolean>;
    host: WorkbenchHostHandle | null;
    hostInput: WorkspaceWorkbenchHostInput;
    reason: Parameters<
      IWorkspaceWorkbenchHostService["requestWindowClose"]
    >[0]["reason"];
  }): Promise<"approved" | "blocked"> {
    return confirmWorkspaceWindowClose({
      ...input,
      requestApprovedClose: () => this.approveWindowClose(),
      tracker: this.windowCloseRequestTracker
    });
  }

  writeWallpaperDisplayMode(
    workspaceId: string,
    displayMode: WorkspaceWallpaperDisplayMode
  ) {
    this.pendingWallpaperDisplayModes.set(workspaceId, displayMode);
    this.enqueueWallpaperPersist(workspaceId);
  }

  writeWallpaperId(workspaceId: string, wallpaperId: WorkspaceWallpaperId) {
    this.pendingWallpaperIds.set(workspaceId, wallpaperId);
    this.enqueueWallpaperPersist(workspaceId);
  }

  private enqueueWallpaperPersist(workspaceId: string): void {
    this.notifyWallpaperListeners();

    const previousWrite =
      this.wallpaperWriteQueues.get(workspaceId) ?? Promise.resolve();
    const nextWrite = previousWrite
      .catch(noop)
      .then(() => this.persistPendingWallpaperSettings(workspaceId));
    this.wallpaperWriteQueues.set(workspaceId, nextWrite);
    void nextWrite.finally(() => {
      if (this.wallpaperWriteQueues.get(workspaceId) === nextWrite) {
        this.wallpaperWriteQueues.delete(workspaceId);
      }
    });
  }

  getWallpaperRevision(): number {
    return this.wallpaperRevision;
  }

  getCustomWallpaperSnapshot(): WorkspaceCustomWallpaperSnapshot {
    return this.customWallpaperSnapshot;
  }

  getCustomWallpaperUrl(): string | null {
    return this.customWallpaperFullUrl;
  }

  async uploadCustomWallpaper(file: File): Promise<void> {
    this.setCustomWallpaperStatus("saving");
    try {
      const processed = await processCustomWallpaperImage(file);
      const saved = await this.dependencies.wallpaperApi.setCustom(processed);
      this.applyCustomWallpaperImage(saved);
      this.reportCustomWallpaperUploaded({
        height: processed.height,
        mimeType: processed.mimeType,
        width: processed.width
      });
      this.setCustomWallpaperStatus("idle");
    } catch (error) {
      this.setCustomWallpaperStatus("idle");
      throw error;
    }
  }

  async removeCustomWallpaper(): Promise<void> {
    this.setCustomWallpaperStatus("removing");
    try {
      await this.dependencies.wallpaperApi.clearCustom();
      this.clearCustomWallpaperUrls();
      this.customWallpaperStatus = "idle";
      this.refreshCustomWallpaperSnapshot();
      this.notifyWallpaperListeners();
      this.reportCustomWallpaperCleared();
    } catch (error) {
      this.setCustomWallpaperStatus("idle");
      throw error;
    }
  }

  private async loadCustomWallpaper(): Promise<void> {
    try {
      const stored = await this.dependencies.wallpaperApi.getCustom();
      if (stored) {
        this.applyCustomWallpaperImage(stored);
      }
    } catch (error) {
      void this.dependencies.runtimeApi.logRendererDiagnostic({
        details: { message: String(error) },
        event: "custom-wallpaper.load.failed",
        level: "warn",
        source: "workspace-workbench-host-service"
      });
    }
  }

  private reportCustomWallpaperUploaded(input: {
    height: number;
    mimeType: string;
    width: number;
  }): void {
    const reporterService = this.dependencies.reporterService;
    if (!reporterService) {
      return;
    }

    void new SettingsCustomWallpaperUploadedReporter(
      {
        height: input.height,
        mimeType: input.mimeType,
        width: input.width
      },
      {
        reporterService
      }
    ).report();
  }

  private reportCustomWallpaperCleared(): void {
    const reporterService = this.dependencies.reporterService;
    if (!reporterService) {
      return;
    }

    void new SettingsCustomWallpaperClearedReporter(
      {},
      {
        reporterService
      }
    ).report();
  }

  private applyCustomWallpaperImage(image: DesktopCustomWallpaperImage): void {
    this.clearCustomWallpaperUrls();
    this.customWallpaperFullUrl = createObjectUrlFromBytes(
      image.bytes,
      image.mimeType
    );
    this.customWallpaperThumbnailUrl = createObjectUrlFromBytes(
      image.thumbnailBytes,
      image.thumbnailMimeType
    );
    this.refreshCustomWallpaperSnapshot();
    this.notifyWallpaperListeners();
  }

  private clearCustomWallpaperUrls(): void {
    if (this.customWallpaperFullUrl) {
      URL.revokeObjectURL(this.customWallpaperFullUrl);
      this.customWallpaperFullUrl = null;
    }
    if (this.customWallpaperThumbnailUrl) {
      URL.revokeObjectURL(this.customWallpaperThumbnailUrl);
      this.customWallpaperThumbnailUrl = null;
    }
  }

  private setCustomWallpaperStatus(
    status: WorkspaceCustomWallpaperStatus
  ): void {
    this.customWallpaperStatus = status;
    this.refreshCustomWallpaperSnapshot();
    this.notifyWallpaperListeners();
  }

  private refreshCustomWallpaperSnapshot(): void {
    this.customWallpaperSnapshot = {
      exists: this.customWallpaperFullUrl !== null,
      fullUrl: this.customWallpaperFullUrl,
      status: this.customWallpaperStatus,
      thumbnailUrl: this.customWallpaperThumbnailUrl
    };
  }

  getHomeDirectory(): string {
    return this.dependencies.platformApi.homeDirectory;
  }

  async ensureAgentProviderStatusesLoaded(): Promise<void> {
    await this.dependencies.agentProviderStatusService.ensureLoaded();
  }

  subscribeWallpaperChanges(listener: () => void): () => void {
    this.wallpaperListeners.add(listener);
    return () => {
      this.wallpaperListeners.delete(listener);
    };
  }

  broadcastAgentStatus(payload: { agentBound: boolean }): void {
    this.dependencies.hostWorkspaceApi.broadcastAgentStatus(payload);
  }

  private subscribeWorkbenchNodeLaunchRequests(): void {
    const eventStreamClient = this.dependencies.eventStreamClient;
    if (!eventStreamClient) {
      return;
    }
    eventStreamClient.subscribe(
      "workspace.workbench.node.launch.requested",
      (event) => {
        const payload = event.payload;
        void requestWorkspaceWorkbenchNodeLaunch({
          ...(payload.dockEntryId ? { dockEntryId: payload.dockEntryId } : {}),
          ...(payload.launchSource
            ? { launchSource: payload.launchSource }
            : {}),
          payload: payload.payload,
          typeId: payload.typeId,
          workspaceId: payload.workspaceId
        }).catch((error: unknown) => {
          void this.dependencies.runtimeApi.logTerminalDiagnostic({
            details: { error: formatDiagnosticError(error) },
            event: "workbench.node.launch.request_failed",
            level: "warn",
            workspaceId: payload.workspaceId
          });
        });
      }
    );
    void eventStreamClient.connect().catch((error: unknown) => {
      void this.dependencies.runtimeApi.logTerminalDiagnostic({
        details: { error: formatDiagnosticError(error) },
        event: "workbench.node.launch.event_stream_connect_failed",
        level: "warn",
        workspaceId: null
      });
    });
  }

  private async persistPendingWallpaperSettings(
    workspaceId: string
  ): Promise<void> {
    const wallpaperId = this.pendingWallpaperIds.get(workspaceId);
    const displayMode = this.pendingWallpaperDisplayModes.get(workspaceId);
    if (wallpaperId === undefined && displayMode === undefined) {
      return;
    }

    const cachedSnapshot = this.dependencies.repository.readCached(workspaceId);
    let snapshot = cachedSnapshot
      ? cachedSnapshot
      : await this.dependencies.repository.load(workspaceId);
    if (wallpaperId !== undefined) {
      snapshot = writeWorkspaceWallpaperIdToSnapshot(snapshot, wallpaperId);
    }
    if (displayMode !== undefined) {
      snapshot = writeWorkspaceWallpaperDisplayModeToSnapshot(
        snapshot,
        displayMode
      );
    }

    const savedSnapshot = await this.dependencies.repository.save(
      workspaceId,
      snapshot
    );

    if (
      wallpaperId !== undefined &&
      this.pendingWallpaperIds.get(workspaceId) === wallpaperId
    ) {
      this.pendingWallpaperIds.delete(workspaceId);
    }
    if (
      displayMode !== undefined &&
      this.pendingWallpaperDisplayModes.get(workspaceId) === displayMode
    ) {
      this.pendingWallpaperDisplayModes.delete(workspaceId);
    }

    const wallpaperPersisted =
      wallpaperId === undefined ||
      readWorkspaceWallpaperIdFromSnapshot(savedSnapshot) === wallpaperId;
    const displayModePersisted =
      displayMode === undefined ||
      readWorkspaceWallpaperDisplayModeFromSnapshot(savedSnapshot) ===
        displayMode;
    if (wallpaperPersisted && displayModePersisted) {
      this.notifyWallpaperListeners();
    }
  }

  private notifyWallpaperListeners(): void {
    this.wallpaperRevision += 1;
    for (const listener of this.wallpaperListeners) {
      listener();
    }
  }

  createHostInput(input: {
    appI18n: I18nRuntime<string>;
    confirmCloseGuard: (
      request: WorkbenchHostCloseDialogRequest
    ) => Promise<boolean> | boolean;
    i18n: WorkspaceWorkbenchDesktopI18nRuntime;
    appCenterRevision?: number;
    dockIconStyle: DesktopDockIconStyle;
    themeAppearance: DesktopThemeAppearance;
    defaultAgentProvider?: string | null;
    defaultProviderTargetId?: string | null;
    onCapabilitySettingsRequest?: (
      target: WorkspaceWorkbenchCapabilitySettingsTarget
    ) => void;
    providerTargets?: readonly AgentGUIProviderTarget[];
    providerTargetsLoading?: boolean;
    renderFilesNodeBody: (
      context: WorkspaceWorkbenchBodyRendererContext
    ) => ReactNode;
    workspaceId: string;
  }): WorkspaceWorkbenchHostInput {
    const cached = this.cachedHostInputs.get(input.workspaceId);
    if (
      cached &&
      cached.appI18n === input.appI18n &&
      cached.defaultAgentProvider === input.defaultAgentProvider &&
      cached.defaultProviderTargetId === input.defaultProviderTargetId &&
      cached.dockIconStyle === input.dockIconStyle &&
      cached.i18n === input.i18n &&
      cached.providerTargets === input.providerTargets &&
      cached.providerTargetsLoading === input.providerTargetsLoading &&
      cached.themeAppearance === input.themeAppearance
    ) {
      cached.capabilitySettingsRequestRef.current =
        input.onCapabilitySettingsRequest;
      cached.confirmCloseGuardRef.current = input.confirmCloseGuard;
      cached.renderFilesNodeBodyRef.current = input.renderFilesNodeBody;
      return this.createHostInputWithDynamicDockEntries(
        cached,
        cached.baseHostInput,
        {
          appI18n: input.appI18n,
          desktopI18n: cached.i18n
        }
      );
    }

    const renderFilesNodeBodyRef = {
      current: input.renderFilesNodeBody
    };
    const capabilitySettingsRequestRef = {
      current: input.onCapabilitySettingsRequest
    };
    const confirmCloseGuardRef = {
      current: input.confirmCloseGuard
    };
    const dockPreviewCache = createDesktopWorkspaceDockPreviewCache(
      this.dependencies.dockPreviewCacheApi
    );
    const dockIcons = resolveWorkspaceDockIconSet({
      appearance: input.themeAppearance,
      style: input.dockIconStyle
    });
    const contributionRegistry =
      createWorkspaceWorkbenchContributionRegistryResult({
        context: {
          appI18n: input.appI18n,
          appCenterService: this.dependencies.appCenterService,
          browserApi: this.dependencies.browserApi,
          browserService: this.dependencies.browserService,
          computerUseApi: this.dependencies.computerUseApi,
          confirmCloseGuard: (request) => confirmCloseGuardRef.current(request),
          dockPreviewCache,
          defaultAgentProvider: input.defaultAgentProvider,
          defaultProviderTargetId: input.defaultProviderTargetId,
          dockIcons: {
            agentUnified: dockIcons.agentUnified,
            agents: dockIcons.agents,
            applications: dockIcons.applications,
            browser: dockIcons.browser,
            files: createWorkspaceDockImageIcon(dockIcons.files),
            issue: dockIcons.issue,
            terminal: createWorkspaceDockImageIcon(dockIcons.terminal)
          },
          hostFilesApi: this.dependencies.hostFilesApi,
          i18n: input.i18n,
          onCapabilitySettingsRequest: (target) => {
            capabilitySettingsRequestRef.current?.(target);
          },
          providerTargets: input.providerTargets,
          providerTargetsLoading: input.providerTargetsLoading,
          agentProviderStatusService:
            this.dependencies.agentProviderStatusService,
          eventStreamClient: this.dependencies.eventStreamClient,
          workspaceFileManagerService:
            this.dependencies.workspaceFileManagerService,
          workspaceUserProjectService:
            this.dependencies.workspaceUserProjectService,
          workspaceAgentActivityService:
            this.dependencies.workspaceAgentActivityService,
          workspaceAgentPromptSessionService:
            this.dependencies.workspaceAgentPromptSessionService,
          tuttidClient: this.dependencies.tuttidClient,
          platformApi: this.dependencies.platformApi,
          reporterService: this.dependencies.reporterService,
          renderFilesNodeBody: (context) =>
            renderFilesNodeBodyRef.current(context),
          richTextAtService: this.dependencies.richTextAtService,
          runtimeApi: this.dependencies.runtimeApi,
          workspaceId: input.workspaceId
        },
        factories: defaultWorkspaceWorkbenchContributionFactories
      });

    const baseHostInput: WorkspaceWorkbenchHostInput = {
      captureNodePreviewImage: createDesktopWorkspaceNodePreviewCapture(
        this.dependencies.hostWindowApi,
        this.dependencies.runtimeApi,
        input.workspaceId
      ),
      contributions: contributionRegistry.contributions,
      debugDiagnostics: createWorkspaceWorkbenchDebugDiagnostics(
        this.dependencies.runtimeApi,
        input.workspaceId
      ),
      dockPreviewCache,
      dockStateSource: createWorkspaceAgentProviderDockStateSource({
        agentProviderStatusService:
          this.dependencies.agentProviderStatusService,
        i18n: input.i18n,
        workspaceAgentActivityService:
          this.dependencies.workspaceAgentActivityService,
        workspaceId: input.workspaceId
      }),
      prepareHostClose: resolveWorkbenchHostPrepareClose(
        contributionRegistry.contributions
      ),
      createWindowCloseDialogRequest: (effects) =>
        createWindowCloseDialogRequest({
          effects,
          i18n: input.i18n
        }),
      onDockEntryAction: ({ actionId, entryId, host }) =>
        runWorkspaceAgentProviderDockAction({
          actionId,
          agentProviderStatusService:
            this.dependencies.agentProviderStatusService,
          entryId,
          host,
          workspaceId: input.workspaceId
        }),
      onDockEntryClick: ({ entryId }) =>
        reportWorkspaceAppOpenedFromDockEntry({
          appCenterService: this.dependencies.appCenterService,
          entryId,
          reporterService: this.dependencies.reporterService
        }),
      snapshotRepository: this.dependencies.repository,
      workspaceId: input.workspaceId
    };
    const cachedHostInput: CachedWorkspaceWorkbenchHostInput = {
      appI18n: input.appI18n,
      baseHostInput,
      capabilitySettingsRequestRef,
      confirmCloseGuardRef,
      defaultAgentProvider: input.defaultAgentProvider,
      defaultProviderTargetId: input.defaultProviderTargetId,
      dockIconStyle: input.dockIconStyle,
      dockIcons,
      i18n: input.i18n,
      providerTargets: input.providerTargets,
      providerTargetsLoading: input.providerTargetsLoading,
      renderFilesNodeBodyRef,
      themeAppearance: input.themeAppearance
    };
    this.cachedHostInputs.set(input.workspaceId, cachedHostInput);
    return this.createHostInputWithDynamicDockEntries(
      cachedHostInput,
      baseHostInput,
      {
        appI18n: input.appI18n,
        desktopI18n: input.i18n
      }
    );
  }

  private createHostInputWithDynamicDockEntries(
    cached: CachedWorkspaceWorkbenchHostInput,
    baseHostInput: WorkspaceWorkbenchHostInput,
    input: {
      appI18n: I18nRuntime<string>;
      desktopI18n: WorkspaceWorkbenchDesktopI18nRuntime;
    }
  ): WorkspaceWorkbenchHostInput {
    const dockSignature = createWorkspaceDynamicDockSignature({
      agentProviderRevision:
        this.dependencies.agentProviderStatusService.getRevision(),
      apps: this.dependencies.appCenterService.store.apps
    });
    if (
      cached?.dynamicHostInput &&
      cached.dynamicAppI18n === input.appI18n &&
      cached.dynamicDockSignature === dockSignature
    ) {
      return cached.dynamicHostInput;
    }

    const captureBrowserPreview = this.dependencies.browserApi?.capturePreview;
    const dynamicHostInput = createWorkspaceWorkbenchHostInputWithDockEntries(
      baseHostInput,
      [
        ...assignWorkspaceTaskDockSection(
          createWorkspaceAppCenterDockEntries({
            appCenterIconUrl: cached?.dockIcons.applications,
            appCenterService: this.dependencies.appCenterService,
            captureWebviewPreview: captureBrowserPreview
              ? (nodeId) => captureBrowserPreview({ nodeId })
              : undefined,
            i18n: input.appI18n
          })
        ),
        createWorkbenchLaunchpadDockEntry({
          label: input.desktopI18n.t(
            workspaceWorkbenchDesktopI18nKeys.launchpad.dockLabel
          ),
          tileIconUrls: cached.dockIcons.launchpadTiles
        })
      ]
    );
    cached.dynamicAppI18n = input.appI18n;
    cached.dynamicDockSignature = dockSignature;
    cached.dynamicHostInput = dynamicHostInput;
    return dynamicHostInput;
  }
}

function formatDiagnosticError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createDesktopWorkspaceNodePreviewCapture(
  hostWindowApi: DesktopHostWindowApi,
  runtimeApi: Pick<DesktopRuntimeApi, "logRendererDiagnostic">,
  workspaceId: string
): NonNullable<WorkspaceWorkbenchHostInput["captureNodePreviewImage"]> {
  return async (node) => {
    if (node.isMinimized || document.visibilityState !== "visible") {
      logDockPreviewCaptureDiagnostic(runtimeApi, workspaceId, {
        details: {
          documentVisibilityState: document.visibilityState,
          isMinimized: node.isMinimized,
          nodeId: node.id,
          typeId: node.data.typeId
        },
        event: "dock_preview_capture.skipped",
        level: "debug"
      });
      return null;
    }

    const captureContext = resolveWorkspaceNodeCaptureTarget(node.id);
    if (!captureContext) {
      logDockPreviewCaptureDiagnostic(runtimeApi, workspaceId, {
        details: {
          nodeId: node.id,
          typeId: node.data.typeId
        },
        event: "dock_preview_capture.target_missing",
        level: "warn"
      });
      return null;
    }

    const { captureTarget, windowElement } = captureContext;
    if (!isForegroundWorkspaceNodeCaptureTarget(windowElement)) {
      return null;
    }

    const rect = captureTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      logDockPreviewCaptureDiagnostic(runtimeApi, workspaceId, {
        details: {
          height: rect.height,
          nodeId: node.id,
          typeId: node.data.typeId,
          width: rect.width,
          x: rect.left,
          y: rect.top
        },
        event: "dock_preview_capture.invalid_rect",
        level: "warn"
      });
      return null;
    }

    const nativeCaptureBlockReason = resolveNativeCaptureBlockReason(
      captureTarget,
      rect
    );
    if (nativeCaptureBlockReason) {
      logDockPreviewCaptureDiagnostic(runtimeApi, workspaceId, {
        details: {
          height: rect.height,
          nodeId: node.id,
          reason: nativeCaptureBlockReason,
          typeId: node.data.typeId,
          width: rect.width,
          x: rect.left,
          y: rect.top
        },
        event: "dock_preview_capture.native_skipped",
        level: "debug"
      });
      return null;
    }

    const captureStartedAt = performance.now();
    logDockPreviewCaptureDiagnostic(runtimeApi, workspaceId, {
      details: {
        height: rect.height,
        nodeId: node.id,
        timeoutMs: workspaceDockNativePreviewTimeoutMs,
        typeId: node.data.typeId,
        width: rect.width,
        x: rect.left,
        y: rect.top
      },
      event: "dock_preview_capture.started",
      level: "info"
    });

    let captureResult: DockPreviewCaptureResult;
    try {
      const capturePromise = hostWindowApi.capturePreview({
        maxHeight: workspaceDockNativePreviewMaxHeightPx,
        maxWidth: workspaceDockNativePreviewMaxWidthPx,
        rect: {
          height: rect.height,
          width: rect.width,
          x: rect.left,
          y: rect.top
        }
      });
      capturePromise.catch(() => undefined);
      captureResult = await resolveDockPreviewCaptureWithTimeout(
        capturePromise,
        workspaceDockNativePreviewTimeoutMs
      );
    } catch (error) {
      logDockPreviewCaptureDiagnostic(runtimeApi, workspaceId, {
        details: {
          durationMs: Math.round(performance.now() - captureStartedAt),
          error: error instanceof Error ? error.message : String(error),
          nodeId: node.id,
          typeId: node.data.typeId
        },
        event: "dock_preview_capture.ipc_failed",
        level: "warn"
      });
      return null;
    }

    if (captureResult.status === "timeout") {
      logDockPreviewCaptureDiagnostic(runtimeApi, workspaceId, {
        details: {
          durationMs: Math.round(performance.now() - captureStartedAt),
          nodeId: node.id,
          timeoutMs: workspaceDockNativePreviewTimeoutMs,
          typeId: node.data.typeId
        },
        event: "dock_preview_capture.timed_out",
        level: "warn"
      });
      return null;
    }

    const previewImageUrl = captureResult.previewImageUrl;

    if (!previewImageUrl) {
      logDockPreviewCaptureDiagnostic(runtimeApi, workspaceId, {
        details: {
          durationMs: Math.round(performance.now() - captureStartedAt),
          height: rect.height,
          nodeId: node.id,
          typeId: node.data.typeId,
          width: rect.width,
          x: rect.left,
          y: rect.top
        },
        event: "dock_preview_capture.empty_result",
        level: "warn"
      });
    } else {
      logDockPreviewCaptureDiagnostic(runtimeApi, workspaceId, {
        details: {
          durationMs: Math.round(performance.now() - captureStartedAt),
          nodeId: node.id,
          previewLength: previewImageUrl.length,
          typeId: node.data.typeId
        },
        event: "dock_preview_capture.succeeded",
        level: "info"
      });
    }

    return previewImageUrl;
  };
}

function resolveNativeCaptureBlockReason(
  _target: HTMLElement,
  rect: DOMRect
): "outside_viewport" | null {
  if (
    rect.left < 0 ||
    rect.top < 0 ||
    rect.right > window.innerWidth ||
    rect.bottom > window.innerHeight
  ) {
    return "outside_viewport";
  }
  return null;
}

function isForegroundWorkspaceNodeCaptureTarget(
  windowElement: HTMLElement
): boolean {
  return windowElement.dataset.focused === "true";
}

type DockPreviewCaptureResult =
  | {
      previewImageUrl: string | null;
      status: "resolved";
    }
  | {
      status: "timeout";
    };

function resolveDockPreviewCaptureWithTimeout(
  capturePromise: Promise<string | null>,
  timeoutMs: number
): Promise<DockPreviewCaptureResult> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<DockPreviewCaptureResult>((resolve) => {
    timeout = setTimeout(() => resolve({ status: "timeout" }), timeoutMs);
  });
  return Promise.race([
    capturePromise.then((previewImageUrl) => ({
      previewImageUrl,
      status: "resolved" as const
    })),
    timeoutPromise
  ]).finally(() => {
    if (timeout) {
      clearTimeout(timeout);
    }
  });
}

function logDockPreviewCaptureDiagnostic(
  runtimeApi: Pick<DesktopRuntimeApi, "logRendererDiagnostic">,
  workspaceId: string,
  input: {
    details: Record<string, unknown>;
    event: string;
    level: "debug" | "info" | "warn";
  }
): void {
  void runtimeApi
    .logRendererDiagnostic({
      details: input.details,
      event: input.event,
      level: input.level,
      source: "workspace-workbench",
      workspaceId
    })
    .catch(() => undefined);
}

function resolveWorkspaceNodeCaptureTarget(nodeId: string): {
  captureTarget: HTMLElement;
  windowElement: HTMLElement;
} | null {
  const windowElement =
    Array.from(
      document.querySelectorAll<HTMLElement>("[data-workbench-window-id]")
    ).find((candidate) => candidate.dataset.workbenchWindowId === nodeId) ??
    null;
  if (!windowElement) {
    return null;
  }
  const captureTarget =
    windowElement.querySelector<HTMLElement>(
      '[data-workbench-window-capture="true"]'
    ) ??
    windowElement.querySelector<HTMLElement>(".workbench-window") ??
    windowElement;
  return { captureTarget, windowElement };
}

// Avoid decorator syntax so the renderer Babel pass can parse this file.
IDesktopRichTextAtService(WorkspaceWorkbenchHostService, undefined, 1);
IAgentsService(WorkspaceWorkbenchHostService, undefined, 2);
IAgentProviderStatusService(WorkspaceWorkbenchHostService, undefined, 3);
IWorkspaceAgentActivityService(WorkspaceWorkbenchHostService, undefined, 4);
IWorkspaceAgentPromptSessionService(
  WorkspaceWorkbenchHostService,
  undefined,
  5
);
IWorkspaceAppCenterService(WorkspaceWorkbenchHostService, undefined, 6);
IWorkspaceFileManagerService(WorkspaceWorkbenchHostService, undefined, 7);
IWorkspaceUserProjectService(WorkspaceWorkbenchHostService, undefined, 8);

export function createWorkspaceAppExternalUserProjectApi(
  service: IWorkspaceUserProjectService
): WorkspaceUserProjectApi {
  return {
    checkPath: (input) => service.checkProjectPath(input.path),
    create: (input) => service.createProject(input.name),
    getDefaultSelection: () => service.getDefaultSelection(),
    getSnapshot: () =>
      Promise.resolve(cloneWorkspaceUserProjectServiceSnapshot(service)),
    list: async () => {
      await service.ensureLoaded();
      return {
        projects: service.store.projects.map((project) => ({ ...project }))
      };
    },
    prepareSelection: (input) => service.prepareSelection(input),
    refresh: async () => {
      await service.refresh();
      return cloneWorkspaceUserProjectServiceSnapshot(service);
    },
    rememberDefaultSelection: (input) =>
      service.rememberDefaultSelection(input),
    selectDirectory: () => service.selectDirectory(),
    subscribe: (listener) =>
      service.subscribe(() => {
        listener(cloneWorkspaceUserProjectServiceSnapshot(service));
      }),
    use: (input) => service.registerProjectPath(input.path)
  };
}

function cloneWorkspaceUserProjectServiceSnapshot(
  service: IWorkspaceUserProjectService
): ReturnType<IWorkspaceUserProjectService["getSnapshot"]> {
  const snapshot = service.getSnapshot();
  return {
    ...snapshot,
    projects: snapshot.projects.map((project) => ({ ...project }))
  };
}

interface CachedWorkspaceWorkbenchHostInput {
  appI18n: I18nRuntime<string>;
  baseHostInput: WorkspaceWorkbenchHostInput;
  capabilitySettingsRequestRef: {
    current:
      | ((target: WorkspaceWorkbenchCapabilitySettingsTarget) => void)
      | undefined;
  };
  confirmCloseGuardRef: {
    current: (
      request: WorkbenchHostCloseDialogRequest
    ) => Promise<boolean> | boolean;
  };
  defaultAgentProvider?: string | null;
  defaultProviderTargetId?: string | null;
  dockIconStyle: DesktopDockIconStyle;
  dockIcons: WorkspaceDockIconSet;
  dynamicAppI18n?: I18nRuntime<string>;
  dynamicDockSignature?: string;
  dynamicHostInput?: WorkspaceWorkbenchHostInput;
  i18n: WorkspaceWorkbenchDesktopI18nRuntime;
  providerTargets?: readonly AgentGUIProviderTarget[];
  providerTargetsLoading?: boolean;
  renderFilesNodeBodyRef: {
    current: (context: WorkspaceWorkbenchBodyRendererContext) => ReactNode;
  };
  themeAppearance: DesktopThemeAppearance;
}

function noop(): void {}

function createObjectUrlFromBytes(bytes: Uint8Array, mimeType: string): string {
  const copy = new Uint8Array(bytes);
  return URL.createObjectURL(new Blob([copy], { type: mimeType }));
}

function createWorkspaceWorkbenchDebugDiagnostics(
  runtimeApi: DesktopRuntimeApi,
  workspaceId: string
): WorkbenchDebugDiagnostics {
  return {
    isEnabled() {
      try {
        return (
          globalThis.localStorage?.getItem("tuttiWorkbenchDebugFrames") === "1"
        );
      } catch {
        return false;
      }
    },
    log(input) {
      return runtimeApi.logRendererDiagnostic({
        details: input.details,
        event: input.event,
        level: input.level,
        source: input.source,
        workspaceId
      });
    }
  };
}
