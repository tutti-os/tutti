import type {
  DesktopDeveloperLogFileSummary,
  DesktopDeveloperLogsState
} from "@shared/contracts/ipc";
import type {
  AgentProviderCapabilityOption,
  AutomationRule,
  WorkspaceAgent,
  WorkspaceAgentProvider,
  WorkspaceAgentGeneratedAutomationRule
} from "@tutti-os/client-tuttid-ts";

type WorkspaceSettingsReadonly<T> = T extends readonly (infer Item)[]
  ? readonly WorkspaceSettingsReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: WorkspaceSettingsReadonly<T[Key]> }
    : T;

export type WorkspaceSettingsSectionID =
  | "about"
  | "account"
  | "agent"
  | "appearance"
  | "apps"
  | "developer"
  | "general"
  | "lab";

export type WorkspaceSettingsGeneralFocusAnchor =
  | "browser-use"
  | "computer-use";

export type WorkspaceSettingsAgentTab = "general" | "agents";

export type WorkspaceModelPlanProtocol = "anthropic" | "openai";

export type WorkspaceModelPlanTemplateKind =
  | "official_subscription"
  | "coding_plan"
  | "domestic"
  | "relay"
  | "custom";

export type WorkspaceModelPlanBillingMode =
  | "api_metered"
  | "subscription_quota";

export type WorkspaceModelPlanStatus =
  | "disabled"
  | "undetected"
  | "detection_failed"
  | "pending_first_use"
  | "ready";

export type WorkspaceModelPlanDetectionStage =
  | "network"
  | "auth"
  | "model_discovery"
  | "inference"
  | "agent_runtime";

export type WorkspaceModelPlanStageStatus =
  | "passed"
  | "failed"
  | "skipped"
  | "pending";

export type WorkspaceModelPlanTier = "flagship" | "standard" | "economy";

export interface WorkspaceModelPlanModel {
  readonly id: string;
  readonly name: string;
  readonly tier?: WorkspaceModelPlanTier | null;
  readonly capabilities?: readonly string[] | null;
}

export interface WorkspaceModelPlanStageResult {
  readonly stage: WorkspaceModelPlanDetectionStage;
  readonly status: WorkspaceModelPlanStageStatus;
  readonly latencyMs?: number | null;
  readonly failureReason?: string | null;
  readonly remedy?: string | null;
  readonly detail?: string | null;
  readonly checkedAt?: string | null;
}

export interface WorkspaceModelPlanDetection {
  readonly stages: readonly WorkspaceModelPlanStageResult[];
  readonly checkedAt?: string | null;
  readonly model?: string | null;
}

export interface WorkspaceModelPlanFirstUse {
  readonly status: "pending" | "completed";
  readonly agentTargetId?: string | null;
  readonly agentSessionId?: string | null;
  readonly model?: string | null;
  readonly completedAt?: string | null;
}

/**
 * Renderer view of a daemon model access plan. Only the fields the workspace
 * Agents directory needs are modeled here; credential fields never leave the
 * daemon.
 */
