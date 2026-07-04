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
  | "general";

export type WorkspaceSettingsGeneralFocusAnchor =
  | "browser-use"
  | "computer-use";

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

export interface WorkspaceSettingsDeveloperLogsState {
  readonly clearing: boolean;
  readonly clearingConversationHistory: boolean;
  readonly exporting: boolean;
  readonly loading: boolean;
  readonly logs: DesktopDeveloperLogsState | null;
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
  developerPanelVisible: boolean;
  developerLogs: WorkspaceSettingsDeveloperLogsMutableState;
  generalFocusAnchor: WorkspaceSettingsGeneralFocusAnchor | null;
  generalFocusRequestID: number;
  managedModels: WorkspaceSettingsManagedModelsMutableState;
  open: boolean;
  tuttiAgentSwitchEnabled: boolean;
  workspaceID: string | null;
}

export interface WorkspaceSettingsReadableStoreState {
  readonly activeSection: WorkspaceSettingsSectionID;
  readonly developerPanelVisible: boolean;
  readonly developerLogs: WorkspaceSettingsDeveloperLogsSnapshotState;
  readonly generalFocusAnchor: WorkspaceSettingsGeneralFocusAnchor | null;
  readonly generalFocusRequestID: number;
  readonly managedModels: WorkspaceSettingsManagedModelsSnapshotState;
  readonly open: boolean;
  readonly tuttiAgentSwitchEnabled: boolean;
  readonly workspaceID: string | null;
}
