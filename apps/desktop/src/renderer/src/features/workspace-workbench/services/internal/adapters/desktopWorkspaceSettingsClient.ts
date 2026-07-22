import type {
  DesktopComputerUseApi,
  DesktopDeveloperApi,
  DesktopRuntimeApi
} from "@preload/types";
import type {
  AgentTarget,
  AutomationRule,
  DeletedAgentConversationPurgeResult,
  PutAutomationRuleRequest,
  PutWorkspaceAgentRequest,
  TuttidClient
} from "@tutti-os/client-tuttid-ts";
import { getTuttidProtocolErrorCode } from "@tutti-os/client-tuttid-ts";
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
  ExportDeveloperLogsInput,
  ExportDeveloperLogsResult
} from "@shared/contracts/ipc";
import type {
  WorkspaceAgentDefinition,
  WorkspaceAgentModelBinding,
  WorkspaceModelPlan,
  WorkspaceModelPlanDetection,
  WorkspaceModelPlanModel,
  WorkspaceModelPlanProtocol,
  WorkspaceModelPlanReference,
  WorkspaceModelPlanTemplateKind
} from "../../workspaceSettingsTypes.ts";

interface ModelPlanListResponse {
  plans: WorkspaceModelPlan[];
}

interface ModelPlanReferencesResponse {
  references: WorkspaceModelPlanReference[];
}

interface AgentModelBindingListResponse {
  bindings: WorkspaceAgentModelBinding[];
}

interface ClearWorkspaceAgentSessionsResponse {
  removedMessages: number;
  removedSessions: number;
}

export type PutWorkspaceAgentInput = PutWorkspaceAgentRequest;
export type PutAutomationRuleInput = PutAutomationRuleRequest;

/**
 * Permission-mode and tool option catalogs resolved from one target Agent's
 * composer capability directory.
 */
export interface AutomationTargetCatalogResult {
  permissionModes: { id: string; label: string }[];
  tools: { id: string; label: string }[];
}

export interface PutModelPlanInput {
  /** Omitted keeps the stored credential on update. */
  apiKey?: string;
  baseUrl: string;
  defaultModel?: string;
  enabled: boolean;
  models: Array<{ id: string; name: string }>;
  name: string;
  protocol: WorkspaceModelPlanProtocol;
  templateKind: WorkspaceModelPlanTemplateKind;
}

export interface DetectModelPlanInput {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  models?: Array<{ id: string; name: string }>;
  /** When set, omitted fields fall back to the stored plan. */
  planId?: string;
  protocol?: WorkspaceModelPlanProtocol;
}

export interface DetectModelPlanResult {
  detection: WorkspaceModelPlanDetection;
  discoveredModels: WorkspaceModelPlanModel[];
}

export interface SetAgentModelBindingInput {
  defaultModel?: string | null;
  modelPlanId?: string | null;
  modelPolicyId?: string | null;
}

export class DesktopWorkspaceSettingsDaemonError extends Error {
  readonly code: string | null;
  readonly status: number;

  constructor(status: number, code: string | null) {
    super(`Daemon request failed (${status}${code ? `: ${code}` : ""}).`);
    this.name = "DesktopWorkspaceSettingsDaemonError";
    this.code = code;
    this.status = status;
  }
}

