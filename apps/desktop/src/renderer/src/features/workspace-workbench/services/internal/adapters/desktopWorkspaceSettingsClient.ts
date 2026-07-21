import type {
  DesktopComputerUseApi,
  DesktopDeveloperApi,
  DesktopRuntimeApi
} from "@preload/types";
import type {
  AgentProviderComposerOptionsResponse,
  AgentTarget,
  AutomationRule,
  DeletedAgentConversationPurgeResult,
  GenerateWorkspaceAgentDraftRequest,
  PutAutomationRuleRequest,
  PutWorkspaceAgentRequest,
  TuttidClient,
  WorkspaceAgentDraftGeneration,
  WorkspaceAgentProvider,
  WorkspaceModelRecommendation
} from "@tutti-os/client-tuttid-ts";
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
  DesktopDeveloperLogsExportScope,
  ExportDeveloperLogsResult
} from "@shared/contracts/ipc";
import type {
  WorkspaceAgentDefinition,
  WorkspaceManagedModelProviderConfig,
  WorkspaceManagedModelProviderID,
  WorkspaceModelPlan
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

interface ModelPlanListResponse {
  plans: WorkspaceModelPlan[];
}

interface ModelRecommendationListResponse {
  recommendations: WorkspaceModelRecommendation[];
}

export type PutWorkspaceAgentInput = PutWorkspaceAgentRequest;
export type PutAutomationRuleInput = PutAutomationRuleRequest;

export interface RecommendWorkspaceModelsInput {
  limit?: number;
  preferredPlanId?: string;
  requiredCapabilities?: string[];
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
  listAgentTargets(): Promise<AgentTarget[]>;
  getAgentProviderComposerOptions(
    workspaceID: string,
    provider: WorkspaceAgentProvider,
    agentTargetID: string
  ): Promise<AgentProviderComposerOptionsResponse>;
  listWorkspaceAgents(workspaceID: string): Promise<WorkspaceAgentDefinition[]>;
  generateWorkspaceAgentDraft(
    workspaceID: string,
    input: GenerateWorkspaceAgentDraftRequest
  ): Promise<WorkspaceAgentDraftGeneration>;
  createWorkspaceAgent(
    workspaceID: string,
    input: PutWorkspaceAgentInput
  ): Promise<WorkspaceAgentDefinition>;
  updateWorkspaceAgent(
    workspaceID: string,
    workspaceAgentID: string,
    input: PutWorkspaceAgentInput
  ): Promise<WorkspaceAgentDefinition>;
  deleteWorkspaceAgent(
    workspaceID: string,
    workspaceAgentID: string
  ): Promise<void>;
  createAutomationRule(
    workspaceID: string,
    input: PutAutomationRuleInput
  ): Promise<AutomationRule>;
  listModelPlans(workspaceID: string): Promise<WorkspaceModelPlan[]>;
  recommendWorkspaceModels(
    workspaceID: string,
    input: RecommendWorkspaceModelsInput
  ): Promise<WorkspaceModelRecommendation[]>;
  setSystemAgentTargetEnabled(
    agentTargetID: string,
    enabled: boolean
  ): Promise<AgentTarget>;
  clearLogs(): Promise<ClearDeveloperLogsResult>;
  clearWorkspaceAgentSessions(
    workspaceID: string
  ): Promise<ClearWorkspaceAgentSessionsResponse>;
  purgeDeletedAgentConversations(): Promise<DeletedAgentConversationPurgeResult>;
  deleteManagedModelProvider(
    workspaceID: string,
    providerID: WorkspaceManagedModelProviderID
  ): Promise<void>;
  exportLogs(
    scope: DesktopDeveloperLogsExportScope
  ): Promise<ExportDeveloperLogsResult>;
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
  tuttidClient: Pick<
    TuttidClient,
    | "createWorkspaceAgent"
    | "deleteWorkspaceAgent"
    | "generateWorkspaceAgentDraft"
    | "getAgentProviderComposerOptions"
    | "listAgentTargets"
    | "listWorkspaceAgents"
    | "purgeDeletedAgentConversations"
    | "setSystemAgentTargetEnabled"
    | "updateWorkspaceAgent"
  >;
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
    async listAgentTargets() {
      return (await input.tuttidClient.listAgentTargets()).targets;
    },
    async getAgentProviderComposerOptions(
      workspaceID,
      provider,
      agentTargetID
    ) {
      return await input.tuttidClient.getAgentProviderComposerOptions(
        provider,
        {
          agentTargetId: agentTargetID,
          workspaceId: workspaceID
        }
      );
    },
    async listWorkspaceAgents(workspaceID) {
      return (await input.tuttidClient.listWorkspaceAgents(workspaceID)).agents;
    },
    async generateWorkspaceAgentDraft(workspaceID, body) {
      return await input.tuttidClient.generateWorkspaceAgentDraft(
        workspaceID,
        body
      );
    },
    async createWorkspaceAgent(workspaceID, body) {
      return await input.tuttidClient.createWorkspaceAgent(workspaceID, body);
    },
    async updateWorkspaceAgent(workspaceID, workspaceAgentID, body) {
      return await input.tuttidClient.updateWorkspaceAgent(
        workspaceID,
        workspaceAgentID,
        body
      );
    },
    async deleteWorkspaceAgent(workspaceID, workspaceAgentID) {
      await input.tuttidClient.deleteWorkspaceAgent(
        workspaceID,
        workspaceAgentID
      );
    },
    async createAutomationRule(workspaceID, body) {
      // The curated daemon does not expose AutomationRule CRUD endpoints yet;
      // this targets the upstream contract so generated suggestions persist
      // once the routes land.
      return await requestDaemon<AutomationRule>(
        input.runtimeApi,
        `/v1/workspaces/${encodeURIComponent(workspaceID)}/automation-rules`,
        {
          body,
          method: "POST"
        }
      );
    },
    async listModelPlans(workspaceID) {
      const response = await requestDaemon<ModelPlanListResponse>(
        input.runtimeApi,
        `/v1/workspaces/${encodeURIComponent(workspaceID)}/model-plans`
      );
      return response.plans;
    },
    async recommendWorkspaceModels(workspaceID, body) {
      // The curated daemon does not expose the recommend endpoint yet; this
      // targets the upstream contract so recommendations light up once it lands.
      const response = await requestDaemon<ModelRecommendationListResponse>(
        input.runtimeApi,
        `/v1/workspaces/${encodeURIComponent(workspaceID)}/model-plans/recommend`,
        {
          body,
          method: "POST"
        }
      );
      return response.recommendations;
    },
    setSystemAgentTargetEnabled(agentTargetID, enabled) {
      return input.tuttidClient.setSystemAgentTargetEnabled(
        agentTargetID,
        enabled
      );
    },
    purgeDeletedAgentConversations() {
      return input.tuttidClient.purgeDeletedAgentConversations();
    },
    clearLogs() {
      return input.developerApi.clearLogs();
    },
    exportLogs(scope) {
      return input.developerApi.exportLogs({ scope });
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
