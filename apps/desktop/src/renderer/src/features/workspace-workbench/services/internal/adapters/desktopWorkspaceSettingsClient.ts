import type {
  DesktopComputerUseApi,
  DesktopDeveloperApi,
  DesktopRuntimeApi
} from "@preload/types";
import {
  getTuttidProtocolErrorCode,
  type AgentProviderComposerOptionsResponse,
  type AgentTarget,
  type AutomationRule,
  type DeletedAgentConversationPurgeResult,
  type DetectModelPlanRequest,
  type DetectModelPlanResponse,
  type GenerateWorkspaceAgentDraftRequest,
  type PutModelPlanRequest,
  type PutAutomationRuleRequest,
  type PutWorkspaceAgentRequest,
  type RecommendWorkspaceModelsRequest,
  type SetAgentModelBindingRequest,
  type TuttidClient,
  type WorkspaceAgentDraftGeneration,
  type WorkspaceAgentProvider,
  type WorkspaceModelRecommendation
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
  ExportDeveloperLogsResult
} from "@shared/contracts/ipc";
import type {
  WorkspaceAgentModelBinding,
  WorkspaceAgentDefinition,
  WorkspaceModelPlan,
  WorkspaceModelPlanReference
} from "../../workspaceSettingsTypes.ts";

interface ClearWorkspaceAgentSessionsResponse {
  removedMessages: number;
  removedSessions: number;
}

export type PutModelPlanInput = PutModelPlanRequest;
export type DetectModelPlanInput = DetectModelPlanRequest;
export type DetectModelPlanResult = DetectModelPlanResponse;
export type RecommendWorkspaceModelsInput = RecommendWorkspaceModelsRequest;
export type SetAgentModelBindingInput = SetAgentModelBindingRequest;

export type PutWorkspaceAgentInput = PutWorkspaceAgentRequest;
export type PutAutomationRuleInput = PutAutomationRuleRequest;

export function isModelPlanReferencedError(error: unknown): boolean {
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
  getAgentProviderComposerOptions(
    workspaceID: string,
    provider: WorkspaceAgentProvider,
    agentTargetID: string
  ): Promise<AgentProviderComposerOptionsResponse>;
  listAutomationRules(workspaceID: string): Promise<AutomationRule[]>;
  createAutomationRule(
    workspaceID: string,
    input: PutAutomationRuleInput
  ): Promise<AutomationRule>;
  updateAutomationRule(
    workspaceID: string,
    automationRuleID: string,
    input: PutAutomationRuleInput
  ): Promise<AutomationRule>;
  deleteAutomationRule(
    workspaceID: string,
    automationRuleID: string
  ): Promise<void>;
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
  setSystemAgentTargetEnabled(
    agentTargetID: string,
    enabled: boolean
  ): Promise<AgentTarget>;
  clearLogs(): Promise<ClearDeveloperLogsResult>;
  clearWorkspaceAgentSessions(
    workspaceID: string
  ): Promise<ClearWorkspaceAgentSessionsResponse>;
  purgeDeletedAgentConversations(): Promise<DeletedAgentConversationPurgeResult>;
  exportLogs(): Promise<ExportDeveloperLogsResult>;
  getLogsState(): Promise<DesktopDeveloperLogsState>;
  openLogDirectory(): Promise<void>;
  openLogFile(kind: DesktopDeveloperLogKind): Promise<void>;
  listModelPlans(workspaceID: string): Promise<WorkspaceModelPlan[]>;
  recommendWorkspaceModels(
    workspaceID: string,
    input: RecommendWorkspaceModelsInput
  ): Promise<WorkspaceModelRecommendation[]>;
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
    | "generateWorkspaceAgentDraft"
    | "getAgentProviderComposerOptions"
    | "listAgentTargets"
    | "listAgentModelBindings"
    | "listAutomationRules"
    | "listModelPlanReferences"
    | "listWorkspaceModelPlans"
    | "listWorkspaceAgents"
    | "purgeDeletedAgentConversations"
    | "recommendWorkspaceModels"
    | "createModelPlan"
    | "deleteModelPlan"
    | "detectModelPlan"
    | "duplicateModelPlan"
    | "setAgentModelBinding"
    | "setModelPlanEnabled"
    | "setSystemAgentTargetEnabled"
    | "updateAutomationRule"
    | "updateModelPlan"
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
    async listAutomationRules(workspaceID) {
      return (await input.tuttidClient.listAutomationRules(workspaceID)).rules;
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
      return (await input.tuttidClient.listWorkspaceModelPlans(workspaceID))
        .plans;
    },
    async recommendWorkspaceModels(workspaceID, body) {
      return (
        await input.tuttidClient.recommendWorkspaceModels(workspaceID, body)
      ).recommendations;
    },
    async createModelPlan(workspaceID, body) {
      return await input.tuttidClient.createModelPlan(workspaceID, body);
    },
    async updateModelPlan(workspaceID, modelPlanID, body) {
      return await input.tuttidClient.updateModelPlan(
        workspaceID,
        modelPlanID,
        body
      );
    },
    async deleteModelPlan(workspaceID, modelPlanID) {
      await input.tuttidClient.deleteModelPlan(workspaceID, modelPlanID);
    },
    async duplicateModelPlan(workspaceID, modelPlanID) {
      return await input.tuttidClient.duplicateModelPlan(
        workspaceID,
        modelPlanID
      );
    },
    async setModelPlanEnabled(workspaceID, modelPlanID, enabled) {
      return await input.tuttidClient.setModelPlanEnabled(
        workspaceID,
        modelPlanID,
        { enabled }
      );
    },
    async listModelPlanReferences(workspaceID, modelPlanID) {
      return (
        await input.tuttidClient.listModelPlanReferences(
          workspaceID,
          modelPlanID
        )
      ).references;
    },
    async detectModelPlan(workspaceID, body) {
      return await input.tuttidClient.detectModelPlan(workspaceID, body);
    },
    async listAgentModelBindings(workspaceID) {
      return (await input.tuttidClient.listAgentModelBindings(workspaceID))
        .bindings;
    },
    async setAgentModelBinding(workspaceID, agentTargetID, body) {
      return await input.tuttidClient.setAgentModelBinding(
        workspaceID,
        agentTargetID,
        body
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
  if (!response.ok)
    throw new Error(`Daemon request failed (${response.status})`);
  return (await response.json()) as TResult;
}