export function isModelPlanReferencedError(error: unknown): boolean {
  if (
    error instanceof DesktopWorkspaceSettingsDaemonError &&
    error.code === "model_plan_referenced"
  ) {
    return true;
  }
  return getTuttidProtocolErrorCode(error) === "model_plan_referenced";
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
  setSystemAgentTargetEnabled(
    agentTargetID: string,
    enabled: boolean
  ): Promise<AgentTarget>;
  clearLogs(): Promise<ClearDeveloperLogsResult>;
  clearWorkspaceAgentSessions(
    workspaceID: string
  ): Promise<ClearWorkspaceAgentSessionsResponse>;
  purgeDeletedAgentConversations(): Promise<DeletedAgentConversationPurgeResult>;
  exportLogs(
    input: ExportDeveloperLogsInput
  ): Promise<ExportDeveloperLogsResult>;
  getLogsState(): Promise<DesktopDeveloperLogsState>;
  openLogDirectory(): Promise<void>;
  openLogFile(kind: DesktopDeveloperLogKind): Promise<void>;
  listWorkspaceAgents(workspaceID: string): Promise<WorkspaceAgentDefinition[]>;
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
  listAutomationRules(workspaceID: string): Promise<AutomationRule[]>;
  getAutomationTargetCatalog(
    workspaceID: string,
    provider: string,
    agentTargetID: string
  ): Promise<AutomationTargetCatalogResult>;
  updateAutomationRule(
    workspaceID: string,
    automationRuleID: string,
    input: PutAutomationRuleInput
  ): Promise<AutomationRule>;
  createAutomationRule(
    workspaceID: string,
    input: PutAutomationRuleInput
  ): Promise<AutomationRule>;
  deleteAutomationRule(
    workspaceID: string,
    automationRuleID: string
  ): Promise<void>;
  listModelPlans(workspaceID: string): Promise<WorkspaceModelPlan[]>;
  createModelPlan(
    workspaceID: string,
    input: PutModelPlanInput
  ): Promise<WorkspaceModelPlan>;
  updateModelPlan(
    workspaceID: string,
    modelPlanID: string,
    input: PutModelPlanInput
  ): Promise<WorkspaceModelPlan>;
  deleteModelPlan(workspaceID: string, modelPlanID: string): Promise<void>;
  duplicateModelPlan(
    workspaceID: string,
    modelPlanID: string
  ): Promise<WorkspaceModelPlan>;
  setModelPlanEnabled(
    workspaceID: string,
    modelPlanID: string,
    enabled: boolean
  ): Promise<WorkspaceModelPlan>;
  listModelPlanReferences(
    workspaceID: string,
    modelPlanID: string
  ): Promise<WorkspaceModelPlanReference[]>;
  detectModelPlan(
    workspaceID: string,
    input: DetectModelPlanInput
  ): Promise<DetectModelPlanResult>;
  listAgentModelBindings(
    workspaceID: string
  ): Promise<WorkspaceAgentModelBinding[]>;
  setAgentModelBinding(
    workspaceID: string,
    agentTargetID: string,
    input: SetAgentModelBindingInput
  ): Promise<WorkspaceAgentModelBinding>;
}

