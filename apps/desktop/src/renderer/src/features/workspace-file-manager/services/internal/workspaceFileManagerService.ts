import {
  createWorkspaceFileManagerService,
  resolveWorkspaceFileExtension,
  type WorkspaceFileEntry,
  type WorkspaceFileLocationSection,
  type WorkspaceFileManagerFileDefaultOpener,
  type WorkspaceFileManagerI18nRuntime,
  type WorkspaceFileManagerMutationErrorMessage,
  type WorkspaceFileManagerPersistedState
} from "@tutti-os/workspace-file-manager/services";
import { getActiveLocale } from "../../../../i18n/runtime.ts";
import { createDesktopWorkspaceFileManagerAdapter } from "./desktopWorkspaceFileManagerAdapter.ts";
import type {
  IWorkspaceFileManagerService,
  WorkspaceFileManagerCanvasPreviewLauncher,
  WorkspaceFileManagerSession
} from "../workspaceFileManagerService.interface";
import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import {
  INotificationService,
  type NotificationService
} from "@tutti-os/ui-notifications";
import type { DesktopHostFilesApi, DesktopPlatformApi } from "@preload/types";
import { getAppI18nRuntime, translate } from "../../../../i18n/appRuntime.ts";
import { FileManagerFileCreatedReporter } from "../../../analytics/reporters/file-manager-file-created/fileManagerFileCreatedReporter.ts";
import { FileManagerOpenedReporter } from "../../../analytics/reporters/file-manager-opened/fileManagerOpenedReporter.ts";
import { createAnalyticsOpenedSourceParams } from "../../../analytics/reporters/openedSource.ts";
import type { IReporterService } from "../../../analytics/services/reporterService.interface.ts";
import type { IDesktopPreferencesService } from "../../../desktop-preferences/services/desktopPreferencesService.interface.ts";
import type { IWorkspaceUserProjectService } from "../../../workspace-user-project/index.ts";
import {
  getCurrentDesktopWorkspaceFileLocationSections,
  loadDesktopWorkspaceFileLocationSections,
  resolveDesktopWorkspaceFileDefaultLocationId
} from "../desktopWorkspaceFileLocations.ts";

export interface WorkspaceFileManagerServiceDependencies {
  hostFilesApi: DesktopHostFilesApi;
  tuttidClient: TuttidClient;
  platformApi: Pick<
    DesktopPlatformApi,
    "homeDirectory" | "os" | "resolveDroppedPaths"
  >;
  desktopPreferencesService?: Pick<IDesktopPreferencesService, "store">;
  reporterService?: Pick<IReporterService, "trackEvents">;
  workspaceUserProjectService?: IWorkspaceUserProjectService;
}

export class WorkspaceFileManagerService implements IWorkspaceFileManagerService {
  readonly _serviceBrand = undefined;
  private readonly canvasFilePreviewLaunchers = new Map<
    string,
    WorkspaceFileManagerCanvasPreviewLauncher
  >();
  private readonly dependencies: WorkspaceFileManagerServiceDependencies;
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly locationRefreshSnapshotByWorkspace = new Map<
    string,
    string
  >();
  private readonly notifications: NotificationService;
  private readonly sharedService = createWorkspaceFileManagerService();
  private readonly sessions = new Map<string, WorkspaceFileManagerSession>();

  constructor(
    dependencies: WorkspaceFileManagerServiceDependencies,
    notifications: NotificationService = noopNotifications
  ) {
    this.dependencies = dependencies;
    this.notifications = notifications;
    dependencies.workspaceUserProjectService?.subscribe(() => {
      void this.refreshAllSessionLocations();
    });
  }

  get hostOs(): NodeJS.Platform {
    return this.dependencies.platformApi.os;
  }

  async entryExists(input: {
    path: string;
    workspaceID: string;
  }): Promise<boolean> {
    const targetPath = normalizeComparableWorkspaceFilePath(input.path);
    if (!targetPath) {
      return false;
    }

    try {
      const listing =
        await this.dependencies.tuttidClient.listWorkspaceFileDirectory(
          input.workspaceID,
          {
            includeHidden: true,
            path: dirnameForWorkspaceFilePath(targetPath)
          }
        );
      if (
        normalizeComparableWorkspaceFilePath(listing.directoryPath) ===
          targetPath ||
        normalizeComparableWorkspaceFilePath(listing.root) === targetPath
      ) {
        return true;
      }
      return listing.entries.some(
        (entry) =>
          normalizeComparableWorkspaceFilePath(entry.path) === targetPath
      );
    } catch {
      return false;
    }
  }