export interface WorkspaceModelPlan {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly templateKind: WorkspaceModelPlanTemplateKind;
  readonly billingMode: WorkspaceModelPlanBillingMode;
  readonly protocol: WorkspaceModelPlanProtocol;
  readonly hasApiKey: boolean;
  readonly baseUrl?: string | null;
  readonly models: readonly WorkspaceModelPlanModel[];
  readonly defaultModel?: string | null;
  readonly enabled: boolean;
  readonly status: WorkspaceModelPlanStatus;
  readonly detection: WorkspaceModelPlanDetection;
  readonly firstUse: WorkspaceModelPlanFirstUse;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorkspaceAgentModelBinding {
  readonly agentTargetId: string;
  readonly modelPlanId?: string | null;
  readonly defaultModel?: string | null;
  readonly modelPolicyId?: string | null;
  readonly updatedAt?: string | null;
}

export type WorkspaceAgentHarness = WorkspaceSettingsReadonly<
  WorkspaceAgent["harness"]
>;

export interface WorkspaceAgentHarnessTargetOption {
  readonly enabled: boolean;
  readonly id: string;
  readonly name: string;
  readonly provider: WorkspaceAgentProvider;
}

export type WorkspaceAgentCapabilityOption =
  WorkspaceSettingsReadonly<AgentProviderCapabilityOption>;

export type WorkspaceAgentSource = WorkspaceAgent["source"];

export type WorkspaceAgentModelRef = WorkspaceSettingsReadonly<
  WorkspaceAgent["modelFallbacks"][number]
>;

/**
 * One explicit selectable Agent configuration. Its id is also the opaque
 * AgentGUI target identity; harness/provider details are presentation and
 * execution metadata rather than directory identity.
 */
export type WorkspaceAgentDefinition =
  WorkspaceSettingsReadonly<WorkspaceAgent>;

export interface WorkspaceAgentDraft {
  agentId: string | null;
  name: string;
  purpose: string;
  harnessAgentTargetId: string;
  modelPlanId: string;
  defaultModel: string;
  modelFallbacks: readonly WorkspaceAgentModelRef[];
  instructions: string;
  callConditions: string;
  capabilitiesExplicit: boolean;
  skills: string;
  tools: string;
  permissions: string;
  enabled: boolean;
  generationRequirements: string;
  generatedAutomationRules: readonly WorkspaceAgentGeneratedAutomationRule[];
}

export type WorkspaceAgentFeedbackKind =
  | "deleteFailed"
  | "generateFailed"
  | "generationRequiresPlan"
  | "generatedRulesSaveFailed"
  | "noRecommendation"
  | "recommendFailed"
  | "requiredFields"
  | "saveFailed";

export interface WorkspaceAgentFeedback {
  readonly kind: WorkspaceAgentFeedbackKind;
}

export interface WorkspaceSettingsWorkspaceAgentsMutableState {
  agents: WorkspaceAgentDefinition[];
  confirmingDeleteAgentID: string | null;
  deletingAgentID: string | null;
  draft: WorkspaceAgentDraft | null;
  feedback: WorkspaceAgentFeedback | null;
  capabilityCatalog: WorkspaceAgentCapabilityOption[];
  capabilityCatalogHarnessTargetID: string | null;
  capabilityCatalogLoadFailed: boolean;
  capabilityCatalogLoading: boolean;
  harnessTargets: WorkspaceAgentHarnessTargetOption[];
  loadFailed: boolean;
  loading: boolean;
  generating: boolean;
  recommendingFallback: boolean;
  saving: boolean;
}

export interface WorkspaceSettingsWorkspaceAgentsSnapshotState {
  readonly agents: readonly WorkspaceAgentDefinition[];
  readonly confirmingDeleteAgentID: string | null;
  readonly deletingAgentID: string | null;
  readonly draft: Readonly<WorkspaceAgentDraft> | null;
  readonly feedback: WorkspaceAgentFeedback | null;
  readonly capabilityCatalog: readonly WorkspaceAgentCapabilityOption[];
  readonly capabilityCatalogHarnessTargetID: string | null;
  readonly capabilityCatalogLoadFailed: boolean;
  readonly capabilityCatalogLoading: boolean;
  readonly harnessTargets: readonly WorkspaceAgentHarnessTargetOption[];
  readonly loadFailed: boolean;
  readonly loading: boolean;
  readonly generating: boolean;
  readonly recommendingFallback: boolean;
  readonly saving: boolean;
}

export type WorkspaceAutomationRule = WorkspaceSettingsReadonly<AutomationRule>;

/**
 * Minimal AutomationRule slice. The workspace Agents controller upserts
 * daemon-saved rules here so the directory reflects generated suggestions;
 * the dedicated rules editor lands with the automation-rules feature.
 */
export interface WorkspaceSettingsAutomationRulesMutableState {
  rules: WorkspaceAutomationRule[];
}

export interface WorkspaceSettingsAutomationRulesSnapshotState {
  readonly rules: readonly WorkspaceAutomationRule[];
}

/**
 * Minimal ModelPlan slice backing the workspace Agents editor's plan picker.
 * The full model-plan settings state lands with the model-plan feature.
 */
export interface WorkspaceSettingsModelPlansMutableState {
  plans: WorkspaceModelPlan[];
}

export interface WorkspaceSettingsModelPlansSnapshotState {
  readonly plans: readonly WorkspaceModelPlan[];
}

export type WorkspaceManagedModelProviderID = "agnes" | "openai" | "anthropic";

export interface WorkspaceManagedModel {
  id: string;
  name: string;
  provider: WorkspaceManagedModelProviderID;
}

export interface WorkspaceManagedModelProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  enabled: boolean;
  hasApiKey: boolean;
  models: readonly WorkspaceManagedModel[];
  provider: WorkspaceManagedModelProviderID;
  updatedAt?: string;
  workspaceId?: string;
}

export interface WorkspaceManagedModelProviderDraft extends WorkspaceManagedModelProviderConfig {
  apiKey: string;
}

