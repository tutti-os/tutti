import type {
  DesktopApi,
  DesktopComputerUseApi,
  DesktopDeveloperApi,
  DesktopDockPreviewCacheApi,
  DesktopHostApi,
  DesktopPlatformApi,
  DesktopRuntimeApi,
  DesktopUpdateApi,
  DesktopWallpaperApi
} from "@preload/types";
import type {
  AppUpdateState,
  ClearDeveloperLogsResult,
  DesktopBackendConfig,
  DesktopDeveloperLogsState,
  ExportDeveloperLogsResult
} from "@shared/contracts/ipc";
import { desktopErrorCodes } from "@shared/errors/desktopErrors";

const webAppUpdateState: AppUpdateState = {
  channel: "rc",
  checkedAt: null,
  currentVersion: "dev-web",
  downloadedBytes: null,
  downloadPercent: null,
  latestVersion: null,
  message: null,
  policy: "off",
  releaseDate: null,
  releaseName: null,
  releaseNotesUrl: null,
  status: "idle",
  totalBytes: null
};

export function createWebDesktopApi(): DesktopApi {
  const backendConfig = resolveWebBackendConfig();

  return {
    computerUse: createWebComputerUseApi(),
    developer: createWebDeveloperApi(),
    dockPreviewCache: createWebDockPreviewCacheApi(),
    host: createWebHostApi(),
    platform: createWebPlatformApi(),
    runtime: createWebRuntimeApi(backendConfig),
    update: createWebUpdateApi(),
    wallpaper: createWebWallpaperApi()
  };
}

function createWebComputerUseApi(): DesktopComputerUseApi {
  return {
    checkStatus() {
      return Promise.resolve({
        installed: false,
        permissions: null,
        authorization: "unknown",
        reason: "not-installed"
      });
    },
    install() {
      return Promise.reject(electronDebugRequired("computerUse.install"));
    },
    uninstall() {
      return Promise.reject(electronDebugRequired("computerUse.uninstall"));
    },
    grantPermissions() {
      return Promise.reject(
        electronDebugRequired("computerUse.grantPermissions")
      );
    },
    startPermissionGrant() {
      return Promise.reject(
        electronDebugRequired("computerUse.startPermissionGrant")
      );
    },
    getPermissionGrantStatus() {
      return Promise.reject(
        electronDebugRequired("computerUse.getPermissionGrantStatus")
      );
    },
    openPermissionSettings() {
      return Promise.reject(
        electronDebugRequired("computerUse.openPermissionSettings")
      );
    },
    restartDriver() {
      return Promise.reject(electronDebugRequired("computerUse.restartDriver"));
    }
  };
}

function createWebDockPreviewCacheApi(): DesktopDockPreviewCacheApi {
  return {
    read() {
      return Promise.resolve(null);
    },
    write() {
      return Promise.resolve();
    }
  };
}

function createWebWallpaperApi(): DesktopWallpaperApi {
  return {
    clearCustom() {
      return Promise.reject(electronDebugRequired("clearCustom"));
    },
    getCustom() {
      return Promise.resolve(null);
    },
    setCustom() {
      return Promise.reject(electronDebugRequired("setCustom"));
    }
  };
}

