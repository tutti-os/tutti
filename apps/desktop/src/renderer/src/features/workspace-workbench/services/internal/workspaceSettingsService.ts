import type {
  DesktopComputerUsePermissionPane,
  DesktopComputerUseRestartDriverInput,
  DesktopDeveloperLogKind,
  ExportDeveloperLogsInput
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
import type { WorkspaceSettingsAgentTab } from "../workspaceSettingsTypes";
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
import {
  createWorkspaceFeatureFlagSettings,
  type WorkspaceFeatureFlagSettings
} from "./workspaceFeatureFlagSettings.ts";
import {
  WorkspaceModelPlansController,
  type WorkspaceModelPlansControllerDependencies
} from "./workspaceModelPlansController.ts";
import { WorkspaceAgentsController } from "./workspaceAgentsController.ts";
import { WorkspaceAutomationRulesController } from "./workspaceAutomationRulesController.ts";

export interface WorkspaceSettingsServiceDependencies {
  client: DesktopWorkspaceSettingsClient;
  launchAgentGui?: WorkspaceModelPlansControllerDependencies["launchAgentGui"];
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
  readonly agents: WorkspaceAgentsController;
  readonly automationRules: WorkspaceAutomationRulesController;
  readonly modelPlans: WorkspaceModelPlansController;

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
    this.modelPlans = new WorkspaceModelPlansController({
      client: dependencies.client,
      launchAgentGui: dependencies.launchAgentGui,
      notifications,
      store: this.store
    });
    this.agents = new WorkspaceAgentsController({
      client: dependencies.client,
      onWorkspaceAgentsChanged: dependencies.onAgentTargetsChanged,
      store: this.store
    });
    this.automationRules = new WorkspaceAutomationRulesController({
      client: dependencies.client,
      store: this.store
    });
    this.scheduleTuttiAgentSwitchInitialization();
  }

  openPanel(
    workspace: WorkspaceSettingsWorkspaceInput,
    options?: WorkspaceSettingsOpenOptions
  ): void {
    this.scheduleTuttiAgentSwitchInitialization();
    this.syncWorkspace(workspace);
    // Normalize every legacy/plain-string settings request at this single
    // host-owned seam. Callers publish intent; only Settings understands its
    // current information architecture.
    const requestedSection = options?.section as string | undefined;
    if (options?.pane === "managed-models" || requestedSection === "apps") {
      this.store.activeSection = "model";
    } else if (options?.section) {
      this.store.activeSection = options.section;
    }
    if (options?.anchor) {
      this.store.activeSection = "agent";
      this.store.generalFocusAnchor = options.anchor;
      this.store.generalFocusRequestID += 1;
    }
    // Deep-link into the Agents tab of the agent section, optionally focusing a
    // provider row. A hidden preview provider is still routed here (the Agents
    // tab surfaces an "enable Preview Agents" hint) rather than silently failing.
    if (options?.pane === "agents") {
      this.store.activeSection = "agent";
      this.store.agentTab = "agents";
      this.store.agentFocusProvider =
        typeof options.provider === "string" && options.provider.trim() !== ""
          ? options.provider
          : null;
      this.store.agentFocusRequestID += 1;
    } else if (
      options?.pane === "custom-agents" ||
      options?.pane === "workspace-agents"
    ) {
      this.store.activeSection = "agent";
      this.store.agentTab = "customAgents";
    } else if (options?.pane === "automation-rules") {
      this.store.activeSection = "agent";
      this.store.agentTab = "automation";
    }
    const wasOpen = this.store.open;
    this.store.open = true;

    if (!wasOpen) {
      this.reportSettingsOpened();
      void this.refreshDeveloperLogs();
    }
    this.refreshActiveSettingsSurface();
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
      this.store.agentTab = "general";
      this.store.agentFocusProvider = null;
      this.store.agentFocusRequestID = 0;
      this.store.generalFocusAnchor = null;
      this.store.generalFocusRequestID = 0;
      this.modelPlans.reset();
      this.agents.reset();
      this.automationRules.reset();
    }
  }

  selectSection(sectionID: WorkspaceSettingsSectionID): void {
    if (this.store.activeSection === sectionID) {
      return;
    }

    this.store.activeSection = sectionID;
    this.reportSettingsSectionSwitched(sectionID);
    if (sectionID === "model") {
      this.refreshModelPlansSurface();
    }
    if (sectionID === "agent") {
      this.refreshActiveAgentTab();
    }
  }

  selectAgentTab(tab: WorkspaceSettingsAgentTab): void {
    if (this.store.agentTab === tab) {
      return;
    }
    this.store.agentTab = tab;
    this.refreshActiveAgentTab();
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

  async setAgentTargetEnabled(
    agentTargetID: string,
    enabled: boolean
  ): Promise<void> {
    const normalizedAgentTargetID = agentTargetID.trim();
    if (!normalizedAgentTargetID) {
      throw new Error("Agent target ID is required");
    }

    const target = await this.dependencies.client.setSystemAgentTargetEnabled(
      normalizedAgentTargetID,
      enabled
    );
    if (target.id === tuttiAgentTargetID) {
      this.tuttiAgentSwitchInitialized = true;
      this.applyTuttiAgentTargetEnabled(target.enabled);
    }
    await this.refreshAgentTargetConsumers();
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
        await this.setAgentTargetEnabled(tuttiAgentTargetID, enabled);
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

  async changeDeletedAgentConversationRetentionDays(
    days: DeletedAgentConversationRetentionDays
  ): Promise<void> {
    try {
      await this.desktopPreferences.setDeletedAgentConversationRetentionDays(
        days
      );
    } catch {
      this.notifications.error({
        title: createActiveTranslator().t(
          "workspace.settings.general.deletedConversationRetentionSaveFailed"
        )
      });
    }
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

  async purgeDeletedConversations(): Promise<void> {
    if (this.store.purgingDeletedConversations) {
      return;
    }
    this.store.purgingDeletedConversations = true;
    try {
      const result =
        await this.dependencies.client.purgeDeletedAgentConversations();
      this.notifications.success({
        title: createActiveTranslator().t(
          "workspace.settings.general.deletedConversationPurgeCompleted",
          { count: String(result.removedSessions) }
        )
      });
    } catch {
      this.notifications.error({
        title: createActiveTranslator().t(
          "workspace.settings.general.deletedConversationPurgeFailed"
        )
      });
    } finally {
      this.store.purgingDeletedConversations = false;
    }
  }

  async exportDeveloperLogs(input: ExportDeveloperLogsInput): Promise<void> {
    if (this.store.developerLogs.exporting) {
      return;
    }

    this.store.developerLogs.exporting = true;

    try {
      const result = await this.dependencies.client.exportLogs(input);
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

  private refreshActiveSettingsSurface(): void {
    if (this.store.activeSection === "model") {
      this.refreshModelPlansSurface();
      return;
    }
    if (this.store.activeSection === "agent") {
      this.refreshActiveAgentTab();
    }
  }

  private refreshActiveAgentTab(): void {
    if (this.store.agentTab === "customAgents") {
      void this.agents.refresh();
    } else if (this.store.agentTab === "automation") {
      void this.automationRules.refresh();
    }
  }

  // Model settings need Plans plus the Runtime catalog used by the explicit
  // first-use launch. No legacy binding read or write participates here.
  private refreshModelPlansSurface(): void {
    void this.modelPlans.refresh();
    void this.agents.refresh();
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

// Avoid decorator syntax so the renderer Babel pass can parse this file.
IDesktopPreferencesService(WorkspaceSettingsService, undefined, 1);
INotificationService(WorkspaceSettingsService, undefined, 2);
IReporterService(WorkspaceSettingsService, undefined, 3);
IWorkspaceAppCenterService(WorkspaceSettingsService, undefined, 4);

const noopDesktopPreferencesStore: DesktopPreferencesReadableStoreState = {
  agentCliUpdateCheckEnabled: true,
  agentComposerDefaultsByProvider: {},
  agentComposerDefaultsByAgentTarget: {},
  agentGuiConversationRailCollapsedByProvider: {},
  agentConversationDetailMode: "coding",
  appCatalogChannel: "production",
  browserUseConnectionMode: "isolated",
  changingAgentConversationDetailMode: null,
  changingAgentCliUpdateCheckEnabled: null,
  changingAppCatalogChannel: null,
  changingBrowserUseConnectionMode: null,
  changingDefaultAgentProvider: null,
  changingDockIconStyle: null,
  changingDockPlacement: null,
  changingDeletedAgentConversationRetentionDays: null,
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
  deletedAgentConversationRetentionDays: 30,
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
  setAgentCliUpdateCheckEnabled(enabled) {
    return Promise.resolve(enabled);
  },
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
  setDeletedAgentConversationRetentionDays(days) {
    return Promise.resolve(days);
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
