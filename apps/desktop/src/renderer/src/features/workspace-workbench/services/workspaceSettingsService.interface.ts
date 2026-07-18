import { createDecorator } from "@tutti-os/infra/di";
import type {
  DesktopComputerUseActionResult,
  DesktopComputerUsePermissionGrantStatus,
  DesktopComputerUsePermissionPane,
  DesktopComputerUseRestartDriverInput,
  DesktopComputerUseRestartDriverResult,
  DesktopComputerUseStatus,
  DesktopDeveloperLogKind
} from "@shared/contracts/ipc";
import type { DesktopLocale } from "@shared/i18n";
import type {
  DesktopDefaultAgentProvider,
  DesktopAgentConversationDetailMode,
  DesktopAppCatalogChannel,
  DesktopBrowserUseConnectionMode,
  DesktopDockIconStyle,
  DesktopDockPlacement,
  DeletedAgentConversationRetentionDays,
  DesktopFeatureFlags,
  DesktopWorkspaceUiMode,
  DesktopMinimizeAnimation,
  DesktopSleepPreventionMode,
  DesktopUpdateChannel,
  DesktopUpdatePolicy,
  DesktopWorkbenchShortcuts,
  DesktopWorkbenchWindowSnapping
} from "@shared/preferences";
import type { DesktopThemeSource } from "@shared/theme";
import type {
  WorkspaceSettingsReadableStoreState,
  WorkspaceSettingsGeneralFocusAnchor,
  WorkspaceSettingsSectionID,
  WorkspaceManagedModelProviderDraft,
  WorkspaceManagedModelProviderID
} from "./workspaceSettingsTypes";

export type { WorkspaceSettingsSectionID } from "./workspaceSettingsTypes";

export interface WorkspaceSettingsWorkspaceInput {
  id: string;
}

export interface WorkspaceSettingsOpenOptions {
  anchor?: WorkspaceSettingsGeneralFocusAnchor;
  pane?: string;
  provider?: string;
  section?: WorkspaceSettingsSectionID;
}

export interface IWorkspaceSettingsService {
  readonly _serviceBrand: undefined;
  readonly store: WorkspaceSettingsReadableStoreState;

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
  }): void;
  openComputerUsePermissionSettings(
    pane: DesktopComputerUsePermissionPane
  ): Promise<void>;
  restartComputerUseDriver(
    input?: DesktopComputerUseRestartDriverInput
  ): Promise<DesktopComputerUseRestartDriverResult>;
  closePanel(): void;
  openPanel(
    workspace: WorkspaceSettingsWorkspaceInput,
    options?: WorkspaceSettingsOpenOptions
  ): void;
  selectSection(sectionID: WorkspaceSettingsSectionID): void;
  setDeveloperPanelVisible(visible: boolean): void;
  setTuttiAgentSwitchEnabled(enabled: boolean): Promise<void>;
  beginManagedModelProviderDraft(
    provider: WorkspaceManagedModelProviderID
  ): void;
  updateManagedModelDraft(
    patch: Partial<WorkspaceManagedModelProviderDraft>
  ): void;
  cancelManagedModelProviderDraft(): void;
  saveManagedModelDraft(): Promise<void>;
  setManagedModelProviderEnabled(
    providerID: WorkspaceManagedModelProviderID,
    enabled: boolean
  ): Promise<void>;
  changeDefaultAgentProvider(
    provider: DesktopDefaultAgentProvider
  ): Promise<void>;
  changeAgentConversationDetailMode(
    mode: DesktopAgentConversationDetailMode
  ): Promise<void>;
  changeAppCatalogChannel(channel: DesktopAppCatalogChannel): Promise<void>;
  changeBrowserUseConnectionMode(
    mode: DesktopBrowserUseConnectionMode
  ): Promise<void>;
  changeDockIconStyle(style: DesktopDockIconStyle): Promise<void>;
  changeDockPlacement(placement: DesktopDockPlacement): Promise<void>;
  changeDeletedAgentConversationRetentionDays(
    days: DeletedAgentConversationRetentionDays
  ): Promise<void>;
  changeFeatureFlags(flags: DesktopFeatureFlags): Promise<void>;
  changeWorkspaceUiMode(mode: DesktopWorkspaceUiMode): Promise<void>;
  changeWorkbenchShortcuts(shortcuts: DesktopWorkbenchShortcuts): Promise<void>;
  changeMinimizeAnimation(animation: DesktopMinimizeAnimation): Promise<void>;
  changeWorkbenchWindowSnapping(
    value: DesktopWorkbenchWindowSnapping
  ): Promise<void>;
  changeLocale(nextLocale: DesktopLocale): Promise<void>;
  changeSleepPreventionMode(mode: DesktopSleepPreventionMode): Promise<void>;
  changeShowAppDeveloperSources(show: boolean): Promise<void>;
  changeThemeSource(nextThemeSource: DesktopThemeSource): Promise<void>;
  changeUpdateChannel(channel: DesktopUpdateChannel): Promise<void>;
  changeUpdatePolicy(policy: DesktopUpdatePolicy): Promise<void>;
  clearConversationHistory(): Promise<void>;
  purgeDeletedConversations(): Promise<void>;
  clearDeveloperLogs(): Promise<void>;
  exportDeveloperLogs(): Promise<void>;
  openLogDirectory(): Promise<void>;
  openLogFile(kind: DesktopDeveloperLogKind): Promise<void>;
  refreshDeveloperLogs(): Promise<void>;
  refreshManagedModelProviders(): Promise<void>;
  detectManagedModelProviderModels(
    providerID: WorkspaceManagedModelProviderID
  ): Promise<void>;
  removeManagedModelProvider(
    providerID: WorkspaceManagedModelProviderID
  ): Promise<void>;
  saveManagedModelProvider(
    provider: WorkspaceManagedModelProviderDraft
  ): Promise<void>;
  syncWorkspace(workspace: WorkspaceSettingsWorkspaceInput): void;
  testManagedModelProvider(
    providerID: WorkspaceManagedModelProviderID
  ): Promise<void>;
  updateManagedModelProviderDraft(
    providerID: WorkspaceManagedModelProviderID,
    patch: Partial<WorkspaceManagedModelProviderDraft>
  ): void;
}

export const IWorkspaceSettingsService =
  createDecorator<IWorkspaceSettingsService>("workspace-settings-service");
