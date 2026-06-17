import type { DesktopDeveloperLogKind } from "@shared/contracts/ipc";
import type { DesktopLocale } from "@shared/i18n";
import type {
  DesktopAgentProvider,
  DesktopBrowserUseConnectionMode,
  DesktopDockIconStyle,
  DesktopDockPlacement,
  DesktopSleepPreventionMode,
  DesktopUpdateChannel,
  DesktopUpdatePolicy
} from "@shared/preferences";
import type { DesktopThemeSource, DesktopThemeState } from "@shared/theme";
import {
  INotificationService,
  type NotificationService
} from "@tutti-os/ui-notifications";
import {
  IDesktopPreferencesService,
  type IDesktopPreferencesService as DesktopPreferencesService
} from "../../../desktop-preferences/services/desktopPreferencesService.interface.ts";
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
import type {
  WorkspaceManagedModel,
  WorkspaceManagedModelProviderConfig,
  WorkspaceManagedModelProviderDraft,
  WorkspaceManagedModelProviderFeedbackKind,
  WorkspaceManagedModelProviderID
} from "../workspaceSettingsTypes.ts";

const managedModelProviderIDs: WorkspaceManagedModelProviderID[] = [
  "agnes",
  "openai",
  "anthropic"
];

export interface WorkspaceSettingsServiceDependencies {
  client: DesktopWorkspaceSettingsClient;
}

export class WorkspaceSettingsService implements IWorkspaceSettingsService {
  readonly _serviceBrand: undefined;
  readonly store = createWorkspaceSettingsStore();

  private readonly dependencies: WorkspaceSettingsServiceDependencies;
  private readonly desktopPreferences: DesktopPreferencesService;
  private readonly notifications: NotificationService;
  private readonly reporterService: Pick<ReporterService, "trackEvents"> | null;
  private readonly reporterNow?: () => number;
  private logsLoadSequence = 0;

  constructor(
    dependencies: WorkspaceSettingsServiceDependencies,
    desktopPreferences: DesktopPreferencesService = noopDesktopPreferences,
    notifications: NotificationService = noopNotifications,
    reporterService: Pick<ReporterService, "trackEvents"> | null = null,
    reporterNow?: () => number
  ) {
    this.dependencies = dependencies;
    this.desktopPreferences = desktopPreferences;
    this.notifications = notifications;
    this.reporterService = reporterService;
    this.reporterNow = reporterNow;
  }

  openPanel(
    workspace: WorkspaceSettingsWorkspaceInput,
    options?: WorkspaceSettingsOpenOptions
  ): void {
    this.syncWorkspace(workspace);
    const managedModelsRequested = options?.pane === "managed-models";
    if (managedModelsRequested) {
      this.store.activeSection = "apps";
    } else if (options?.section) {
      this.store.activeSection = options.section;
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

  syncWorkspace(workspace: WorkspaceSettingsWorkspaceInput): void {
    if (workspace.id !== this.store.workspaceID) {
      this.store.workspaceID = workspace.id;
      this.store.activeSection = "general";
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
    if (!visible && this.store.activeSection === "developer") {
      this.store.activeSection = "general";
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
    provider: DesktopAgentProvider
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

const noopDesktopPreferencesStore: DesktopPreferencesReadableStoreState = {
  agentComposerDefaultsByProvider: {},
  browserUseConnectionMode: "isolated",
  changingBrowserUseConnectionMode: null,
  changingDefaultAgentProvider: null,
  changingDockIconStyle: null,
  changingDockPlacement: null,
  changingLocale: null,
  changingSleepPreventionMode: null,
  changingThemeSource: null,
  changingUpdateChannel: null,
  changingUpdatePolicy: null,
  defaultAgentProvider: "codex",
  dockIconStyle: "default",
  dockPlacement: "bottom",
  locale: "en",
  sleepPreventionMode: "never",
  theme: createNoopTheme("dark"),
  updateChannel: "rc",
  updatePolicy: "prompt"
};

const noopDesktopPreferences: DesktopPreferencesService = {
  _serviceBrand: undefined,
  store: noopDesktopPreferencesStore,
  setBrowserUseConnectionMode(mode) {
    return Promise.resolve(mode);
  },
  setDefaultAgentProvider(provider) {
    return Promise.resolve(provider);
  },
  setDockPlacement(placement) {
    return Promise.resolve(placement);
  },
  setDockIconStyle(style) {
    return Promise.resolve(style);
  },
  setLocale(locale) {
    return Promise.resolve(locale);
  },
  setSleepPreventionMode(mode) {
    return Promise.resolve(mode);
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
  rememberAgentComposerDefaults() {
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