export type WorkspaceManagedModelProviderFeedbackKind =
  | "testOk"
  | "testFailed"
  | "detectEmpty"
  | "detectFailed"
  | "saveFailed"
  | "deleteFailed"
  | "requiredFields";

export interface WorkspaceManagedModelProviderFeedback {
  kind: WorkspaceManagedModelProviderFeedbackKind;
}

export type WorkspaceManagedModelFeedbackMap = Partial<
  Record<WorkspaceManagedModelProviderID, WorkspaceManagedModelProviderFeedback>
>;

export interface WorkspaceSettingsManagedModelsMutableState {
  deletingProvider: WorkspaceManagedModelProviderID | null;
  detectingProvider: WorkspaceManagedModelProviderID | null;
  draft: WorkspaceManagedModelProviderDraft | null;
  feedback: WorkspaceManagedModelFeedbackMap;
  focusedProvider: WorkspaceManagedModelProviderID | null;
  focusRequestID: number;
  loading: boolean;
  providers: WorkspaceManagedModelProviderDraft[];
  savingProvider: WorkspaceManagedModelProviderID | null;
  testingProvider: WorkspaceManagedModelProviderID | null;
}

export interface WorkspaceSettingsManagedModelsSnapshotState {
  readonly deletingProvider: WorkspaceManagedModelProviderID | null;
  readonly detectingProvider: WorkspaceManagedModelProviderID | null;
  readonly draft: WorkspaceManagedModelProviderDraft | null;
  readonly feedback: WorkspaceManagedModelFeedbackMap;
  readonly focusedProvider: WorkspaceManagedModelProviderID | null;
  readonly focusRequestID: number;
  readonly loading: boolean;
  readonly providers: readonly WorkspaceManagedModelProviderDraft[];
  readonly savingProvider: WorkspaceManagedModelProviderID | null;
  readonly testingProvider: WorkspaceManagedModelProviderID | null;
}

export interface WorkspaceSettingsDeveloperLogsMutableState {
  clearing: boolean;
  clearingConversationHistory: boolean;
  exporting: boolean;
  loading: boolean;
  logs: DesktopDeveloperLogsState | null;
}

export interface WorkspaceSettingsDeveloperLogsSnapshotState {
  readonly clearing: boolean;
  readonly clearingConversationHistory: boolean;
  readonly exporting: boolean;
  readonly loading: boolean;
  readonly logs: {
    readonly desktopVersion: string;
    readonly files: readonly DesktopDeveloperLogFileSummary[];
    readonly logsDir: string;
    readonly totalFiles: number;
    readonly totalSizeBytes: number;
  } | null;
}

export interface WorkspaceSettingsStoreState {
  activeSection: WorkspaceSettingsSectionID;
  agentTab: WorkspaceSettingsAgentTab;
  agentFocusProvider: string | null;
  agentFocusRequestID: number;
  agents: WorkspaceSettingsWorkspaceAgentsMutableState;
  automationRules: WorkspaceSettingsAutomationRulesMutableState;
  developerPanelVisible: boolean;
  developerLogs: WorkspaceSettingsDeveloperLogsMutableState;
  generalFocusAnchor: WorkspaceSettingsGeneralFocusAnchor | null;
  generalFocusRequestID: number;
  managedModels: WorkspaceSettingsManagedModelsMutableState;
  modelPlans: WorkspaceSettingsModelPlansMutableState;
  open: boolean;
  purgingDeletedConversations: boolean;
  tuttiAgentSwitchEnabled: boolean;
  workspaceID: string | null;
}

export interface WorkspaceSettingsReadableStoreState {
  readonly activeSection: WorkspaceSettingsSectionID;
  readonly agentTab: WorkspaceSettingsAgentTab;
  readonly agentFocusProvider: string | null;
  readonly agentFocusRequestID: number;
  readonly agents: WorkspaceSettingsWorkspaceAgentsSnapshotState;
  readonly automationRules: WorkspaceSettingsAutomationRulesSnapshotState;
  readonly developerPanelVisible: boolean;
  readonly developerLogs: WorkspaceSettingsDeveloperLogsSnapshotState;
  readonly generalFocusAnchor: WorkspaceSettingsGeneralFocusAnchor | null;
  readonly generalFocusRequestID: number;
  readonly managedModels: WorkspaceSettingsManagedModelsSnapshotState;
  readonly modelPlans: WorkspaceSettingsModelPlansSnapshotState;
  readonly open: boolean;
  readonly purgingDeletedConversations: boolean;
  readonly tuttiAgentSwitchEnabled: boolean;
  readonly workspaceID: string | null;
}
