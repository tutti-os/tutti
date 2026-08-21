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
  desktopWorkbenchShortcutsEqual,
  desktopWorkbenchWindowSnappingEqual
} from "../../../../../../shared/preferences/index.ts";
import {
  isFeatureEnabled,
  LAB_CONNECTORS_FLAG,
  resolveDesktopWorkspaceUiMode,
  withDesktopWorkspaceUiMode
} from "../../../../../../shared/featureFlags/catalog.ts";
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
  createWorkspaceFeatureFlagSettings,
  type WorkspaceFeatureFlagSettings
} from "./workspaceFeatureFlagSettings.ts";
import { WorkspaceModelPlansController } from "./workspaceModelPlansController.ts";
import { WorkspaceAgentsController } from "./workspaceAgentsController.ts";
import { WorkspaceAutomationRulesController } from "./workspaceAutomationRulesController.ts";
import { WorkspaceDeletedConversationsController } from "./workspaceDeletedConversationsController.ts";

export interface WorkspaceUiModeChangeErrorInput {
  error: unknown;
  mode: "agent" | "os";
  previousMode: "agent" | "os";
  workspaceId: string | null;
}

export interface WorkspaceSettingsServiceDependencies {
  client: DesktopWorkspaceSettingsClient;
  onAgentTargetsChanged?: () => void | Promise<void>;
  onWorkspaceUiModeChangeError?: (
    input: WorkspaceUiModeChangeErrorInput
  ) => void;
  replaceWorkspaceWindow?: (input: {
    clientTs: number;
    mode: "agent" | "os";
    previousMode: "agent" | "os";
    workspaceId: string;
  }) => Promise<void>;
}

export class WorkspaceSettingsService implements IWorkspaceSettingsService {
  readonly _serviceBrand: undefined;
  readonly store = createWorkspaceSettingsStore();
  readonly agents: WorkspaceAgentsController;
  readonly automationRules: WorkspaceAutomationRulesController;
  readonly deletedConversations: WorkspaceDeletedConversationsController;
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
    this.deletedConversations = new WorkspaceDeletedConversationsController({
      client: dependencies.client,
      notifications,
      store: this.store
    });
  }

  openPanel(
    workspace: WorkspaceSettingsWorkspaceInput,
    options?: WorkspaceSettingsOpenOptions
  ): void {
    this.syncWorkspace(workspace);
    // Normalize every legacy/plain-string settings request at this single
    // host-owned seam. Callers publish intent; only Settings understands its
    // current information architecture.
    const requestedSection = options?.section as string | undefined;
    if (options?.pane === "managed-models" || requestedSection === "apps") {
      this.store.activeSection = "model";
    } else if (options?.section) {
      this.store.activeSection =
        options.section === "account" ? "connection" : options.section;
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
    } else if (options?.pane === "connectors") {
      this.store.activeSection = "agent";
      const flags =
        this.desktopPreferences.store.changingFeatureFlags ??
        this.desktopPreferences.store.featureFlags;
      this.store.agentTab = isFeatureEnabled(flags, LAB_CONNECTORS_FLAG)
        ? "connectors"
        : "general";
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
      this.deletedConversations.reset();
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
    if (sectionID === "deletedConversations") {
      void this.deletedConversations.refresh();
    }
  }

  selectAgentTab(tab: WorkspaceSettingsAgentTab): void {
    if (this.store.agentTab === tab) {
      return;
    }
    this.store.agentTab = tab;
    this.refreshActiveAgentTab();
  }

  async openAgentDraftForModelPlan(planID: string): Promise<void> {
    this.modelPlans.dismissCreatedPlanHandoff();
    const sectionChanged = this.store.activeSection !== "agent";
    this.store.activeSection = "agent";
    this.store.agentTab = "customAgents";
    if (sectionChanged) {
      this.reportSettingsSectionSwitched("agent");
    }
    // The runtime catalog feeds the compatibility prefill, so the draft only
    // opens once the refresh settles. When a load is already in flight the
    // call is a no-op and the draft falls back to manual runtime selection.
    await this.agents.refresh();
    this.agents.beginDraftForModelPlan(planID);
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

    await this.dependencies.client.setSystemAgentTargetEnabled(
      normalizedAgentTargetID,
      enabled
    );
    await this.refreshAgentTargetConsumers();
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
    const previousMode = resolveDesktopWorkspaceUiMode(currentFlags);
    if (previousMode === mode) {
      return;
    }
    const nextFlags = withDesktopWorkspaceUiMode(currentFlags, mode);

    try {
      await this.desktopPreferences.setFeatureFlags(nextFlags);
      if (this.store.workspaceID) {
        await this.dependencies.replaceWorkspaceWindow?.({
          clientTs: (this.reporterNow ?? Date.now)(),
          mode,
          previousMode,
          workspaceId: this.store.workspaceID
        });
      }
    } catch (error) {
      this.dependencies.onWorkspaceUiModeChangeError?.({
        error,
        mode,
        previousMode,
        workspaceId: this.store.workspaceID
      });
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

  async exportDeveloperLogs(input: ExportDeveloperLogsInput): Promise<void> {
    if (this.store.developerLogs.exporting) {
      return;
    }

    this.store.developerLogs.exporting = true;
    this.notifications.info({
      title: createActiveTranslator().t(
        "workspace.settings.developer.exportingLogs"
      )
    });

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
      return;
    }
    if (this.store.activeSection === "deletedConversations") {
      void this.deletedConversations.refresh();
    }
  }

  private refreshActiveAgentTab(): void {
    if (this.store.agentTab === "customAgents") {
      void this.agents.refresh();
    } else if (this.store.agentTab === "automation") {
      void this.automationRules.refresh();
    }
  }

  private refreshModelPlansSurface(): void {
    void this.modelPlans.refresh();
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
  agentSessionLaunchModesByWorkspace: {},
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
  },
  rememberAgentSessionLaunchMode() {
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
