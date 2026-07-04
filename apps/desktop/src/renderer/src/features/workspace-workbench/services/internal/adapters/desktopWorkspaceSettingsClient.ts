import type {
  DesktopComputerUseApi,
  DesktopDeveloperApi,
  DesktopRuntimeApi
} from "@preload/types";
import type {
  ClearDeveloperLogsResult,
  DesktopComputerUseActionResult,
  DesktopComputerUsePermissionGrantStatus,
  DesktopComputerUsePermissionPane,
  DesktopComputerUseRestartDriverInput,
  DesktopComputerUseRestartDriverResult,
  DesktopComputerUseStatus,
  DesktopDeveloperLogKind,
  DesktopDeveloperLogsState,
  ExportDeveloperLogsResult
} from "@shared/contracts/ipc";
import type {
  WorkspaceManagedModelProviderConfig,
  WorkspaceManagedModelProviderID
} from "../../workspaceSettingsTypes.ts";

interface ManagedProviderListResponse {
  providers: WorkspaceManagedModelProviderConfig[];
}

interface ManagedProviderResponse {
  provider: WorkspaceManagedModelProviderConfig;
}

interface ManagedProviderModelsResponse {
  models: WorkspaceManagedModelProviderConfig["models"];
}

interface ClearWorkspaceAgentSessionsResponse {
  removedMessages: number;
  removedSessions: number;
}

export interface PutManagedModelProviderInput {
  apiKey?: string;
  baseUrl?: string;
  enabled: boolean;
  models: Array<{
    id: string;
    name: string;
    provider: WorkspaceManagedModelProviderID;
  }>;
}

export interface ListManagedModelProviderModelsInput {
  apiKey?: string;
  baseUrl?: string;
}

export interface DesktopWorkspaceSettingsClient {
  checkComputerUseStatus(): Promise<DesktopComputerUseStatus>;
  installComputerUse(): Promise<DesktopComputerUseActionResult>;
  uninstallComputerUse(): Promise<DesktopComputerUseActionResult>;
  grantComputerUsePermissions(): Promise<DesktopComputerUseActionResult>;
  startComputerUsePermissionGrant(): Promise<DesktopComputerUsePermissionGrantStatus>;
  getComputerUsePermissionGrantStatus(): Promise<DesktopComputerUsePermissionGrantStatus | null>;
  logComputerUsePermissionDiagnostic(input: {
    details?: Record<string, unknown>;
    event: string;
    level?: "debug" | "error" | "info" | "warn";
    workspaceId?: string | null;
  }): Promise<void>;
  openComputerUsePermissionSettings(
    pane: DesktopComputerUsePermissionPane
  ): Promise<void>;
  restartComputerUseDriver(
    input?: DesktopComputerUseRestartDriverInput
  ): Promise<DesktopComputerUseRestartDriverResult>;
  clearLogs(): Promise<ClearDeveloperLogsResult>;
  clearWorkspaceAgentSessions(
    workspaceID: string
  ): Promise<ClearWorkspaceAgentSessionsResponse>;
  deleteManagedModelProvider(
    workspaceID: string,
    providerID: WorkspaceManagedModelProviderID
  ): Promise<void>;
  exportLogs(): Promise<ExportDeveloperLogsResult>;
  getLogsState(): Promise<DesktopDeveloperLogsState>;
  listManagedModelProviders(
    workspaceID: string
  ): Promise<WorkspaceManagedModelProviderConfig[]>;
  listManagedModelProviderModels(
    workspaceID: string,
    providerID: WorkspaceManagedModelProviderID,
    input?: ListManagedModelProviderModelsInput
  ): Promise<WorkspaceManagedModelProviderConfig["models"]>;
  openLogDirectory(): Promise<void>;
  openLogFile(kind: DesktopDeveloperLogKind): Promise<void>;
  putManagedModelProvider(
    workspaceID: string,
    providerID: WorkspaceManagedModelProviderID,
    input: PutManagedModelProviderInput
  ): Promise<WorkspaceManagedModelProviderConfig>;
  testManagedModelProvider(
    workspaceID: string,
    providerID: WorkspaceManagedModelProviderID
  ): Promise<void>;
}

