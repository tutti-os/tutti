import type {
  DesktopComputerUsePermissionPane,
  DesktopComputerUseRestartDriverInput,
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
import {
  defaultDesktopFeatureFlags,
  defaultDesktopMinimizeAnimation,
  defaultDesktopWorkbenchShortcuts,
  desktopFeatureFlagsEqual,
  desktopWorkbenchShortcutsEqual,
  desktopWorkbenchWindowSnappingEqual
} from "../../../../../../shared/preferences/index.ts";
import { withDesktopWorkspaceUiMode } from "../../../../../../shared/featureFlags/catalog.ts";
import type { DesktopThemeSource, DesktopThemeState } from "@shared/theme";
import {
  INotificationService,
  type NotificationService
} from "@tutti-os/ui-notifications";
import {
  IDesktopPreferencesService,
  type IDesktopPreferencesService as DesktopPreferencesService
} from "../../../desktop-preferences/services/desktopPreferencesService.interface.ts";
import {
  IWorkspaceAppCenterService,
  type IWorkspaceAppCenterService as WorkspaceAppCenterService
} from "../../../workspace-app-center/services/workspaceAppCenterService.interface.ts";
import { SettingsOpenedReporter } from "../../../analytics/reporters/settings-opened/settingsOpenedReporter.ts";
import { SettingsSectionSwitchedReporter } from "../../../analytics/reporters/settings-section-switched/settingsSectionSwitchedReporter.ts";
import { SettingsLanguageChangedReporter } from "../../../analytics/reporters/settings-language-changed/settingsLanguageChangedReporter.ts";
import { SettingsThemeChangedReporter } from "../../../analytics/reporters/settings-theme-changed/settingsThemeChangedReporter.ts";
import {
  IReporterService,
  type IReporterService as ReporterService
} from "../../../analytics/services/reporterService.interface.ts";
import type { DesktopPreferencesReadableStoreState } from "../../../desktop-preferences/services/desktopPreferencesTypes.ts";
import { getActiveLocale } from "../../../../i18n/runtime.ts";
import { createTranslator } from "../../../../../../shared/i18n/index.ts";
import type {
  IWorkspaceSettingsService,
  WorkspaceSettingsOpenOptions,
  WorkspaceSettingsSectionID,
  WorkspaceSettingsWorkspaceInput
} from "../workspaceSettingsService.interface";
import type { DesktopWorkspaceSettingsClient } from "./adapters/desktopWorkspaceSettingsClient.ts";
import { formatWorkspaceSettingsBytes } from "../workspaceSettingsFormat.ts";
import { createWorkspaceSettingsStore } from "./workspaceSettingsStore.ts";
import { writeDeveloperPanelVisible } from "./developerPanelVisibility.ts";
import {
  clearTuttiAgentSwitchDaemonMigration,
  hasMigratedTuttiAgentSwitchToDaemon,
  type LegacyTuttiAgentSwitchReadResult,
  markTuttiAgentSwitchDaemonMigrationComplete,
  readLegacyTuttiAgentSwitchEnabled
} from "../tuttiAgentSwitchPreference.ts";
import type {
  WorkspaceManagedModel,
  WorkspaceManagedModelProviderConfig,
  WorkspaceManagedModelProviderDraft,
  WorkspaceManagedModelProviderFeedbackKind,
  WorkspaceManagedModelProviderID
} from "../workspaceSettingsTypes.ts";
import {
  createWorkspaceFeatureFlagSettings,
  type WorkspaceFeatureFlagSettings
} from "./workspaceFeatureFlagSettings.ts";

const managedModelProviderIDs: WorkspaceManagedModelProviderID[] = [
  "agnes",
  "openai",
  "anthropic"
];

export interface WorkspaceSettingsServiceDependencies {
  client: DesktopWorkspaceSettingsClient;
  onAgentTargetsChanged?: () => void | Promise<void>;
  replaceWorkspaceWindow?: (input: {
    mode: "agent" | "os";
    workspaceId: string;
  }) => Promise<void>;
  tuttiAgentSwitchMigration?: {
    clearComplete(): void;
    hasMigrated(): boolean;
    markComplete(): boolean;
    readLegacyEnabled(): LegacyTuttiAgentSwitchReadResult;
  };
}

const tuttiAgentTargetID = "local:tutti-agent";

export class WorkspaceSettingsService implements IWorkspaceSettingsService {
  readonly _serviceBrand: undefined;
  readonly store = createWorkspaceSettingsStore();

  private readonly dependencies: WorkspaceSettingsServiceDependencies;
  private readonly desktopPreferences: DesktopPreferencesService;
  private readonly featureFlagSettings: WorkspaceFeatureFlagSettings;
  private readonly notifications: NotificationService;
  private readonly reporterService: Pick<ReporterService, "trackEvents"> | null;
  private readonly appCenterService: Pick<
    WorkspaceAppCenterService,
    "refreshCatalog"
  > | null;
  private readonly reporterNow?: () => number;
  private logsLoadSequence = 0;
  private tuttiAgentSwitchInitializationPending = false;
  private tuttiAgentSwitchInitialized = false;
  private tuttiAgentSwitchOperation: Promise<void> = Promise.resolve();

  constructor(
    dependencies: WorkspaceSettingsServiceDependencies,
    desktopPreferences: DesktopPreferencesService = noopDesktopPreferences,
    notifications: NotificationService = noopNotifications,
    reporterService: Pick<ReporterService, "trackEvents"> | null = null,
    appCenterService: Pick<
      WorkspaceAppCenterService,
      "refreshCatalog"
    > | null = null,
    reporterNow?: () => number
  ) {
    this.dependencies = dependencies;
    this.desktopPreferences = desktopPreferences;
    this.featureFlagSettings = createWorkspaceFeatureFlagSettings({
      desktopPreferences,
      notifications,
      refreshAgentTargets: () => this.refreshAgentTargetConsumers()
    });
    this.notifications = notifications;
    this.reporterService = reporterService;
    this.appCenterService = appCenterService;
    this.reporterNow = reporterNow;
    this.scheduleTuttiAgentSwitchInitialization();
  }

  openPanel(
    workspace: WorkspaceSettingsWorkspaceInput,
    options?: WorkspaceSettingsOpenOptions
  ): void {
    this.scheduleTuttiAgentSwitchInitialization();
    this.syncWorkspace(workspace);
    const managedModelsRequested = options?.pane === "managed-models";
    if (managedModelsRequested) {
      this.store.activeSection = "apps";
    } else if (options?.section) {
      this.store.activeSection = options.section;
    }
    if (options?.anchor) {
      this.store.activeSection = "agent";
      this.store.generalFocusAnchor = options.anchor;
      this.store.generalFocusRequestID += 1;
    }
    if (managedModelsRequested && isManagedModelProviderID(options.provider)) {
      this.store.managedModels.focusedProvider = options.provider;
      this.store.managedModels.focusRequestID += 1;
    }
    const wasOpen = this.store.open;
    this.store.open = true;

    if (!wasOpen) {
      this.reportSettingsOpened();
      void this.refreshDeveloperLogs();
      void this.refreshManagedModelProviders();
    } else if (this.store.activeSection === "apps") {
      void this.refreshManagedModelProviders();
    }
  }

  closePanel(): void {
    this.store.open = false;
  }

  checkComputerUseStatus() {
    return this.dependencies.client.checkComputerUseStatus();
  }

  installComputerUse() {
    return this.dependencies.client.installComputerUse();
  }

  uninstallComputerUse() {
    return this.dependencies.client.uninstallComputerUse();
  }

  grantComputerUsePermissions() {
    return this.dependencies.client.grantComputerUsePermissions();
  }

  startComputerUsePermissionGrant() {
    return this.dependencies.client.startComputerUsePermissionGrant();
  }

  getComputerUsePermissionGrantStatus() {
    return this.dependencies.client.getComputerUsePermissionGrantStatus();
  }

  logComputerUsePermissionDiagnostic(input: {
    details?: Record<string, unknown>;
    event: string;
    level?: "debug" | "error" | "info" | "warn";
  }): void {
    void this.dependencies.client
      .logComputerUsePermissionDiagnostic({
        details: input.details,
        event: input.event,
        level: input.level,
        workspaceId: this.store.workspaceID
      })
      .catch(() => undefined);
  }

  openComputerUsePermissionSettings(
    pane: DesktopComputerUsePermissionPane
  ): Promise<void> {
    return this.dependencies.client.openComputerUsePermissionSettings(pane);
  }

  restartComputerUseDriver(input?: DesktopComputerUseRestartDriverInput) {
    return this.dependencies.client.restartComputerUseDriver(input);
  }

  syncWorkspace(workspace: WorkspaceSettingsWorkspaceInput): void {
    if (workspace.id !== this.store.workspaceID) {
      this.store.workspaceID = workspace.id;
      this.store.activeSection = "general";
      this.store.generalFocusAnchor = null;
      this.store.generalFocusRequestID = 0;
      this.store.managedModels.providers = [];
      this.store.managedModels.draft = null;
      this.store.managedModels.feedback = {};
      this.store.managedModels.detectingProvider = null;
      this.store.managedModels.focusedProvider = null;
      this.store.managedModels.focusRequestID = 0;
    }
  }

  selectSection(sectionID: WorkspaceSettingsSectionID): void {
    if (this.store.activeSection === sectionID) {
      return;
    }

    this.store.activeSection = sectionID;
    this.reportSettingsSectionSwitched(sectionID);
    if (sectionID === "apps") {
      void this.refreshManagedModelProviders();
    }
  }

  setDeveloperPanelVisible(visible: boolean): void {
    if (this.store.developerPanelVisible === visible) {
      return;
    }

    this.store.developerPanelVisible = visible;
    writeDeveloperPanelVisible(visible);
    if (
      !visible &&
      (this.store.activeSection === "developer" ||
        this.store.activeSection === "lab")
    ) {
      this.store.activeSection = "general";
    }
  }

  async setTuttiAgentSwitchEnabled(enabled: boolean): Promise<void> {
    return this.enqueueTuttiAgentSwitchOperation(async () => {
      if (
        this.tuttiAgentSwitchInitialized &&
        this.store.tuttiAgentSwitchEnabled === enabled
      ) {
        return;
      }

      try {
        const target =
          await this.dependencies.client.setSystemAgentTargetEnabled(
            tuttiAgentTargetID,
            enabled
          );
        this.tuttiAgentSwitchInitialized = true;
        this.applyTuttiAgentTargetEnabled(target.enabled);
        await this.refreshAgentTargetConsumers();
      } catch {
        this.notifications.error({
          title: createActiveTranslator().t(
            "workspace.settings.developer.tuttiAgentSwitchSaveFailed"
          )
        });
      }
    });
  }

  private async initializeTuttiAgentSwitch(): Promise<void> {
    if (this.tuttiAgentSwitchInitialized) {
      return;
    }
    try {
      const targets = await this.dependencies.client.listAgentTargets();
      let target = targets.find((item) => item.id === tuttiAgentTargetID);
      if (!target) {
        return;
      }
      const migration =
        this.dependencies.tuttiAgentSwitchMigration ??
        defaultTuttiAgentSwitchMigration;
      if (!migration.hasMigrated()) {
        const legacyEnabled = migration.readLegacyEnabled();
        if (legacyEnabled.status === "error") {
          return;
        }
        // Persist the one-shot marker before mutating daemon state. If storage
        // is unavailable, leave migration pending instead of repeatedly
        // overwriting an explicit daemon-side choice on future launches.
        if (!migration.markComplete()) {
          return;
        }
        if (
          legacyEnabled.status === "value" &&
          legacyEnabled.enabled !== target.enabled
        ) {
          try {
            target = await this.dependencies.client.setSystemAgentTargetEnabled(
              tuttiAgentTargetID,
              legacyEnabled.enabled
            );
          } catch (error) {
            migration.clearComplete();
            throw error;
          }
          await this.refreshAgentTargetConsumers();
        }
      }
      this.tuttiAgentSwitchInitialized = true;
      this.applyTuttiAgentTargetEnabled(target.enabled);
    } catch {
      // Keep the safe hidden state until the daemon can provide authority.
    }
  }

  private scheduleTuttiAgentSwitchInitialization(): void {
    if (
      this.tuttiAgentSwitchInitialized ||
      this.tuttiAgentSwitchInitializationPending
    ) {
      return;
    }
    this.tuttiAgentSwitchInitializationPending = true;
    void this.enqueueTuttiAgentSwitchOperation(async () => {
      try {
        await this.initializeTuttiAgentSwitch();
      } finally {
        this.tuttiAgentSwitchInitializationPending = false;
      }
    });
  }

  private enqueueTuttiAgentSwitchOperation(
    operation: () => Promise<void>
  ): Promise<void> {
    const next = this.tuttiAgentSwitchOperation.then(operation, operation);
    this.tuttiAgentSwitchOperation = next.catch(() => undefined);
    return next;
  }

  private applyTuttiAgentTargetEnabled(enabled: boolean): void {
    this.store.tuttiAgentSwitchEnabled = enabled;
    if (!enabled && this.store.activeSection === "account") {
      this.store.activeSection = "general";
    }
  }

  private async refreshAgentTargetConsumers(): Promise<void> {
    try {
      await this.dependencies.onAgentTargetsChanged?.();
    } catch {
      // The daemon update is authoritative; consumers will retry on their next refresh.
    }
  }

  async changeLocale(nextLocale: DesktopLocale): Promise<void> {
    if (
      this.desktopPreferences.store.locale === nextLocale ||
      this.desktopPreferences.store.changingLocale === nextLocale
    ) {
      return;
    }

    const fromLanguage = this.desktopPreferences.store.locale;
    try {
      await this.desktopPreferences.setLocale(nextLocale);
      this.reportSettingsLanguageChanged({
        fromLanguage,
        toLanguage: nextLocale
      });
    } catch {
      this.notifications.error({
        title: createActiveTranslator().t(
          "workspace.settings.general.localeSaveFailed"
        )
      });
    }
  }

  async changeDefaultAgentProvider(
    provider: DesktopDefaultAgentProvider
  ): Promise<void> {
    if (
      this.desktopPreferences.store.defaultAgentProvider === provider ||
      this.desktopPreferences.store.changingDefaultAgentProvider === provider
    ) {
      return;
    }

    try {
      await this.desktopPreferences.setDefaultAgentProvider(provider);
    } catch {
      this.notifications.error({
        title: createActiveTranslator().t(
          "workspace.settings.general.defaultAgentProviderSaveFailed"
        )
      });
    }
  }

  async changeAgentConversationDetailMode(
    mode: DesktopAgentConversationDetailMode
  ): Promise<void> {
    if (
      this.desktopPreferences.store.agentConversationDetailMode === mode ||
      this.desktopPreferences.store.changingAgentConversationDetailMode === mode
    ) {
      return;
    }

    try {
      await this.desktopPreferences.setAgentConversationDetailMode(mode);
    } catch {
      this.notifications.error({
        title: createActiveTranslator().t(
          "workspace.settings.general.agentConversationDetailModeSaveFailed"
        )
      });
    }
  }

  async changeBrowserUseConnectionMode(
    mode: DesktopBrowserUseConnectionMode
  ): Promise<void> {
    if (
      this.desktopPreferences.store.browserUseConnectionMode === mode ||
      this.desktopPreferences.store.changingBrowserUseConnectionMode === mode
    ) {
      return;
    }

    try {
      await this.desktopPreferences.setBrowserUseConnectionMode(mode);
    } catch {
      this.notifications.error({
        title: createActiveTranslator().t(
          "workspace.settings.general.browserUseConnectionModeSaveFailed"
        )
      });
    }
  }

  async changeDockPlacement(placement: DesktopDockPlacement): Promise<void> {
    if (
      this.desktopPreferences.store.dockPlacement === placement ||
      this.desktopPreferences.store.changingDockPlacement === placement
    ) {
      return;
    }

    try {
      await this.desktopPreferences.setDockPlacement(placement);
    } catch {
      this.notifications.error({
        title: createActiveTranslator().t(
          "workspace.settings.appearance.dockPlacementSaveFailed"
        )
      });
    }
  }

  async changeDockIconStyle(style: DesktopDockIconStyle): Promise<void> {
    if (
      this.desktopPreferences.store.dockIconStyle === style ||
      this.desktopPreferences.store.changingDockIconStyle === style
    ) {
      return;
    }

    try {
      await this.desktopPreferences.setDockIconStyle(style);
    } catch {
      this.notifications.error({
        title: createActiveTranslator().t(
          "workspace.settings.appearance.dockIconStyleSaveFailed"
        )
      });
    }
  }

  async changeMinimizeAnimation(
    animation: DesktopMinimizeAnimation
  ): Promise<void> {
    if (
      this.desktopPreferences.store.minimizeAnimation === animation ||
      this.desktopPreferences.store.changingMinimizeAnimation === animation
    ) {
      return;
    }

    try {
      await this.desktopPreferences.setMinimizeAnimation(animation);
    } catch {
      this.notifications.error({
        title: createActiveTranslator().t(
          "workspace.settings.appearance.minimizeAnimationSaveFailed"
        )
      });
    }
  }

  async changeWorkbenchWindowSnapping(
    value: DesktopWorkbenchWindowSnapping
  ): Promise<void> {
    if (
      desktopWorkbenchWindowSnappingEqual(
        this.desktopPreferences.store.workbenchWindowSnapping,
        value
      ) ||
      (this.desktopPreferences.store.changingWorkbenchWindowSnapping !== null &&
        desktopWorkbenchWindowSnappingEqual(
          this.desktopPreferences.store.changingWorkbenchWindowSnapping,
          value
        ))
    ) {
      return;
    }

    try {
      await this.desktopPreferences.setWorkbenchWindowSnapping(value);
    } catch {
      this.notifications.error({
        title: createActiveTranslator().t(
          "workspace.settings.appearance.workbenchWindowSnappingSaveFailed"
        )
      });
    }
  }

  async changeFeatureFlags(flags: DesktopFeatureFlags): Promise<void> {
    await this.featureFlagSettings.change(flags);
  }

  async changeWorkspaceUiMode(mode: DesktopWorkspaceUiMode): Promise<void> {
    const currentFlags =
      this.desktopPreferences.store.changingFeatureFlags ??
      this.desktopPreferences.store.featureFlags;
    const nextFlags = withDesktopWorkspaceUiMode(currentFlags, mode);
    if (desktopFeatureFlagsEqual(currentFlags, nextFlags)) {
      return;
    }

    try {
      await this.desktopPreferences.setFeatureFlags(nextFlags);
      if (this.store.workspaceID) {
        await this.dependencies.replaceWorkspaceWindow?.({
          mode,
          workspaceId: this.store.workspaceID
        });
      }
    } catch {
      this.notifications.error({
        title: createActiveTranslator().t(
          "workspace.settings.general.workspaceUiModeSaveFailed"
        )
      });
    }
  }

  async changeWorkbenchShortcuts(
    shortcuts: DesktopWorkbenchShortcuts
  ): Promise<void> {
    if (
      desktopWorkbenchShortcutsEqual(
        this.desktopPreferences.store.workbenchShortcuts,
        shortcuts
      )
    ) {
      return;
    }

    try {
      await this.desktopPreferences.setWorkbenchShortcuts(shortcuts);
    } catch {
      this.notifications.error({
        title: createActiveTranslator().t(
          "workspace.settings.lab.preferencesSaveFailed"
        )
      });
    }
  }

  async changeThemeSource(nextThemeSource: DesktopThemeSource): Promise<void> {
    if (
      this.desktopPreferences.store.theme.source === nextThemeSource ||
      this.desktopPreferences.store.changingThemeSource === nextThemeSource
    ) {
      return;
    }

    const fromTheme = this.desktopPreferences.store.theme.source;
    try {
      await this.desktopPreferences.setThemeSource(nextThemeSource);
      this.reportSettingsThemeChanged({
        fromTheme,
        toTheme: nextThemeSource
      });
    } catch {
      this.notifications.error({
        title: createActiveTranslator().t(
          "workspace.settings.appearance.themeSaveFailed"
        )
      });
    }
  }

  async changeSleepPreventionMode(
    mode: DesktopSleepPreventionMode
  ): Promise<void> {
    if (
      this.desktopPreferences.store.sleepPreventionMode === mode ||
      this.desktopPreferences.store.changingSleepPreventionMode === mode
    ) {
      return;
    }

    try {
      await this.desktopPreferences.setSleepPreventionMode(mode);
    } catch {
      this.notifications.error({
        title: createActiveTranslator().t(
          "workspace.settings.general.preventSleepSaveFailed"
        )
      });
    }
  }

  async changeUpdatePolicy(policy: DesktopUpdatePolicy): Promise<void> {
    if (
      this.desktopPreferences.store.updatePolicy === policy ||
      this.desktopPreferences.store.changingUpdatePolicy === policy
    ) {
      return;
    }

    try {
      await this.desktopPreferences.setUpdatePolicy(policy);
    } catch {
      this.notifications.error({
        title: createActiveTranslator().t(
          "workspace.settings.general.updatePolicySaveFailed"
        )
      });
    }
  }

  async changeUpdateChannel(channel: DesktopUpdateChannel): Promise<void> {
    if (
      this.desktopPreferences.store.updateChannel === channel ||
      this.desktopPreferences.store.changingUpdateChannel === channel
    ) {
      return;
    }

    try {
      await this.desktopPreferences.setUpdateChannel(channel);
    } catch {
      this.notifications.error({
        title: createActiveTranslator().t(
          "workspace.settings.general.updateChannelSaveFailed"
        )
      });
    }
  }

  async changeAppCatalogChannel(
    channel: DesktopAppCatalogChannel
  ): Promise<void> {
    if (
      this.desktopPreferences.store.appCatalogChannel === channel ||
      this.desktopPreferences.store.changingAppCatalogChannel === channel
    ) {
      return;
    }

    try {
      await this.desktopPreferences.setAppCatalogChannel(channel);
    } catch {
      this.notifications.error({
        title: createActiveTranslator().t(
          "workspace.settings.apps.appCatalogChannelSaveFailed"
        )
      });
      return;
    }

    if (this.store.workspaceID && this.appCenterService) {
      await this.appCenterService
        .refreshCatalog(this.store.workspaceID)
        .catch(() => {});
    }
  }

  async changeShowAppDeveloperSources(show: boolean): Promise<void> {
    if (
      this.desktopPreferences.store.showAppDeveloperSources === show ||
      this.desktopPreferences.store.changingShowAppDeveloperSources === show
    ) {
      return;
    }

    try {
      await this.desktopPreferences.setShowAppDeveloperSources(show);
    } catch {
      this.notifications.error({
        title: createActiveTranslator().t(
          "workspace.settings.developer.showAppDeveloperSourcesSaveFailed"
        )
      });
    }
  }

  async clearDeveloperLogs(): Promise<void> {
    if (this.store.developerLogs.clearing) {
      return;
    }

    this.store.developerLogs.clearing = true;

    try {
      const result = await this.dependencies.client.clearLogs();
      const translator = createActiveTranslator();
      this.notifications.success({
        title: translator.t("workspace.settings.developer.logsCleared", {
          count: String(result.clearedFiles),
          size: formatWorkspaceSettingsBytes(result.clearedSizeBytes)
        })
      });
      await this.refreshDeveloperLogs();
    } catch {
      this.notifications.error({
        title: createActiveTranslator().t(
          "workspace.settings.developer.logsClearFailed"
        )
      });
    } finally {
      this.store.developerLogs.clearing = false;
    }
  }

  async clearConversationHistory(): Promise<void> {
    const workspaceID = this.store.workspaceID;
    if (!workspaceID || this.store.developerLogs.clearingConversationHistory) {
      return;
    }

    this.store.developerLogs.clearingConversationHistory = true;

    try {
      const result =
        await this.dependencies.client.clearWorkspaceAgentSessions(workspaceID);
      this.notifications.success({
        title: createActiveTranslator().t(
          "workspace.settings.developer.conversationHistoryCleared",
          {
            count: String(result.removedSessions)
          }
        )
      });
    } catch {
      this.notifications.error({
        title: createActiveTranslator().t(
          "workspace.settings.developer.conversationHistoryClearFailed"
        )
      });
    } finally {
      this.store.developerLogs.clearingConversationHistory = false;
    }
  }

  async exportDeveloperLogs(): Promise<void> {
    if (this.store.developerLogs.exporting) {
      return;
    }

    this.store.developerLogs.exporting = true;

    try {
      const result = await this.dependencies.client.exportLogs();
      if (!result.canceled) {
        this.notifications.success({
          title: createActiveTranslator().t(
            "workspace.settings.developer.logsExported",
            {
              count: String(result.fileCount),
              path: result.filePath ?? ""
            }
          )
        });
      }
    } catch {
      this.notifications.error({
        title: createActiveTranslator().t(
          "workspace.settings.developer.logsExportFailed"
        )
      });
    } finally {
      this.store.developerLogs.exporting = false;
    }
  }

  openLogDirectory(): Promise<void> {
    return this.dependencies.client.openLogDirectory();
  }

  openLogFile(kind: DesktopDeveloperLogKind): Promise<void> {
    return this.dependencies.client.openLogFile(kind);
  }

  async refreshDeveloperLogs(): Promise<void> {
    const sequence = this.startDeveloperLogsLoad();

    try {
      await this.loadDeveloperLogsState(sequence);
    } catch {
      if (!this.isCurrentDeveloperLogsLoad(sequence)) {
        return;
      }

      this.notifications.error({
        title: createActiveTranslator().t(
          "workspace.settings.developer.logsLoadFailed"
        )
      });
      this.store.developerLogs.loading = false;
    }
  }

  async refreshManagedModelProviders(): Promise<void> {
    const workspaceID = this.store.workspaceID;
    if (!workspaceID || this.store.managedModels.loading) {
      return;
    }

    this.store.managedModels.loading = true;
    try {
      const providers =
        await this.dependencies.client.listManagedModelProviders(workspaceID);
      this.store.managedModels.providers = providers.map(
        toManagedModelProviderDraft
      );
    } catch {
      this.notifications.error({
        title: createActiveTranslator().t(
          "workspace.settings.apps.managedModels.loadFailed"
        )
      });
    } finally {
      this.store.managedModels.loading = false;
    }
  }

  updateManagedModelProviderDraft(
    providerID: WorkspaceManagedModelProviderID,
    patch: Partial<WorkspaceManagedModelProviderDraft>
  ): void {
    this.store.managedModels.providers = this.store.managedModels.providers.map(
      (provider) =>
        provider.provider === providerID ? { ...provider, ...patch } : provider
    );
    this.clearManagedModelFeedback(providerID);
  }

  beginManagedModelProviderDraft(
    provider: WorkspaceManagedModelProviderID
  ): void {
    const alreadyConfigured = this.store.managedModels.providers.some(
      (candidate) => candidate.provider === provider
    );
    if (alreadyConfigured) {
      return;
    }
    this.clearManagedModelFeedback(provider);
    this.store.managedModels.draft = createManagedModelProviderDraft(provider);
  }

  updateManagedModelDraft(
    patch: Partial<WorkspaceManagedModelProviderDraft>
  ): void {
    const draft = this.store.managedModels.draft;
    if (!draft) {
      return;
    }
    this.store.managedModels.draft = { ...draft, ...patch };
    this.clearManagedModelFeedback(draft.provider);
  }

  cancelManagedModelProviderDraft(): void {
    this.store.managedModels.draft = null;
  }

  async saveManagedModelDraft(): Promise<void> {
    const workspaceID = this.store.workspaceID;
    const draft = this.store.managedModels.draft;
    if (!workspaceID || !draft || this.store.managedModels.savingProvider) {
      return;
    }
    if (!hasRequiredManagedModelProviderFields(draft)) {
      this.setManagedModelFeedback(draft.provider, "requiredFields");
      return;
    }
    this.store.managedModels.savingProvider = draft.provider;
    try {
      const saved = await this.dependencies.client.putManagedModelProvider(
        workspaceID,
        draft.provider,
        {
          ...(draft.apiKey.trim() ? { apiKey: draft.apiKey } : {}),
          baseUrl: draft.baseUrl,
          enabled: draft.enabled,
          models: normalizeManagedModels(draft.provider, draft.models)
        }
      );
      this.replaceManagedModelProviderDraft(saved);
      this.store.managedModels.draft = null;
      this.clearManagedModelFeedback(draft.provider);
    } catch {
      this.setManagedModelFeedback(draft.provider, "saveFailed");
    } finally {
      this.store.managedModels.savingProvider = null;
    }
  }

  async setManagedModelProviderEnabled(
    providerID: WorkspaceManagedModelProviderID,
    enabled: boolean
  ): Promise<void> {
    const workspaceID = this.store.workspaceID;
    const target = this.store.managedModels.providers.find(
      (provider) => provider.provider === providerID
    );
    if (!workspaceID || !target || this.store.managedModels.savingProvider) {
      return;
    }
    const previousEnabled = target.enabled;
    const baseUrl = target.baseUrl;
    const apiKey = target.apiKey;
    const models = normalizeManagedModels(providerID, target.models);
    this.store.managedModels.savingProvider = providerID;
    this.updateManagedModelProviderDraft(providerID, { enabled });
    try {
      const saved = await this.dependencies.client.putManagedModelProvider(
        workspaceID,
        providerID,
        {
          ...(apiKey.trim() ? { apiKey } : {}),
          baseUrl,
          enabled,
          models
        }
      );
      this.replaceManagedModelProviderDraft(saved);
    } catch {
      this.updateManagedModelProviderDraft(providerID, {
        enabled: previousEnabled
      });
      this.notifications.error({
        title: createActiveTranslator().t(
          "workspace.settings.apps.managedModels.saveFailed"
        )
      });
    } finally {
      this.store.managedModels.savingProvider = null;
    }
  }

  async saveManagedModelProvider(
    provider: WorkspaceManagedModelProviderDraft
  ): Promise<void> {
    const workspaceID = this.store.workspaceID;
    if (!workspaceID || this.store.managedModels.savingProvider) {
      return;
    }
    if (!hasRequiredManagedModelProviderFields(provider)) {
      this.setManagedModelFeedback(provider.provider, "requiredFields");
      return;
    }
    this.store.managedModels.savingProvider = provider.provider;
    try {
      const saved = await this.dependencies.client.putManagedModelProvider(
        workspaceID,
        provider.provider,
        {
          ...(provider.apiKey.trim() ? { apiKey: provider.apiKey } : {}),
          baseUrl: provider.baseUrl,
          enabled: provider.enabled,
          models: normalizeManagedModels(provider.provider, provider.models)
        }
      );
      this.replaceManagedModelProviderDraft(saved);
      this.clearManagedModelFeedback(provider.provider);
    } catch {
      this.setManagedModelFeedback(provider.provider, "saveFailed");
    } finally {
      this.store.managedModels.savingProvider = null;
    }
  }

  async removeManagedModelProvider(
    providerID: WorkspaceManagedModelProviderID
  ): Promise<void> {
    const workspaceID = this.store.workspaceID;
    if (!workspaceID || this.store.managedModels.deletingProvider) {
      return;
    }
    this.store.managedModels.deletingProvider = providerID;
    try {
      await this.dependencies.client.deleteManagedModelProvider(
        workspaceID,
        providerID
      );
      this.store.managedModels.providers =
        this.store.managedModels.providers.filter(
          (provider) => provider.provider !== providerID
        );
      this.clearManagedModelFeedback(providerID);
    } catch {
      this.setManagedModelFeedback(providerID, "deleteFailed");
    } finally {
      this.store.managedModels.deletingProvider = null;
    }
  }

  async testManagedModelProvider(
    providerID: WorkspaceManagedModelProviderID
  ): Promise<void> {
    const workspaceID = this.store.workspaceID;
    if (!workspaceID || this.store.managedModels.testingProvider) {
      return;
    }
    this.clearManagedModelFeedback(providerID);
    this.store.managedModels.testingProvider = providerID;
    try {
      await this.dependencies.client.testManagedModelProvider(
        workspaceID,
        providerID
      );
      this.setManagedModelFeedback(providerID, "testOk");
    } catch {
      this.setManagedModelFeedback(providerID, "testFailed");
    } finally {
      this.store.managedModels.testingProvider = null;
    }
  }

  async detectManagedModelProviderModels(
    providerID: WorkspaceManagedModelProviderID
  ): Promise<void> {
    const workspaceID = this.store.workspaceID;
    if (!workspaceID || this.store.managedModels.detectingProvider) {
      return;
    }
    const provider = this.store.managedModels.providers.find(
      (item) => item.provider === providerID
    );
    if (!provider) {
      return;
    }
    this.clearManagedModelFeedback(providerID);
    if (!hasRequiredManagedModelProviderFields(provider)) {
      this.setManagedModelFeedback(providerID, "requiredFields");
      return;
    }
    this.store.managedModels.detectingProvider = providerID;
    try {
      const models =
        await this.dependencies.client.listManagedModelProviderModels(
          workspaceID,
          providerID,
          {
            ...(provider.apiKey.trim() ? { apiKey: provider.apiKey } : {}),
            baseUrl: provider.baseUrl
          }
        );
      this.updateManagedModelProviderDraft(providerID, {
        models: normalizeManagedModels(providerID, models)
      });
      if (models.length === 0) {
        this.setManagedModelFeedback(providerID, "detectEmpty");
      }
    } catch {
      this.setManagedModelFeedback(providerID, "detectFailed");
    } finally {
      this.store.managedModels.detectingProvider = null;
    }
  }

  private replaceManagedModelProviderDraft(
    config: WorkspaceManagedModelProviderConfig
  ): void {
    const draft = toManagedModelProviderDraft(config);
    const exists = this.store.managedModels.providers.some(
      (provider) => provider.provider === draft.provider
    );
    this.store.managedModels.providers = exists
      ? this.store.managedModels.providers.map((provider) =>
          provider.provider === draft.provider ? draft : provider
        )
      : [...this.store.managedModels.providers, draft];
  }

  private setManagedModelFeedback(
    providerID: WorkspaceManagedModelProviderID,
    kind: WorkspaceManagedModelProviderFeedbackKind
  ): void {
    this.store.managedModels.feedback = {
      ...this.store.managedModels.feedback,
      [providerID]: { kind }
    };
  }

  private clearManagedModelFeedback(
    providerID: WorkspaceManagedModelProviderID
  ): void {
    if (!this.store.managedModels.feedback[providerID]) {
      return;
    }
    const next = { ...this.store.managedModels.feedback };
    delete next[providerID];
    this.store.managedModels.feedback = next;
  }

  private startDeveloperLogsLoad(): number {
    this.logsLoadSequence += 1;
    this.store.developerLogs.loading = true;
    return this.logsLoadSequence;
  }

  private isCurrentDeveloperLogsLoad(sequence: number): boolean {
    return sequence === this.logsLoadSequence;
  }

  private async loadDeveloperLogsState(sequence: number): Promise<void> {
    const logs = await this.dependencies.client.getLogsState();
    if (!this.isCurrentDeveloperLogsLoad(sequence)) {
      return;
    }

    this.store.developerLogs.logs = logs;
    this.store.developerLogs.loading = false;
  }

  private reportSettingsOpened(): void {
    if (!this.reporterService) {
      return;
    }

    void new SettingsOpenedReporter(
      {},
      {
        reporterService: this.reporterService,
        now: this.reporterNow
      }
    ).report();
  }

  private reportSettingsSectionSwitched(
    section: WorkspaceSettingsSectionID
  ): void {
    if (!this.reporterService) {
      return;
    }

    void new SettingsSectionSwitchedReporter(
      {
        section
      },
      {
        reporterService: this.reporterService,
        now: this.reporterNow
      }
    ).report();
  }

  private reportSettingsLanguageChanged(input: {
    fromLanguage: DesktopLocale;
    toLanguage: DesktopLocale;
  }): void {
    if (!this.reporterService) {
      return;
    }

    void new SettingsLanguageChangedReporter(input, {
      reporterService: this.reporterService,
      now: this.reporterNow
    }).report();
  }

  private reportSettingsThemeChanged(input: {
    fromTheme: DesktopThemeSource;
    toTheme: DesktopThemeSource;
  }): void {
    if (!this.reporterService) {
      return;
    }

    void new SettingsThemeChangedReporter(input, {
      reporterService: this.reporterService,
      now: this.reporterNow
    }).report();
  }
}

const defaultTuttiAgentSwitchMigration = {
  clearComplete: clearTuttiAgentSwitchDaemonMigration,
  hasMigrated: hasMigratedTuttiAgentSwitchToDaemon,
  markComplete: markTuttiAgentSwitchDaemonMigrationComplete,
  readLegacyEnabled: readLegacyTuttiAgentSwitchEnabled
};

function createActiveTranslator() {
  return createTranslator(getActiveLocale());
}

function createManagedModelProviderDraft(
  provider: WorkspaceManagedModelProviderID
): WorkspaceManagedModelProviderDraft {
  return toManagedModelProviderDraft({
    ...createDefaultManagedModelProviderConfig(provider),
    enabled: true
  });
}

function isManagedModelProviderID(
  value: string | undefined
): value is WorkspaceManagedModelProviderID {
  return managedModelProviderIDs.includes(
    value as WorkspaceManagedModelProviderID
  );
}

function createDefaultManagedModelProviderConfig(
  provider: WorkspaceManagedModelProviderID
): WorkspaceManagedModelProviderConfig {
  const officialDefaults: Record<
    WorkspaceManagedModelProviderID,
    { baseUrl: string; models: readonly string[] }
  > = {
    agnes: {
      baseUrl: "https://apihub.agnes-ai.com/v1",
      models: ["agnes-2.0-flash", "agnes-1.5-flash"]
    },
    anthropic: {
      baseUrl: "https://api.anthropic.com/v1",
      models: ["claude-sonnet-4-6", "claude-opus-4-8", "claude-haiku-4-5"]
    },
    openai: {
      baseUrl: "https://api.openai.com/v1",
      models: ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano"]
    }
  };
  const defaults = officialDefaults[provider];

  return {
    baseUrl: defaults.baseUrl,
    enabled: false,
    hasApiKey: false,
    models: defaults.models.map((id) => ({
      id,
      name: id,
      provider
    })),
    provider
  };
}

function toManagedModelProviderDraft(
  provider: WorkspaceManagedModelProviderConfig
): WorkspaceManagedModelProviderDraft {
  const providerModels = (
    provider as Omit<WorkspaceManagedModelProviderConfig, "models"> & {
      models: readonly WorkspaceManagedModel[] | null;
    }
  ).models;
  const models = providerModels ?? [];
  return {
    ...provider,
    apiKey: provider.apiKey ?? "",
    baseUrl: provider.baseUrl ?? "",
    models: normalizeManagedModels(provider.provider, models)
  };
}

function hasRequiredManagedModelProviderFields(
  provider: WorkspaceManagedModelProviderDraft
): boolean {
  return (
    (provider.hasApiKey || provider.apiKey.trim().length > 0) &&
    (provider.baseUrl?.trim().length ?? 0) > 0
  );
}

function normalizeManagedModels(
  provider: WorkspaceManagedModelProviderID,
  models: readonly WorkspaceManagedModel[]
) {
  const seen = new Set<string>();
  return models
    .map((model) => ({
      id: model.id.trim(),
      name: model.name.trim() || model.id.trim(),
      provider
    }))
    .filter((model) => {
      const id = model.id;
      if (!id || seen.has(id)) {
        return false;
      }
      seen.add(id);
      return true;
    });
}

// Avoid decorator syntax so the renderer Babel pass can parse this file.
IDesktopPreferencesService(WorkspaceSettingsService, undefined, 1);
INotificationService(WorkspaceSettingsService, undefined, 2);
IReporterService(WorkspaceSettingsService, undefined, 3);
IWorkspaceAppCenterService(WorkspaceSettingsService, undefined, 4);

const noopDesktopPreferencesStore: DesktopPreferencesReadableStoreState = {
  agentComposerDefaultsByProvider: {},
  agentComposerDefaultsByAgentTarget: {},
  agentGuiConversationRailCollapsedByProvider: {},
  agentConversationDetailMode: "coding",
  appCatalogChannel: "production",
  browserUseConnectionMode: "isolated",
  changingAgentConversationDetailMode: null,
  changingAppCatalogChannel: null,
  changingBrowserUseConnectionMode: null,
  changingDefaultAgentProvider: null,
  changingDockIconStyle: null,
  changingDockPlacement: null,
  changingFeatureFlags: null,
  changingLocale: null,
  changingMinimizeAnimation: null,
  changingSleepPreventionMode: null,
  changingShowAppDeveloperSources: null,
  changingThemeSource: null,
  changingUpdateChannel: null,
  changingUpdatePolicy: null,
  changingWorkbenchWindowSnapping: null,
  defaultAgentProvider: "codex",
  dockIconStyle: "default",
  dockPlacement: "bottom",
  featureFlags: defaultDesktopFeatureFlags,
  fileDefaultOpenersByExtension: {},
  locale: "en",
  minimizeAnimation: defaultDesktopMinimizeAnimation,
  sleepPreventionMode: "never",
  showAppDeveloperSources: false,
  theme: createNoopTheme("dark"),
  updateChannel: "rc",
  updatePolicy: "prompt",
  workbenchShortcuts: defaultDesktopWorkbenchShortcuts,
  workbenchWindowSnapping: {
    enabled: false,
    shortcutPreset: "commandArrows"
  }
};

const noopDesktopPreferences: DesktopPreferencesService = {
  _serviceBrand: undefined,
  store: noopDesktopPreferencesStore,
  setAppCatalogChannel(channel) {
    return Promise.resolve(channel);
  },
  setBrowserUseConnectionMode(mode) {
    return Promise.resolve(mode);
  },
  setDefaultAgentProvider(provider) {
    return Promise.resolve(provider);
  },
  setAgentConversationDetailMode(mode) {
    return Promise.resolve(mode);
  },
  setDockPlacement(placement) {
    return Promise.resolve(placement);
  },
  setDockIconStyle(style) {
    return Promise.resolve(style);
  },
  setFileDefaultOpenersByExtension(openersByExtension) {
    return Promise.resolve(openersByExtension);
  },
  setLocale(locale) {
    return Promise.resolve(locale);
  },
  setFeatureFlags(flags) {
    return Promise.resolve(flags);
  },
  setMinimizeAnimation(animation) {
    return Promise.resolve(animation);
  },
  setWorkbenchShortcuts(shortcuts) {
    return Promise.resolve(shortcuts);
  },
  setWorkbenchWindowSnapping(value) {
    return Promise.resolve(value);
  },
  setSleepPreventionMode(mode) {
    return Promise.resolve(mode);
  },
  setShowAppDeveloperSources(show) {
    return Promise.resolve(show);
  },
  setThemeSource(source) {
    return Promise.resolve(createNoopTheme(source));
  },
  setUpdateChannel(channel) {
    return Promise.resolve(channel);
  },
  setUpdatePolicy(policy) {
    return Promise.resolve(policy);
  },
  rememberAgentComposerDefaultsForAgentTarget() {
    return Promise.resolve({
      acknowledgedFields: [],
      supersededFields: []
    });
  },
  rememberAgentGuiConversationRailCollapsed() {
    return Promise.resolve();
  }
};

function createNoopTheme(source: DesktopThemeSource): DesktopThemeState {
  return {
    appearance: source === "dark" ? "dark" : "light",
    source
  };
}

const noopNotifications: NotificationService = {
  _serviceBrand: undefined,
  error() {},
  info() {},
  notify() {},
  success() {},
  warning() {}
};