function createWebRuntimeApi(
  backendConfig: DesktopBackendConfig
): DesktopRuntimeApi {
  return {
    getBackendConfig() {
      return Promise.resolve(backendConfig);
    },
    getBusinessEventStreamUrl() {
      return Promise.resolve(
        resolveWebSocketUrl(backendConfig, "/v1/events/ws").toString()
      );
    },
    listWorkspaceAgentProbes(input) {
      return Promise.resolve({
        capturedAtUnixMs: Date.now(),
        providers: [],
        workspaceId: input.workspaceId
      });
    },
    getTerminalStreamUrl(input) {
      const url = resolveWebSocketUrl(
        backendConfig,
        `/v1/workspaces/${encodeURIComponent(input.workspaceId)}/terminals/${encodeURIComponent(input.sessionId)}/ws`
      );
      if (input.afterSeq !== undefined) {
        url.searchParams.set("afterSeq", String(input.afterSeq));
      }
      return Promise.resolve(url.toString());
    },
    logRendererDiagnostic(input) {
      const method =
        input.level === "error"
          ? console.error
          : input.level === "warn"
            ? console.warn
            : input.level === "debug"
              ? console.debug
              : console.info;
      method("[tutti dev-web] renderer diagnostic", {
        details: input.details ?? {},
        event: input.event,
        source: input.source,
        workspaceId: input.workspaceId ?? null
      });
      return Promise.resolve();
    },
    logTerminalDiagnostic(input) {
      const method =
        input.level === "error"
          ? console.error
          : input.level === "warn"
            ? console.warn
            : input.level === "debug"
              ? console.debug
              : console.info;
      method(`[tutti dev-web] terminal diagnostic ${input.event}`, {
        details: input.details ?? {},
        event: input.event,
        nodeId: input.nodeId ?? null,
        sessionId: input.sessionId ?? null,
        workspaceId: input.workspaceId ?? null
      });
      return Promise.resolve();
    }
  };
}

function createWebDeveloperApi(): DesktopDeveloperApi {
  return {
    clearLogs(): Promise<ClearDeveloperLogsResult> {
      return Promise.reject(electronDebugRequired("clearLogs"));
    },
    exportLogs(): Promise<ExportDeveloperLogsResult> {
      return Promise.reject(electronDebugRequired("exportLogs"));
    },
    getLogsState(): Promise<DesktopDeveloperLogsState> {
      return Promise.resolve({
        desktopVersion: "dev-web",
        files: [],
        logsDir: "",
        totalFiles: 0,
        totalSizeBytes: 0
      });
    },
    openLogDirectory() {
      return Promise.reject(electronDebugRequired("openLogDirectory"));
    },
    openLogFile() {
      return Promise.reject(electronDebugRequired("openLogFile"));
    }
  };
}

function createWebPlatformApi(): DesktopPlatformApi {
  return {
    homeDirectory: "",
    os: inferPlatform(),
    resolveDroppedEntries() {
      return [];
    },
    resolveDroppedPaths() {
      return [];
    }
  };
}