export function createDesktopWorkspaceSettingsClient(input: {
  computerUseApi: DesktopComputerUseApi;
  developerApi: DesktopDeveloperApi;
  runtimeApi: DesktopRuntimeApi;
}): DesktopWorkspaceSettingsClient {
  return {
    checkComputerUseStatus() {
      return input.computerUseApi.checkStatus();
    },
    installComputerUse() {
      return input.computerUseApi.install();
    },
    uninstallComputerUse() {
      return input.computerUseApi.uninstall();
    },
    grantComputerUsePermissions() {
      return input.computerUseApi.grantPermissions();
    },
    startComputerUsePermissionGrant() {
      return input.computerUseApi.startPermissionGrant();
    },
    getComputerUsePermissionGrantStatus() {
      return input.computerUseApi.getPermissionGrantStatus();
    },
    logComputerUsePermissionDiagnostic(payload) {
      return input.runtimeApi.logRendererDiagnostic({
        details: payload.details ?? {},
        event: payload.event,
        level: payload.level ?? "info",
        source: "workspace-workbench",
        workspaceId: payload.workspaceId ?? null
      });
    },
    openComputerUsePermissionSettings(pane) {
      return input.computerUseApi.openPermissionSettings(pane);
    },
    restartComputerUseDriver(restartInput) {
      return input.computerUseApi.restartDriver(restartInput);
    },
    clearLogs() {
      return input.developerApi.clearLogs();
    },
    exportLogs() {
      return input.developerApi.exportLogs();
    },
    getLogsState() {
      return input.developerApi.getLogsState();
    },
    openLogDirectory() {
      return input.developerApi.openLogDirectory();
    },
    openLogFile(kind) {
      return input.developerApi.openLogFile(kind);
    },
    async listManagedModelProviders(workspaceID) {
      const response = await requestDaemon<ManagedProviderListResponse>(
        input.runtimeApi,
        `/v1/workspaces/${encodeURIComponent(workspaceID)}/managed-model-providers`
      );
      return response.providers;
    },
    async listManagedModelProviderModels(workspaceID, providerID, body) {
      const response = await requestDaemon<ManagedProviderModelsResponse>(
        input.runtimeApi,
        `/v1/workspaces/${encodeURIComponent(workspaceID)}/managed-model-providers/${encodeURIComponent(providerID)}/models`,
        {
          body,
          method: "POST"
        }
      );
      return response.models;
    },
    async clearWorkspaceAgentSessions(workspaceID) {
      return await requestDaemon<ClearWorkspaceAgentSessionsResponse>(
        input.runtimeApi,
        `/v1/workspaces/${encodeURIComponent(workspaceID)}/agent-sessions`,
        {
          method: "DELETE"
        }
      );
    },
    async putManagedModelProvider(workspaceID, providerID, body) {
      const response = await requestDaemon<ManagedProviderResponse>(
        input.runtimeApi,
        `/v1/workspaces/${encodeURIComponent(workspaceID)}/managed-model-providers/${encodeURIComponent(providerID)}`,
        {
          body,
          method: "PUT"
        }
      );
      return response.provider;
    },
    async deleteManagedModelProvider(workspaceID, providerID) {
      await requestDaemon(
        input.runtimeApi,
        `/v1/workspaces/${encodeURIComponent(workspaceID)}/managed-model-providers/${encodeURIComponent(providerID)}`,
        {
          method: "DELETE"
        }
      );
    },
    async testManagedModelProvider(workspaceID, providerID) {
      await requestDaemon(
        input.runtimeApi,
        `/v1/workspaces/${encodeURIComponent(workspaceID)}/managed-model-providers/${encodeURIComponent(providerID)}/test`,
        {
          method: "POST"
        }
      );
    }
  };
}

async function requestDaemon<TResult = unknown>(
  runtimeApi: DesktopRuntimeApi,
  pathname: string,
  init: { body?: unknown; method?: string } = {}
): Promise<TResult> {
  const config = await runtimeApi.getBackendConfig();
  const response = await fetch(new URL(pathname, config.baseUrl), {
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    headers: {
      Authorization: `Bearer ${config.accessToken}`,
      "Content-Type": "application/json"
    },
    method: init.method ?? "GET"
  });
  if (!response.ok) {
    throw new Error(`Daemon request failed (${response.status}).`);
  }
  return (await response.json()) as TResult;
}