  getSession(
    workspaceID: string,
    i18n: WorkspaceFileManagerI18nRuntime,
    restoredState?: WorkspaceFileManagerPersistedState | null
  ): WorkspaceFileManagerSession {
    const existing = this.sessions.get(workspaceID);
    if (existing) {
      existing.setI18nRuntime(i18n);
      return existing;
    }
    const locationSections = getCurrentDesktopWorkspaceFileLocationSections({
      homeDirectory: this.dependencies.platformApi.homeDirectory,
      workspaceUserProjectService: this.dependencies.workspaceUserProjectService
    });
    const defaultLocationId = resolveDesktopWorkspaceFileDefaultLocationId({
      projects:
        this.dependencies.workspaceUserProjectService?.getSnapshot().projects ??
        []
    });
    this.locationRefreshSnapshotByWorkspace.set(
      workspaceID,
      serializeWorkspaceFileLocationRefreshSnapshot({
        defaultLocationId,
        locationSections
      })
    );

    const session = this.sharedService.createSession({
      i18n,
      host: createDesktopWorkspaceFileManagerAdapter(
        {
          ...this.dependencies,
          notifyPreviewUnsupportedFallback: () => {
            this.notifications.info({
              title: translate(
                "workspace.workbenchDesktop.filePreview.unsupportedFallback"
              )
            });
          },
          notifyRevealFailed: (message) => {
            this.notifications.error({
              description: message,
              title: getAppI18nRuntime(getActiveLocale()).t(
                "workspaceFileManager.revealFailedTitle"
              )
            });
          },
          reportFileCreated: () => this.reportFileCreated(),
          reportFileOpened: () => this.reportFileOpened()
        },
        getActiveLocale,
        {
          openCanvasPreview: (target, workspaceID) =>
            this.openCanvasPreview(workspaceID, target)
        }
      ),
      defaultLocationId,
      initialDirectoryPath: this.dependencies.platformApi.homeDirectory,
      locationSections,
      onMutationErrorMessage: (message) =>
        this.notifyHandledMutationError(message),
      persistence: {
        load: () => restoredState ?? null,
        save: () => this.notify(workspaceID)
      },
      resolveFileDefaultOpener: (entry) =>
        resolveDesktopFileDefaultOpener(
          entry,
          this.dependencies.desktopPreferencesService
        ),
      workspaceID
    });
    this.sessions.set(workspaceID, session);
    void this.refreshSessionLocations(workspaceID, session);
    return session;
  }

  getSnapshotState(
    workspaceID: string
  ): WorkspaceFileManagerPersistedState | null {
    return this.sessions.get(workspaceID)?.getPersistedState() ?? null;
  }

  async resolveEntryIconUrl(
    workspaceID: string,
    entry: WorkspaceFileEntry
  ): Promise<string | null> {
    return this.dependencies.hostFilesApi.resolveEntryIcon(workspaceID, {
      kind: entry.kind,
      mtimeMs: entry.mtimeMs,
      name: entry.name,
      path: entry.path
    });
  }

  setCanvasFilePreviewLauncher(
    workspaceID: string,
    launcher: WorkspaceFileManagerCanvasPreviewLauncher | null
  ): void {
    if (!launcher) {
      this.canvasFilePreviewLaunchers.delete(workspaceID);
      return;
    }
    this.canvasFilePreviewLaunchers.set(workspaceID, launcher);
  }

