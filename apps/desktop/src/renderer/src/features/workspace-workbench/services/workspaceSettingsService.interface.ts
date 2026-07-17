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
  WorkspaceAgentDraft,
  WorkspaceAutomationRuleDraft,
  WorkspaceModelPlanDraft,
  WorkspaceModelPlanDraftSeed
} from "./workspaceSettingsTypes";

export type { WorkspaceSettingsSectionID } from "./workspaceSettingsTypes";

export interface WorkspaceSettingsWorkspaceInput {
  id: string;
}

export interface WorkspaceAgentModelBindingChange {
  defaultModel?: string | null;
  modelPlanID?: string | null;
}

/**
 * Model access plan operations exposed by the settings service. All state
 * lives on the settings store's `modelPlans` slice. Binding operations are a
 * legacy compatibility surface and are not part of the default settings load.
 */
export interface IWorkspaceModelPlansController {
  beginDraft(seed: WorkspaceModelPlanDraftSeed): void;
  beginEditPlan(planID: string): void;
  cancelDeletePlan(): void;
  cancelDraft(): void;
  confirmDeletePlan(planID: string): Promise<void>;
  detectDraft(): Promise<void>;
  duplicatePlan(planID: string): Promise<void>;
  fetchDraftModels(): Promise<void>;
  launchFirstUse(planID: string, agentTargetID: string): Promise<void>;
  refresh(): Promise<void>;
  refreshBindings(): Promise<void>;
  refreshPlans(): Promise<void>;
  requestDeletePlan(planID: string): Promise<void>;
  saveDraft(): Promise<void>;
  setAgentBinding(
    agentTargetID: string,
    change: WorkspaceAgentModelBindingChange
  ): Promise<void>;
  setPlanEnabled(planID: string, enabled: boolean): Promise<void>;
  updateDraft(patch: Partial<WorkspaceModelPlanDraft>): void;
}

export interface IWorkspaceAgentsController {
  beginDraft(): void;
  beginEditAgent(agentID: string): void;
  cancelDeleteAgent(): void;
  cancelDraft(): void;
  confirmDeleteAgent(agentID: string): Promise<void>;
  refresh(): Promise<void>;
  requestDeleteAgent(agentID: string): void;
  saveDraft(): Promise<void>;
  updateDraft(patch: Partial<WorkspaceAgentDraft>): void;
}

export interface IWorkspaceAutomationRulesController {
  beginDraft(): void;
  beginEditRule(automationRuleID: string): void;
  cancelDeleteRule(): void;
  cancelDraft(): void;
  confirmDeleteRule(automationRuleID: string): Promise<void>;
  refresh(): Promise<void>;
  requestDeleteRule(automationRuleID: string): void;
  saveDraft(): Promise<void>;
  updateDraft(patch: Partial<WorkspaceAutomationRuleDraft>): void;
}

export interface WorkspaceSettingsOpenOptions {
  anchor?: WorkspaceSettingsGeneralFocusAnchor;
  pane?: string;
  provider?: string;
  section?: WorkspaceSettingsSectionID;
}

export interface IWorkspaceSettingsService {
  readonly _serviceBrand: undefined;
  readonly automationRules: IWorkspaceAutomationRulesController;
  readonly agents: IWorkspaceAgentsController;
  readonly modelPlans: IWorkspaceModelPlansController;
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
  changeEnableCursorAgent(enable: boolean): Promise<void>;
  changeEnableOpenCodeAgent(enable: boolean): Promise<void>;
  changeThemeSource(nextThemeSource: DesktopThemeSource): Promise<void>;
  changeUpdateChannel(channel: DesktopUpdateChannel): Promise<void>;
  changeUpdatePolicy(policy: DesktopUpdatePolicy): Promise<void>;
  clearConversationHistory(): Promise<void>;
  clearDeveloperLogs(): Promise<void>;
  exportDeveloperLogs(): Promise<void>;
  openLogDirectory(): Promise<void>;
  openLogFile(kind: DesktopDeveloperLogKind): Promise<void>;
  refreshDeveloperLogs(): Promise<void>;
  syncWorkspace(workspace: WorkspaceSettingsWorkspaceInput): void;
}

export const IWorkspaceSettingsService =
  createDecorator<IWorkspaceSettingsService>("workspace-settings-service");
