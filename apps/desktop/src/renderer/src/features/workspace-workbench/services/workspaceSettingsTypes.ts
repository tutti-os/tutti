import type {
  DesktopDeveloperLogFileSummary,
  DesktopDeveloperLogsState
} from "@shared/contracts/ipc";
import type {
  AgentProviderCapabilityOption,
  AutomationRule,
  AutomationRuleAction,
  AutomationRuleTrigger,
  ModelPlanReference,
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
  | "developer"
  | "general"
  | "lab"
  | "model";

export type WorkspaceSettingsGeneralFocusAnchor =
  | "browser-use"
  | "computer-use";

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
  readonly pricing?: WorkspaceModelPlanPricing | null;
}

export interface WorkspaceModelPlanPricing {
  readonly currency: string;
  readonly inputMicrosPerMillion: number;
  readonly outputMicrosPerMillion: number;
  readonly cacheReadMicrosPerMillion: number;
  readonly cacheWriteMicrosPerMillion: number;
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

export type WorkspaceModelPlanReferenceKind = ModelPlanReference["kind"];

export interface WorkspaceModelPlanReference {
  readonly kind: WorkspaceModelPlanReferenceKind;
  readonly id: string;
  readonly name?: string | null;
  readonly role?: string | null;
}

export interface WorkspaceAgentModelBinding {
  readonly agentTargetId: string;
  readonly modelPlanId?: string | null;
  readonly defaultModel?: string | null;
  readonly modelPolicyId?: string | null;
  readonly updatedAt?: string | null;
}

export interface WorkspaceModelPlanBindingTarget {
  readonly enabled: boolean;
  readonly id: string;
  readonly name: string;
  readonly provider: string;
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

export type WorkspaceAutomationRuleAction = AutomationRuleAction;
export type WorkspaceAutomationRuleTrigger = AutomationRuleTrigger;

export type WorkspaceAutomationRule = WorkspaceSettingsReadonly<AutomationRule>;

/**
 * Local edit buffer for one daemon-owned AutomationRule. Separate model and
 * Agent target fields let an action switch safely without retaining an
 * invalid target shape in the request.
 */
export interface WorkspaceAutomationRuleDraft {
  automationRuleId: string | null;
  name: string;
  enabled: boolean;
  trigger: WorkspaceAutomationRuleTrigger;
  action: WorkspaceAutomationRuleAction;
  sourceWorkspaceAgentId: string;
  targetWorkspaceAgentId: string;
  modelPlanId: string;
  model: string;
  requiredCapabilities: string;
  permissionModeId: string;
  allowedTools: string;
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
}

/**
 * Local edit buffer for a plan being created (planId null) or edited.
 * The apiKey field only ever holds a value the user typed in this session;
 * stored credentials never come back from the daemon.
 */
export interface WorkspaceModelPlanDraft {
  planId: string | null;
  name: string;
  templateId: string | null;
  templateKind: WorkspaceModelPlanTemplateKind;
  protocol: WorkspaceModelPlanProtocol;
  apiKey: string;
  hasApiKey: boolean;
  baseUrl: string;
  models: readonly WorkspaceModelPlanModel[];
  defaultModel: string;
  enabled: boolean;
}

export interface WorkspaceModelPlanDraftSeed {
  baseUrl?: string;
  models?: readonly WorkspaceModelPlanModel[];
  name?: string;
  protocol: WorkspaceModelPlanProtocol;
  templateId?: string | null;
  templateKind: WorkspaceModelPlanTemplateKind;
}

export type WorkspaceModelPlanFeedbackKind =
  | "detectFailed"
  | "detectionRequired"
  | "deleteFailed"
  | "duplicateFailed"
  | "requiredFields"
  | "saveFailed"
  | "toggleFailed";

export interface WorkspaceModelPlanFeedback {
  kind: WorkspaceModelPlanFeedbackKind;
}

export interface WorkspaceModelPlanDeleteBlock {
  readonly planID: string;
  readonly references: readonly WorkspaceModelPlanReference[];
}

/** All current consumers shown before committing a model-range edit. */
export interface WorkspaceModelPlanSaveImpact {
  readonly planID: string;
  readonly references: readonly WorkspaceModelPlanReference[];
}

export interface WorkspaceSettingsAgentModelBindingsMutableState {
  agentTargets: WorkspaceModelPlanBindingTarget[];
  bindings: WorkspaceAgentModelBinding[];
  loadFailed: boolean;
  loading: boolean;
  saveFailedTargetID: string | null;
  savingTargetID: string | null;
}

export interface WorkspaceSettingsModelPlansMutableState {
  bindings: WorkspaceSettingsAgentModelBindingsMutableState;
  confirmingDeletePlanID: string | null;
  deleteBlock: WorkspaceModelPlanDeleteBlock | null;
  deletingPlanID: string | null;
  detecting: boolean;
  draft: WorkspaceModelPlanDraft | null;
  draftDetection: WorkspaceModelPlanDetection | null;
  draftDiscoveredModels: readonly WorkspaceModelPlanModel[];
  draftFeedback: WorkspaceModelPlanFeedback | null;
  draftSaveImpact: WorkspaceModelPlanSaveImpact | null;
  duplicatingPlanID: string | null;
  firstUseLaunchFailedPlanID: string | null;
  firstUseLaunchingPlanID: string | null;
  loading: boolean;
  planFeedback: Record<string, WorkspaceModelPlanFeedback>;
  plans: WorkspaceModelPlan[];
  saving: boolean;
  togglingPlanID: string | null;
}

export interface WorkspaceSettingsAgentModelBindingsSnapshotState {
  readonly agentTargets: readonly WorkspaceModelPlanBindingTarget[];
  readonly bindings: readonly WorkspaceAgentModelBinding[];
  readonly loadFailed: boolean;
  readonly loading: boolean;
  readonly saveFailedTargetID: string | null;
  readonly savingTargetID: string | null;
}

export interface WorkspaceSettingsModelPlansSnapshotState {
  readonly bindings: WorkspaceSettingsAgentModelBindingsSnapshotState;
  readonly confirmingDeletePlanID: string | null;
  readonly deleteBlock: WorkspaceModelPlanDeleteBlock | null;
  readonly deletingPlanID: string | null;
  readonly detecting: boolean;
  readonly draft: Readonly<WorkspaceModelPlanDraft> | null;
  readonly draftDetection: WorkspaceModelPlanDetection | null;
  readonly draftDiscoveredModels: readonly WorkspaceModelPlanModel[];
  readonly draftFeedback: Readonly<WorkspaceModelPlanFeedback> | null;
  readonly draftSaveImpact: WorkspaceModelPlanSaveImpact | null;
  readonly duplicatingPlanID: string | null;
  readonly firstUseLaunchFailedPlanID: string | null;
  readonly firstUseLaunchingPlanID: string | null;
  readonly loading: boolean;
  readonly planFeedback: Readonly<
    Record<string, Readonly<WorkspaceModelPlanFeedback>>
  >;
  readonly plans: readonly WorkspaceModelPlan[];
  readonly saving: boolean;
  readonly togglingPlanID: string | null;
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
  agents: WorkspaceSettingsWorkspaceAgentsMutableState;
  automationRules: WorkspaceSettingsAutomationRulesMutableState;
  developerPanelVisible: boolean;
  developerLogs: WorkspaceSettingsDeveloperLogsMutableState;
  generalFocusAnchor: WorkspaceSettingsGeneralFocusAnchor | null;
  generalFocusRequestID: number;
  modelPlans: WorkspaceSettingsModelPlansMutableState;
  open: boolean;
  tuttiAgentSwitchEnabled: boolean;
  workspaceID: string | null;
}

export interface WorkspaceSettingsReadableStoreState {
  readonly activeSection: WorkspaceSettingsSectionID;
  readonly agents: WorkspaceSettingsWorkspaceAgentsSnapshotState;
  readonly automationRules: WorkspaceSettingsAutomationRulesSnapshotState;
  readonly developerPanelVisible: boolean;
  readonly developerLogs: WorkspaceSettingsDeveloperLogsSnapshotState;
  readonly generalFocusAnchor: WorkspaceSettingsGeneralFocusAnchor | null;
  readonly generalFocusRequestID: number;
  readonly modelPlans: WorkspaceSettingsModelPlansSnapshotState;
  readonly open: boolean;
  readonly tuttiAgentSwitchEnabled: boolean;
  readonly workspaceID: string | null;
}
