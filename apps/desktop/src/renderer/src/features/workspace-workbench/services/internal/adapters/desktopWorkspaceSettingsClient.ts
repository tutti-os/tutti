import type {
  DesktopComputerUseApi,
  DesktopDeveloperApi,
  DesktopRuntimeApi
} from "@preload/types";
import {
  getTuttidProtocolErrorCode,
  type AgentTarget,
  type AutomationRule,
  type DetectModelPlanRequest,
  type DetectModelPlanResponse,
  type PutModelPlanRequest,
  type PutAutomationRuleRequest,
  type PutWorkspaceAgentRequest,
  type SetAgentModelBindingRequest,
  type TuttidClient
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
export type SetAgentModelBindingInput = SetAgentModelBindingRequest;

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
  getAutomationTargetCatalog(
    workspaceID: string,
    provider: string,
    agentTargetID: string
  ): Promise<AutomationTargetCatalogResult>;
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
  setSystemAgentTargetEnabled(
    agentTargetID: string,
    enabled: boolean
  ): Promise<AgentTarget>;
  clearLogs(): Promise<ClearDeveloperLogsResult>;
  clearWorkspaceAgentSessions(
    workspaceID: string
  ): Promise<ClearWorkspaceAgentSessionsResponse>;
  exportLogs(): Promise<ExportDeveloperLogsResult>;
  getLogsState(): Promise<DesktopDeveloperLogsState>;
  openLogDirectory(): Promise<void>;
  openLogFile(kind: DesktopDeveloperLogKind): Promise<void>;
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
    | "listAgentModelBindings"
    | "listAutomationRules"
    | "listModelPlanReferences"
    | "listWorkspaceModelPlans"
    | "listWorkspaceAgents"
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
    setSystemAgentTargetEnabled(agentTargetID, enabled) {
      return input.tuttidClient.setSystemAgentTargetEnabled(
        agentTargetID,
        enabled
      );
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
