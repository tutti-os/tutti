import type {
  WorkbenchHostCloseDialogRequest,
  WorkbenchHostHandle
} from "@tutti-os/workbench-surface";
import type {
  IWorkspaceWorkbenchHostService,
  WorkspaceOnboardingAutoOpenDiagnostic,
  WorkspaceCustomWallpaperSnapshot,
  WorkspaceCustomWallpaperStatus,
  WorkspaceWorkbenchHostInput,
  WorkspaceWorkbenchHostSessionBinding,
  WorkspaceWorkbenchHostSessionUpdate
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
import { IDesktopRichTextAtService } from "../../../rich-text-at/services/richTextAtService.interface.ts";
import {
  IAgentProviderStatusService,
  type IAgentProviderStatusService as AgentProviderStatusService
} from "../../../workspace-agent/services/agentProviderStatusService.interface.ts";
import type { IAgentQuickPromptService as AgentQuickPromptService } from "../../../workspace-agent/services/agentQuickPromptService.interface.ts";
import {
  IWorkspaceAgentActivityService,
  type IWorkspaceAgentActivityService as WorkspaceAgentActivityService
} from "../../../workspace-agent/services/workspaceAgentActivityService.interface.ts";
import {
  IWorkspaceAgentPromptSessionService,
  type IWorkspaceAgentPromptSessionService as WorkspaceAgentPromptSessionService
} from "../../../workspace-agent/services/workspaceAgentPromptSessionService.interface.ts";
import { IWorkspaceAppCenterService } from "@renderer/features/workspace-app-center/services/workspaceAppCenterService.interface.ts";
import { createDesktopAgentGeneratedFileMentionProvider } from "@renderer/features/workspace-agent/services/createDesktopAgentGeneratedFileMentionProvider.ts";
import { IWorkspaceFileManagerService } from "../../../workspace-file-manager/services/workspaceFileManagerService.interface.ts";
import { IWorkspaceFilePreviewSurfaceHost } from "../../../workspace-file-preview/services/workspaceFilePreviewSurfaceHost.interface.ts";
import { createDesktopWorkspaceFileReferenceAdapter } from "../../../workspace-file-manager/services/createDesktopWorkspaceFileReferenceAdapter.ts";
import { IWorkspaceUserProjectService } from "../../../workspace-user-project/services/workspaceUserProjectService.interface.ts";
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
import { createWindowCloseRequestTracker } from "../windowCloseRequestTracker";
import type { IReporterService } from "../../../analytics/services/reporterService.interface.ts";
import type {
  DesktopHostNotificationNavigationPayload,
  DesktopWorkspaceAppOpenFileResolvedPayload,
  DesktopWorkspaceOpenFeatureRequest
} from "@shared/contracts/ipc";
import { SettingsCustomWallpaperClearedReporter } from "../../../analytics/reporters/settings-custom-wallpaper-cleared/settingsCustomWallpaperClearedReporter.ts";
import { SettingsCustomWallpaperUploadedReporter } from "../../../analytics/reporters/settings-custom-wallpaper-uploaded/settingsCustomWallpaperUploadedReporter.ts";
import { createWorkspaceBrowserService } from "./workspaceBrowserService.ts";
import { createRichTextTriggerRegistry } from "@tutti-os/ui-rich-text/plugins";
import type { RichTextTriggerProvider } from "@tutti-os/ui-rich-text/types";
import { tuttiExternalAtProviderIds } from "@tutti-os/workspace-external-core/core";
import type {
  TuttiExternalAtQueryInput,
  TuttiExternalAtQueryResult,
  TuttiExternalAtResolveInput,
  TuttiExternalAtResolveResult
} from "@tutti-os/workspace-external-core/contracts";
import type { WorkspaceFileReferenceAdapter } from "@tutti-os/workspace-file-reference/contracts";
import type { WorkspaceUserProjectApi } from "@tutti-os/workspace-user-project/contracts";
import { serializeWorkspaceAppExternalAtMatch } from "./workspaceAppExternalAtSerialization.ts";
import { requestWorkspaceWorkbenchNodeLaunch } from "../workspaceWorkbenchNodeLaunchCoordinator.ts";
import {
  IAgentsService,
  type IAgentsService as AgentsService
} from "../../../workspace-agent/services/agentsService.interface.ts";
import {
  createWorkbenchHostSessionConfiguration,
  WorkbenchHostCoordinator,
  WorkbenchHostSession,
  type WorkbenchHostSessionConfiguration,
  type WorkbenchSnapshotPartition
} from "@tutti-os/workbench-host";
import { IWorkbenchHostCoordinator } from "../workbenchHostCoordinator.interface.ts";
import { createWorkspaceWorkbenchHostSessionBinding } from "./workspaceWorkbenchHostSessionBinding.ts";
import { createDesktopWorkbenchDiagnosticsPort } from "./adapters/desktopWorkbenchDiagnosticsPort.ts";
import { createWorkspaceAppExternalUserProjectApi } from "./workspaceAppExternalUserProjectApi.ts";
import {
  WorkspaceWorkbenchHostInputResolver,
  type CachedWorkspaceWorkbenchHostInput,
  type WorkspaceWorkbenchHostInputResolverDependencies
} from "./workspaceWorkbenchHostInputResolver.ts";
import { createWorkspaceDockRetentionController } from "./workspaceDockRetentionController.ts";

export interface WorkspaceWorkbenchHostServiceDependencies extends WorkspaceWorkbenchHostInputResolverDependencies {
  hostNotificationsApi: Pick<DesktopHostNotificationsApi, "onNavigate">;
  hostWorkspaceApi: Pick<
    DesktopHostWorkspaceApi,
    "broadcastAgentStatus" | "onOpenFeatureRequest" | "onOpenFileRequest"
  >;
  wallpaperApi: DesktopWallpaperApi;
}

export interface WorkspaceWorkbenchHostExternalDependencies {
  agentQuickPromptService?: AgentQuickPromptService;
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
  snapshotRepository: DesktopWorkspaceWorkbenchRepository;
  wallpaperApi: DesktopWallpaperApi;
}

export class WorkspaceWorkbenchHostService implements IWorkspaceWorkbenchHostService {
  readonly _serviceBrand = undefined;
  readonly dockRetention;
  private readonly dependencies: WorkspaceWorkbenchHostServiceDependencies;
  private hostSessionBindingSequence = 0;
  private readonly hostSessionConfiguration: WorkbenchHostSessionConfiguration<
    WorkspaceWorkbenchHostSessionUpdate,
    WorkspaceWorkbenchHostInput,
    CachedWorkspaceWorkbenchHostInput
  >;
  private readonly hostInputResolver: WorkspaceWorkbenchHostInputResolver;
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

  constructor(
    externalDependencies: WorkspaceWorkbenchHostExternalDependencies,
    private readonly workbenchHostCoordinator: WorkbenchHostCoordinator,
    richTextAtService: IDesktopRichTextAtService,
    agentsService: AgentsService,
    agentProviderStatusService: AgentProviderStatusService,
    workspaceAgentActivityService: WorkspaceAgentActivityService,
    workspaceAgentPromptSessionService: WorkspaceAgentPromptSessionService,
    appCenterService: IWorkspaceAppCenterService,
    workspaceFileManagerService: IWorkspaceFileManagerService,
    workspaceFilePreviewSurfaceHost: IWorkspaceFilePreviewSurfaceHost,
    workspaceUserProjectService: IWorkspaceUserProjectService
  ) {
    const repository = externalDependencies.snapshotRepository;
    this.dockRetention = createWorkspaceDockRetentionController(repository);
    this.dependencies = {
      agentQuickPromptService: externalDependencies.agentQuickPromptService,
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
      workspaceFilePreviewSurfaceHost,
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
    this.hostInputResolver = new WorkspaceWorkbenchHostInputResolver(
      this.dependencies
    );
    this.hostSessionConfiguration = createWorkbenchHostSessionConfiguration({
      createSession: (partition) =>
        new WorkbenchHostSession<
          WorkspaceWorkbenchHostSessionUpdate,
          WorkspaceWorkbenchHostInput,
          CachedWorkspaceWorkbenchHostInput
        >({
          diagnostics: createDesktopWorkbenchDiagnosticsPort({
            runtimeApi: this.dependencies.runtimeApi,
            workspaceId: partition.scope.id
          }),
          partition,
          resolve: (update, current) =>
            this.hostInputResolver.resolve(update, current)
        })
    });
    this.dependencies.repository.subscribe(() => {
      this.notifyWallpaperListeners();
    });
    this.subscribeWorkbenchNodeLaunchRequests();
    void this.loadCustomWallpaper();
  }

  approveWindowClose(): Promise<void> {
    return this.dependencies.hostWindowApi.approveClose();
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
    const providers = this.createWorkspaceAppExternalAtProviders(
      providerIds,
      input.workspaceId
    );
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

  async resolveWorkspaceAppExternalAt(input: {
    mention: TuttiExternalAtResolveInput;
    workspaceId: string;
  }): Promise<TuttiExternalAtResolveResult | null> {
    const providers = this.createWorkspaceAppExternalAtProviders(
      new Set([input.mention.providerId]),
      input.workspaceId
    );
    const provider = providers.find(
      (candidate) => candidate.id === input.mention.providerId
    );
    if (!provider?.resolveMention) return null;
    return provider.resolveMention({
      providerId: input.mention.providerId,
      entityId: input.mention.entityId,
      label: "",
      scope: {
        ...input.mention.scope,
        workspaceId: input.workspaceId
      }
    });
  }

  private createWorkspaceAppExternalAtProviders(
    providerIds: ReadonlySet<(typeof tuttiExternalAtProviderIds)[number]>,
    workspaceId: string
  ): RichTextTriggerProvider[] {
    const richTextCapabilities = [...providerIds].filter(
      (providerId) => providerId !== "agent-generated-file"
    );
    const providers: RichTextTriggerProvider[] = [
      ...this.dependencies.richTextAtService.getProviders({
        capabilities: richTextCapabilities,
        surface: "workspace-app-external",
        target: "workspace-app",
        workspaceId
      })
    ];
    if (providerIds.has("agent-generated-file")) {
      const agentGeneratedFileProvider =
        createDesktopAgentGeneratedFileMentionProvider({
          agentActivityRuntime: this.dependencies.workspaceAgentActivityService,
          workspaceId
        });
      providers.push({ ...agentGeneratedFileProvider, trigger: "@" });
    }
    return providers;
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
    await this.dependencies.repository.saveProductMetadata(
      workspaceId,
      writeWorkspaceOnboardingAutoOpenedToSnapshot(snapshot),
      "onboarding"
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

  dispose(): void {
    this.dockRetention.dispose();
    this.wallpaperListeners.clear();
    this.clearCustomWallpaperUrls();
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

    const savedSnapshot =
      await this.dependencies.repository.saveProductMetadata(
        workspaceId,
        snapshot,
        "wallpaper"
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

  openHostSession(workspaceId: string): WorkspaceWorkbenchHostSessionBinding {
    const lease = this.workbenchHostCoordinator.open({
      configuration: this.hostSessionConfiguration,
      partition: createWorkspaceWorkbenchPartition(workspaceId)
    });
    this.hostSessionBindingSequence += 1;
    return createWorkspaceWorkbenchHostSessionBinding({
      bindingId: this.hostSessionBindingSequence,
      lease,
      workspaceId
    });
  }
}

function formatDiagnosticError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Avoid decorator syntax so the renderer Babel pass can parse this file.
IWorkbenchHostCoordinator(WorkspaceWorkbenchHostService, undefined, 1);
IDesktopRichTextAtService(WorkspaceWorkbenchHostService, undefined, 2);
IAgentsService(WorkspaceWorkbenchHostService, undefined, 3);
IAgentProviderStatusService(WorkspaceWorkbenchHostService, undefined, 4);
IWorkspaceAgentActivityService(WorkspaceWorkbenchHostService, undefined, 5);
IWorkspaceAgentPromptSessionService(
  WorkspaceWorkbenchHostService,
  undefined,
  6
);
IWorkspaceAppCenterService(WorkspaceWorkbenchHostService, undefined, 7);
IWorkspaceFileManagerService(WorkspaceWorkbenchHostService, undefined, 8);
IWorkspaceFilePreviewSurfaceHost(WorkspaceWorkbenchHostService, undefined, 9);
IWorkspaceUserProjectService(WorkspaceWorkbenchHostService, undefined, 10);

function createWorkspaceWorkbenchPartition(
  workspaceId: string
): WorkbenchSnapshotPartition {
  return {
    scope: {
      id: workspaceId,
      kind: "workspace"
    }
  };
}

function noop(): void {}

function createObjectUrlFromBytes(bytes: Uint8Array, mimeType: string): string {
  const copy = new Uint8Array(bytes);
  return URL.createObjectURL(new Blob([copy], { type: mimeType }));
}