  subscribe(workspaceID: string, listener: () => void): () => void {
    const listeners = this.listeners.get(workspaceID) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(workspaceID, listeners);

    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.listeners.delete(workspaceID);
      }
    };
  }

  private notify(workspaceID: string): void {
    for (const listener of this.listeners.get(workspaceID) ?? []) {
      listener();
    }
  }

  private async refreshAllSessionLocations(): Promise<void> {
    await Promise.all(
      [...this.sessions].map(([workspaceID, session]) =>
        this.refreshSessionLocations(workspaceID, session)
      )
    );
  }

  private async refreshSessionLocations(
    workspaceID: string,
    session: WorkspaceFileManagerSession
  ): Promise<void> {
    const workspaceUserProjectService =
      this.dependencies.workspaceUserProjectService;
    const locationSections = await loadDesktopWorkspaceFileLocationSections({
      homeDirectory: this.dependencies.platformApi.homeDirectory,
      workspaceUserProjectService
    });
    const defaultLocationId = resolveDesktopWorkspaceFileDefaultLocationId({
      projects: workspaceUserProjectService?.getSnapshot().projects ?? []
    });
    const snapshotKey = serializeWorkspaceFileLocationRefreshSnapshot({
      defaultLocationId,
      locationSections
    });
    if (
      this.locationRefreshSnapshotByWorkspace.get(workspaceID) === snapshotKey
    ) {
      return;
    }
    this.locationRefreshSnapshotByWorkspace.set(workspaceID, snapshotKey);
    await session.setLocations({
      defaultLocationId,
      sections: locationSections
    });
    this.notify(workspaceID);
  }

  private async openCanvasPreview(
    workspaceID: string,
    target: Parameters<WorkspaceFileManagerCanvasPreviewLauncher>[0]
  ): Promise<boolean> {
    return (
      (await this.canvasFilePreviewLaunchers.get(workspaceID)?.(target)) ===
      true
    );
  }

  private notifyHandledMutationError(
    message: WorkspaceFileManagerMutationErrorMessage
  ): boolean {
    this.notifications.error({
      title: message.message
    });
    return true;
  }

  private reportFileOpened(): void {
    const reporterService = this.dependencies.reporterService;
    if (!reporterService) {
      return;
    }

    void new FileManagerOpenedReporter(
      createAnalyticsOpenedSourceParams("file_manager"),
      {
        reporterService
      }
    ).report();
  }

  private reportFileCreated(): void {
    this.reportFileManagerEvent(FileManagerFileCreatedReporter);
  }

  private reportFileManagerEvent(
    Reporter: typeof FileManagerFileCreatedReporter
  ): void {
    const reporterService = this.dependencies.reporterService;
    if (!reporterService) {
      return;
    }

    void new Reporter(
      {},
      {
        reporterService
      }
    ).report();
  }
}

function resolveDesktopFileDefaultOpener(
  entry: WorkspaceFileEntry,
  desktopPreferencesService?: Pick<IDesktopPreferencesService, "store">
): WorkspaceFileManagerFileDefaultOpener | null {
  const extension = resolveWorkspaceFileExtension(entry.path || entry.name);
  if (!extension) {
    return null;
  }

  return (
    desktopPreferencesService?.store.fileDefaultOpenersByExtension[extension] ??
    null
  );
}

function dirnameForWorkspaceFilePath(path: string): string {
  const index = path.lastIndexOf("/");
  if (index <= 0) {
    return path.startsWith("/") ? "/" : path;
  }
  return path.slice(0, index);
}

function normalizeComparableWorkspaceFilePath(path: string): string {
  const normalized = path.trim().replaceAll("\\", "/").replace(/\/+/g, "/");
  if (!normalized) {
    return "";
  }
  if (normalized === "/") {
    return "/";
  }
  return normalized.replace(/\/+$/g, "");
}

function serializeWorkspaceFileLocationRefreshSnapshot(input: {
  defaultLocationId: string;
  locationSections: readonly WorkspaceFileLocationSection[];
}): string {
  return JSON.stringify({
    defaultLocationId: input.defaultLocationId,
    sections: input.locationSections.map((section) => ({
      id: section.id,
      label: section.label,
      locations: section.locations.map((location) =>
        location.kind === "directory"
          ? {
              contextLabel: location.contextLabel,
              id: location.id,
              kind: location.kind,
              label: location.label,
              path: location.path,
              referenceNodeId: location.referenceNodeId
            }
          : {
              id: location.id,
              kind: location.kind,
              label: location.label
            }
      )
    }))
  });
}

// Avoid decorator syntax so the renderer Babel pass can parse this file.
INotificationService(WorkspaceFileManagerService, undefined, 1);

const noopNotifications: NotificationService = {
  _serviceBrand: undefined,
  error() {},
  info() {},
  notify() {},
  success() {},
  warning() {}
};
