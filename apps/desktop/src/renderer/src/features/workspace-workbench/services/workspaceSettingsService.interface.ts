import { createDecorator } from "@tutti-os/infra/di";
import type { DesktopDeveloperLogKind } from "@shared/contracts/ipc";
import type { DesktopLocale } from "@shared/i18n";
import type {
  DesktopAgentProvider,
  DesktopDockIconStyle,
  DesktopDockPlacement,
  DesktopSleepPreventionMode
} from "@shared/preferences";
import type { DesktopThemeSource } from "@shared/theme";
import type {
  WorkspaceSettingsReadableStoreState,
  WorkspaceSettingsSectionID,
  WorkspaceManagedModelProviderDraft,
  WorkspaceManagedModelProviderID
} from "./workspaceSettingsTypes";

export type { WorkspaceSettingsSectionID } from "./workspaceSettingsTypes";

export interface WorkspaceSettingsWorkspaceInput {
  id: string;
}

export interface WorkspaceSettingsOpenOptions {
  pane?: string;
  provider?: string;
  section?: WorkspaceSettingsSectionID;
}

export interface IWorkspaceSettingsService {
  readonly _serviceBrand: undefined;
  readonly store: WorkspaceSettingsReadableStoreState;

  closePanel(): void;
  openPanel(
    workspace: WorkspaceSettingsWorkspaceInput,
    options?: WorkspaceSettingsOpenOptions
  ): void;
  selectSection(sectionID: WorkspaceSettingsSectionID): void;
  changeDefaultAgentProvider(provider: DesktopAgentProvider): Promise<void>;
  changeDockIconStyle(style: DesktopDockIconStyle): Promise<void>;
  changeDockPlacement(placement: DesktopDockPlacement): Promise<void>;
  changeLocale(nextLocale: DesktopLocale): Promise<void>;
  changeSleepPreventionMode(mode: DesktopSleepPreventionMode): Promise<void>;
  changeThemeSource(nextThemeSource: DesktopThemeSource): Promise<void>;
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