export function createDesktopWorkspaceSettingsClient(input: {
  computerUseApi: DesktopComputerUseApi;
  developerApi: DesktopDeveloperApi;
  runtimeApi: DesktopRuntimeApi;
  tuttidClient: Pick<
    TuttidClient,
    | "createAutomationRule"
    | "createWorkspaceAgent"
    | "deleteAutomationRule"
    | "deleteWorkspaceAgent"
    | "getAgentProviderComposerOptions"
    | "listAgentTargets"
    | "listAutomationRules"
    | "listWorkspaceAgents"
    | "purgeDeletedAgentConversations"
    | "setSystemAgentTargetEnabled"
    | "updateAutomationRule"
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
    async listWorkspaceAgents(workspaceID) {
      return (await input.tuttidClient.listWorkspaceAgents(workspaceID)).agents;
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
    async listAutomationRules(workspaceID) {
      return (await input.tuttidClient.listAutomationRules(workspaceID)).rules;
    },
    async getAutomationTargetCatalog(workspaceID, provider, agentTargetID) {
      const options = await input.tuttidClient.getAgentProviderComposerOptions(
        provider as AgentTarget["provider"],
        { agentTargetId: agentTargetID, workspaceId: workspaceID }
      );
      return {
        permissionModes: options.permissionConfig.modes.map((mode) => ({
          id: mode.id,
          label: mode.label
        })),
        tools: options.capabilityCatalog
          .filter(
            (option) =>
              option.kind !== "skill" && option.status !== "unsupported"
          )
          .map((option) => ({ id: option.id, label: option.label }))
      };
    },
    async createAutomationRule(workspaceID, body) {
      return await input.tuttidClient.createAutomationRule(workspaceID, body);
    },
    async updateAutomationRule(workspaceID, automationRuleID, body) {
      return await input.tuttidClient.updateAutomationRule(
        workspaceID,
        automationRuleID,
        body
      );
    },
    async deleteAutomationRule(workspaceID, automationRuleID) {
      await input.tuttidClient.deleteAutomationRule(
        workspaceID,
        automationRuleID
      );
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
    exportLogs(exportInput) {
      return input.developerApi.exportLogs(exportInput);
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
    async clearWorkspaceAgentSessions(workspaceID) {
      return await requestDaemon<ClearWorkspaceAgentSessionsResponse>(
        input.runtimeApi,
        `/v1/workspaces/${encodeURIComponent(workspaceID)}/agent-sessions`,
        {
          method: "DELETE"
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
    async createModelPlan(workspaceID, body) {
      return await requestDaemon<WorkspaceModelPlan>(
        input.runtimeApi,
        `/v1/workspaces/${encodeURIComponent(workspaceID)}/model-plans`,
        {
          body,
          method: "POST"
        }
      );
    },
    async updateModelPlan(workspaceID, modelPlanID, body) {
      return await requestDaemon<WorkspaceModelPlan>(
        input.runtimeApi,
        `/v1/workspaces/${encodeURIComponent(workspaceID)}/model-plans/${encodeURIComponent(modelPlanID)}`,
        {
          body,
          method: "PUT"
        }
      );
    },
    async deleteModelPlan(workspaceID, modelPlanID) {
      await requestDaemon(
        input.runtimeApi,
        `/v1/workspaces/${encodeURIComponent(workspaceID)}/model-plans/${encodeURIComponent(modelPlanID)}`,
        {
          method: "DELETE"
        }
      );
    },
    async duplicateModelPlan(workspaceID, modelPlanID) {
      return await requestDaemon<WorkspaceModelPlan>(
        input.runtimeApi,
        `/v1/workspaces/${encodeURIComponent(workspaceID)}/model-plans/${encodeURIComponent(modelPlanID)}/duplicate`,
        {
          body: {},
          method: "POST"
        }
      );
    },
    async setModelPlanEnabled(workspaceID, modelPlanID, enabled) {
      return await requestDaemon<WorkspaceModelPlan>(
        input.runtimeApi,
        `/v1/workspaces/${encodeURIComponent(workspaceID)}/model-plans/${encodeURIComponent(modelPlanID)}/enabled`,
        {
          body: { enabled },
          method: "PATCH"
        }
      );
    },
    async listModelPlanReferences(workspaceID, modelPlanID) {
      const response = await requestDaemon<ModelPlanReferencesResponse>(
        input.runtimeApi,
        `/v1/workspaces/${encodeURIComponent(workspaceID)}/model-plans/${encodeURIComponent(modelPlanID)}/references`
      );
      return response.references;
    },
    async detectModelPlan(workspaceID, body) {
      return await requestDaemon<DetectModelPlanResult>(
        input.runtimeApi,
        `/v1/workspaces/${encodeURIComponent(workspaceID)}/model-plans/detect`,
        {
          body,
          method: "POST"
        }
      );
    },
    async listAgentModelBindings(workspaceID) {
      const response = await requestDaemon<AgentModelBindingListResponse>(
        input.runtimeApi,
        `/v1/workspaces/${encodeURIComponent(workspaceID)}/agent-model-bindings`
      );
      return response.bindings;
    },
    async setAgentModelBinding(workspaceID, agentTargetID, body) {
      return await requestDaemon<WorkspaceAgentModelBinding>(
        input.runtimeApi,
        `/v1/workspaces/${encodeURIComponent(workspaceID)}/agent-model-bindings/${encodeURIComponent(agentTargetID)}`,
        {
          body,
          method: "PUT"
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
    throw new DesktopWorkspaceSettingsDaemonError(
      response.status,
      await readDaemonErrorCode(response)
    );
  }
  return (await response.json()) as TResult;
}

async function readDaemonErrorCode(response: Response): Promise<string | null> {
  try {
    const payload = (await response.json()) as {
      error?: { code?: unknown };
    } | null;
    const code = payload?.error?.code;
    return typeof code === "string" ? code : null;
  } catch {
    return null;
  }
}
