import type {
  DesktopDeveloperLogFileSummary,
  DesktopDeveloperLogsState
} from "@shared/contracts/ipc";
import type {
  AutomationRule,
  AutomationRuleTrigger,
  WorkspaceAgent,
  WorkspaceAgentProvider
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

export type WorkspaceAgentSource = WorkspaceAgent["source"];

/**
 * One explicit selectable Agent configuration. Its id is also the opaque
 * AgentGUI target identity; harness/provider details are presentation and
 * execution metadata rather than directory identity.
 */
export type WorkspaceAgentDefinition =
  WorkspaceSettingsReadonly<WorkspaceAgent>;

/**
 * Local edit buffer for the simplified Agent editor: name, Agent Runtime,
 * plan + default model, description, and behavior text. Dormant contract
 * fields (fallback chain, capability allowlists) are not editable; the draft
 * carries the stored values through opaquely so saving never clears them.
 */
export interface WorkspaceAgentDraft {
  agentId: string | null;
  name: string;
  description: string;
  harnessAgentTargetId: string;
  modelPlanId: string;
  defaultModel: string;
  instructions: string;
  callConditions: string;
  dormant: WorkspaceAgentDormantFields;
}

/**
 * Dormant WorkspaceAgent contract fields preserved verbatim between load and
 * save. They have no editor surface; the daemon remains their authority.
 */
export interface WorkspaceAgentDormantFields {
  readonly capabilitiesExplicit: boolean;
  readonly modelFallbacks: WorkspaceAgentDefinition["modelFallbacks"];
  readonly skills: readonly string[];
  readonly tools: readonly string[];
}

export type WorkspaceAgentFeedbackKind =
  | "deleteFailed"
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
  harnessTargets: WorkspaceAgentHarnessTargetOption[];
  loadFailed: boolean;
  loading: boolean;
  saving: boolean;
}

export interface WorkspaceSettingsWorkspaceAgentsSnapshotState {
  readonly agents: readonly WorkspaceAgentDefinition[];
  readonly confirmingDeleteAgentID: string | null;
  readonly deletingAgentID: string | null;
  readonly draft: Readonly<WorkspaceAgentDraft> | null;
  readonly feedback: WorkspaceAgentFeedback | null;
  readonly harnessTargets: readonly WorkspaceAgentHarnessTargetOption[];
  readonly loadFailed: boolean;
  readonly loading: boolean;
  readonly saving: boolean;
}

export type WorkspaceAutomationRuleTrigger = AutomationRuleTrigger;

export type WorkspaceAutomationRule = WorkspaceSettingsReadonly<AutomationRule>;

/**
 * One selectable automation launch target: a built-in Harness target or an
 * enabled WorkspaceAgent. Built-ins stay selectable even when no
 * WorkspaceAgent exists.
 */
export interface WorkspaceAutomationTargetOption {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly kind: "builtin" | "workspaceAgent";
}

/**
 * Permission-mode and tool option catalogs resolved from the selected target
 * Agent's composer capability directory.
 */
export interface WorkspaceAutomationTargetCatalog {
  agentTargetId: string;
  loading: boolean;
  loadFailed: boolean;
  permissionModes: readonly { readonly id: string; readonly label: string }[];
  tools: readonly { readonly id: string; readonly label: string }[];
}

/**
 * Local edit buffer for one daemon-owned AutomationRule. A rule has exactly
 * one behavior: launch a new target-Agent session that mentions the source
 * session, so the buffer carries a single target plus its narrowed
 * permissions.
 */
export interface WorkspaceAutomationRuleDraft {
  automationRuleId: string | null;
  name: string;
  enabled: boolean;
  trigger: WorkspaceAutomationRuleTrigger;
  sourceWorkspaceAgentId: string;
  targetAgentId: string;
  permissionModeId: string;
  allowedTools: readonly string[];
  maxRunsPerSession: string;
  maxTotalTokensPerSession: string;
  prompt: string;
}

export type WorkspaceAutomationRuleFeedbackKind =
  | "deleteFailed"
  | "invalidBudget"
  | "requiredFields"
  | "saveFailed";

export interface WorkspaceAutomationRuleFeedback {
  readonly kind: WorkspaceAutomationRuleFeedbackKind;
}

export interface WorkspaceSettingsAutomationRulesMutableState {
  rules: WorkspaceAutomationRule[];
  confirmingDeleteRuleID: string | null;
  deletingRuleID: string | null;
  draft: WorkspaceAutomationRuleDraft | null;
  feedback: WorkspaceAutomationRuleFeedback | null;
  loadFailed: boolean;
  loading: boolean;
  saving: boolean;
  targetOptions: WorkspaceAutomationTargetOption[];
  targetCatalog: WorkspaceAutomationTargetCatalog | null;
}

export interface WorkspaceSettingsAutomationRulesSnapshotState {
  readonly rules: readonly WorkspaceAutomationRule[];
  readonly confirmingDeleteRuleID: string | null;
  readonly deletingRuleID: string | null;
  readonly draft: Readonly<WorkspaceAutomationRuleDraft> | null;
  readonly feedback: WorkspaceAutomationRuleFeedback | null;
  readonly loadFailed: boolean;
  readonly loading: boolean;
  readonly saving: boolean;
  readonly targetOptions: readonly WorkspaceAutomationTargetOption[];
  readonly targetCatalog: Readonly<WorkspaceAutomationTargetCatalog> | null;
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
