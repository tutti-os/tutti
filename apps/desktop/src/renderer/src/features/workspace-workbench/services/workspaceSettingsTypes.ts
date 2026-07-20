import type {
  DesktopDeveloperLogFileSummary,
  DesktopDeveloperLogsState
} from "@shared/contracts/ipc";

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

export interface WorkspaceModelPlanModel {
  readonly id: string;
  readonly name: string;
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

export interface WorkspaceModelPlan {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly templateKind: WorkspaceModelPlanTemplateKind;
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

export type WorkspaceModelPlanReferenceKind =
  | "agent_target"
  | "model_policy"
  | "workspace_app";

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
  duplicatingPlanID: string | null;
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
  readonly duplicatingPlanID: string | null;
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
  agentTab: WorkspaceSettingsAgentTab;
  agentFocusProvider: string | null;
  agentFocusRequestID: number;
  developerPanelVisible: boolean;
  developerLogs: WorkspaceSettingsDeveloperLogsMutableState;
  generalFocusAnchor: WorkspaceSettingsGeneralFocusAnchor | null;
  generalFocusRequestID: number;
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
  readonly developerPanelVisible: boolean;
  readonly developerLogs: WorkspaceSettingsDeveloperLogsSnapshotState;
  readonly generalFocusAnchor: WorkspaceSettingsGeneralFocusAnchor | null;
  readonly generalFocusRequestID: number;
  readonly modelPlans: WorkspaceSettingsModelPlansSnapshotState;
  readonly open: boolean;
  readonly purgingDeletedConversations: boolean;
  readonly tuttiAgentSwitchEnabled: boolean;
  readonly workspaceID: string | null;
}
