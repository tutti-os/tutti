import type { DesktopDeveloperApi } from "@preload/types";
import type { DesktopRuntimeApi } from "@preload/types";
import type {
  ClearDeveloperLogsResult,
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
  clearLogs(): Promise<ClearDeveloperLogsResult>;
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
  developerApi: DesktopDeveloperApi;
  runtimeApi: DesktopRuntimeApi;
}): DesktopWorkspaceSettingsClient {
  return {
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