function createWebHostApi(): DesktopHostApi {
  return {
    files: {
      createUserDocumentsProjectDirectory() {
        return Promise.reject(
          electronDebugRequired("createUserDocumentsProjectDirectory")
        );
      },
      selectAppArchive() {
        return Promise.reject(electronDebugRequired("selectAppArchive"));
      },
      selectAppArchiveExportPath() {
        return Promise.reject(
          electronDebugRequired("selectAppArchiveExportPath")
        );
      },
      selectAppIconImage() {
        return Promise.reject(electronDebugRequired("selectAppIconImage"));
      },
      selectDirectory() {
        return Promise.reject(electronDebugRequired("selectDirectory"));
      },
      openFile() {
        return Promise.reject(electronDebugRequired("openFile"));
      },
      listOpenWithApplications() {
        return Promise.reject(
          electronDebugRequired("listOpenWithApplications")
        );
      },
      openFileWithApplication() {
        return Promise.reject(electronDebugRequired("openFileWithApplication"));
      },
      openFileWithOtherApplication() {
        return Promise.reject(
          electronDebugRequired("openFileWithOtherApplication")
        );
      },
      openFileInBrowser() {
        return Promise.reject(electronDebugRequired("openFileInBrowser"));
      },
      resolveWorkspaceFileFileUrl() {
        return Promise.reject(
          electronDebugRequired("resolveWorkspaceFileFileUrl")
        );
      },
      revealInFolder() {
        return Promise.reject(electronDebugRequired("revealInFolder"));
      },
      revealWorkspaceFile() {
        return Promise.reject(electronDebugRequired("revealWorkspaceFile"));
      },
      openExternal(url) {
        window.open(url, "_blank", "noopener,noreferrer");
        return Promise.resolve();
      },
      openTerminalLink() {
        return Promise.reject(electronDebugRequired("openTerminalLink"));
      },
      readLocalFileText() {
        return Promise.reject(electronDebugRequired("readLocalFileText"));
      },
      readLocalPreviewFile() {
        return Promise.reject(electronDebugRequired("readLocalPreviewFile"));
      },
      archiveAgentPromptFile() {
        return Promise.reject(electronDebugRequired("archiveAgentPromptFile"));
      },
      readPreviewFile() {
        return Promise.reject(electronDebugRequired("readPreviewFile"));
      },
      resolveEntryIcon() {
        return Promise.resolve(null);
      },
      selectUploadFiles() {
        return Promise.reject(electronDebugRequired("selectUploadFiles"));
      },
      copyImageToClipboard() {
        return Promise.reject(electronDebugRequired("copyImageToClipboard"));
      },
      copyFilesToClipboard() {
        return Promise.reject(electronDebugRequired("copyFilesToClipboard"));
      }
    },
    window: {
      approveClose() {
        window.close();
        return Promise.resolve();
      },
      capturePreview() {
        return Promise.resolve(null);
      },
      onCloseRequest() {
        return () => {};
      },
      onQuitShortcutToast() {
        return () => {};
      },
      resolveCloseRequest() {
        return undefined;
      }
    },
    notifications: {
      show() {
        return Promise.resolve({
          reason: "unsupported",
          shown: false
        });
      },
      onNavigate() {
        return () => {};
      }
    },
    workspace: {
      broadcastAgentStatus() {},
      onOpenFeatureRequest() {
        return () => {};
      },
      onOpenFileRequest() {
        return () => {};
      },
      openWorkspaceAppFolder() {
        return Promise.reject(electronDebugRequired("openWorkspaceAppFolder"));
      },
      showWorkspace(workspaceID) {
        const url = new URL(window.location.href);
        url.searchParams.set("view", "workspace");
        url.searchParams.set("workspaceId", workspaceID);
        window.location.assign(url.toString());
        return Promise.resolve();
      }
    }
  };
}

function createWebUpdateApi(): DesktopUpdateApi {
  return {
    checkForUpdates() {
      return Promise.resolve(webAppUpdateState);
    },
    configure() {
      return Promise.resolve(webAppUpdateState);
    },
    downloadUpdate() {
      return Promise.resolve(webAppUpdateState);
    },
    getState() {
      return Promise.resolve(webAppUpdateState);
    },
    installUpdate() {
      return Promise.resolve();
    },
    onState() {
      return () => {};
    }
  };
}

function resolveWebBackendConfig(): DesktopBackendConfig {
  const baseUrl = readRequiredEnv("VITE_TUTTID_BASE_URL");
  const accessToken = readRequiredEnv("VITE_TUTTID_ACCESS_TOKEN");
  return {
    accessToken,
    baseUrl
  };
}

function readRequiredEnv(
  name: "VITE_TUTTID_ACCESS_TOKEN" | "VITE_TUTTID_BASE_URL"
): string {
  const value = import.meta.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for desktop web development.`);
  }
  return value;
}

function resolveWebSocketUrl(
  backendConfig: DesktopBackendConfig,
  pathname: string
): URL {
  const url = new URL(pathname, backendConfig.baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("access_token", backendConfig.accessToken);
  return url;
}

function electronDebugRequired(action: string): Error & { code: string } {
  const error = new Error(
    `${action} is only available when debugging through Electron.`
  ) as Error & { code: string };
  error.code = desktopErrorCodes.electronDebugRequired;
  return error;
}

function inferPlatform(): NodeJS.Platform {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("mac os")) {
    return "darwin";
  }
  if (ua.includes("windows")) {
    return "win32";
  }
  return "linux";
}
