import type * as React from "react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore
} from "react";
import { createPortal } from "react-dom";
import { useService } from "@tutti-os/infra/di";
import type { WorkspaceSummary } from "@tutti-os/client-tuttid-ts";
import { INotificationService } from "@tutti-os/ui-notifications";
import type { DesktopComputerUseStatus } from "@shared/contracts/ipc";
import {
  AddIcon,
  Button,
  ChevronDownIcon,
  ChevronUpIcon,
  CloseIcon,
  DeleteIcon,
  EyeIcon,
  GitHubBrandIcon,
  ImportLinedIcon,
  Input,
  LoadingIcon,
  OpenLinkLinedIcon,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  UploadIcon,
  WebIcon
} from "@tutti-os/ui-system";
import { useAnalyticsDebugPreferenceService } from "@renderer/features/analytics-debug";
import { useDesktopPreferencesService } from "@renderer/features/desktop-preferences/ui/useDesktopPreferencesService";
import { useTranslation } from "@renderer/i18n";
import { cn } from "@renderer/lib/format";
import {
  setAgentDiagnosticsConsent,
  useAgentDiagnosticsConsent
} from "@renderer/lib/agentDiagnosticsConsent";
import { formatWorkspaceSettingsBytes } from "../services/workspaceSettingsFormat";
import type { WorkspaceSettingsDeveloperLogsSnapshotState } from "../services/workspaceSettingsTypes";
import type {
  WorkspaceManagedModel,
  WorkspaceManagedModelProviderDraft,
  WorkspaceManagedModelProviderFeedback,
  WorkspaceManagedModelProviderFeedbackKind,
  WorkspaceManagedModelProviderID,
  WorkspaceSettingsGeneralFocusAnchor,
  WorkspaceSettingsManagedModelsSnapshotState
} from "../services/workspaceSettingsTypes";
import {
  desktopLocales,
  type DesktopI18nKey,
  type DesktopLocale
} from "../../../../../shared/i18n/index.ts";
import {
  type DesktopAgentProvider,
  desktopAgentConversationDetailModes,
  desktopAppCatalogChannels,
  desktopBrowserUseConnectionModes,
  desktopDockPlacements,
  desktopFileDefaultOpeners,
  desktopMinimizeAnimations,
  desktopSleepPreventionModes,
  desktopWorkbenchWindowSnappingShortcutPresets,
  normalizeDesktopFileExtension,
  type DesktopAppCatalogChannel,
  type DesktopAgentConversationDetailMode,
  type DesktopBrowserUseConnectionMode,
  type DesktopDockPlacement,
  type DesktopFileDefaultOpener,
  type DesktopFileDefaultOpenersByExtension,
  type DesktopMinimizeAnimation,
  type DesktopSleepPreventionMode,
  type DesktopWorkbenchWindowSnapping,
  type DesktopWorkbenchWindowSnappingShortcutPreset
} from "../../../../../shared/preferences/index.ts";
import { resolveWorkspaceAgentGuiLabel } from "../services/workspaceAgentProviderCatalog";
import {
  desktopThemeSources,
  type DesktopThemeAppearance,
  type DesktopThemeSource
} from "../../../../../shared/theme/index.ts";
import { useWorkspaceSettingsService } from "./useWorkspaceSettingsService";
import { useWorkspaceWorkbenchHostService } from "./useWorkspaceWorkbenchHostService";
import {
  WorkspaceSettingsActionButton,
  workspaceSettingsControlColumnClass
} from "./WorkspaceSettingsActionButton";
import { CustomWallpaperImageError } from "../services/customWallpaper";
import {
  customWorkspaceWallpaperId,
  getWorkspaceWallpaperOption,
  workspaceWallpaperDisplayModeTitleKey,
  type WorkspaceWallpaperDisplayMode,
  type WorkspaceWallpaperId,
  workspaceWallpaperDisplayModes,
  workspaceWallpaperOptions
} from "../services/workspaceWallpaper";

const workspaceSettingsSelectTriggerClass =
  "w-full h-8 min-w-0 overflow-hidden rounded-[6px] border-0 bg-[var(--transparency-block)] px-3 text-left text-[13px] font-normal text-[var(--text-primary)] !shadow-none !outline-none !ring-0 transition-colors duration-200 hover:bg-[var(--transparency-hover)] focus-visible:border-0 focus-visible:!ring-0 *:data-[slot=select-value]:!block *:data-[slot=select-value]:min-w-0 *:data-[slot=select-value]:flex-1 *:data-[slot=select-value]:overflow-hidden *:data-[slot=select-value]:text-left *:data-[slot=select-value]:text-ellipsis *:data-[slot=select-value]:whitespace-nowrap";
const workspaceSettingsSelectContentClass =
  "w-[var(--radix-select-trigger-width)] rounded-[8px] border border-[var(--border-1)] bg-[var(--background-fronted)] px-1 text-[var(--text-primary)] shadow-[0_16px_40px_var(--shadow-elevated)] [--tutti-select-content-min-width:100%] !outline-none !ring-0";
const workspaceSettingsInputClass =
  "h-8 w-full rounded-[6px] border border-[var(--border-1)] bg-[var(--transparency-block)] px-3 text-[13px] text-[var(--text-primary)] outline-none transition-colors duration-150 placeholder:text-[var(--text-tertiary)] hover:bg-[var(--transparency-hover)] focus-visible:border-[var(--border-focus)]";
const workspaceManagedModelInputClass = `${workspaceSettingsInputClass} focus-visible:!border-[var(--border-1)]`;
const workspaceManagedModelProviderPrefixClass =
  "flex h-8 items-center justify-end px-2 text-[11px] text-[var(--text-secondary)]";

const developerPanelUnlockTaps = 7;
const computerUseOperationSettleMs = 280;
const tuttiWebsiteUrl = "https://tutti.sh/";
const tuttiGitHubUrl = "https://github.com/tutti-os/tutti";
const tuttiDesktopIconUrl = new URL(
  "../../../../../../build/icon.png",
  import.meta.url
).href;
const workspaceSettingsDefaultAgentProviders = [
  "codex",
  "claude-code"
] as const satisfies readonly DesktopAgentProvider[];

function isWorkspaceSettingsDefaultAgentProvider(
  provider: DesktopAgentProvider
): boolean {
  return provider === "codex" || provider === "claude-code";
}

export function WorkspaceSettingsPanel({
  onOpenExternalAgentImport,
  onSelectWallpaper,
  onSelectWallpaperDisplayMode,
  selectedWallpaperDisplayMode,
  selectedWallpaperID,
  workspace
}: {
  onOpenExternalAgentImport: () => void;
  onSelectWallpaper: (id: WorkspaceWallpaperId) => void;
  onSelectWallpaperDisplayMode: (
    displayMode: WorkspaceWallpaperDisplayMode
  ) => void;
  selectedWallpaperDisplayMode: WorkspaceWallpaperDisplayMode;
  selectedWallpaperID: WorkspaceWallpaperId;
  workspace: WorkspaceSummary;
}) {
  const { t } = useTranslation();
  const notifications = useService(INotificationService);
  const {
    service: analyticsDebugPreferenceService,
    state: analyticsDebugPreferenceState
  } = useAnalyticsDebugPreferenceService();
  const { service: desktopPreferencesService, state: desktopPreferencesState } =
    useDesktopPreferencesService();
  const { service: settingsService, state: settingsState } =
    useWorkspaceSettingsService();
  const versionTapCountRef = useRef(0);

  useEffect(() => {
    if (settingsState.open) {
      settingsService.syncWorkspace({ id: workspace.id });
    }
  }, [settingsService, settingsState.open, workspace.id]);

  const handleVersionTap = () => {
    if (settingsState.developerPanelVisible) {
      return;
    }

    versionTapCountRef.current += 1;
    if (versionTapCountRef.current >= developerPanelUnlockTaps) {
      versionTapCountRef.current = 0;
      settingsService.setDeveloperPanelVisible(true);
      notifications.success({
        title: t("workspace.settings.about.developerModeEnabled")
      });
    }
  };

  if (!settingsState.open) {
    return null;
  }

  return (
    <WorkspaceSettingsPanelPortal
      dialogOpen={false}
      onClose={() => {
        settingsService.closePanel();
      }}
    >
      <section
        aria-labelledby="workspace-settings-title"
        aria-modal="true"
        className="relative z-[1] grid h-[min(500px,calc(100vh-40px))] w-[min(760px,calc(100vw-40px))] origin-center grid-cols-[160px_minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-2xl border border-[var(--border-1)] bg-[var(--background-fronted)] text-[var(--text-primary)] shadow-panel transition-[background,opacity] duration-[180ms] ease-[cubic-bezier(0.22,1,0.36,1)] [-webkit-app-region:no-drag] motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-[0.96] motion-safe:duration-[250ms] motion-safe:ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:animate-none max-[760px]:h-[min(100vh-24px,520px)] max-[760px]:w-[min(calc(100vw-24px),640px)] max-[760px]:grid-cols-1 max-[760px]:grid-rows-[auto_auto_minmax(0,1fr)]"
        data-workspace-settings-panel="true"
        role="dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="col-[1/-1] row-start-1 flex h-[54px] min-h-[54px] items-center justify-between border-b border-[var(--border-1)] px-[22px] py-[13px] max-[760px]:px-5">
          <h2
            id="workspace-settings-title"
            className="m-0 text-[15px] font-semibold leading-[1.3] text-[var(--text-primary)]"
          >
            {t("workspace.settings.title")}
          </h2>
          <Button
            aria-label={t("workspace.settings.close")}
            size="icon-sm"
            title={t("workspace.settings.close")}
            type="button"
            variant="ghost"
            onClick={() => {
              settingsService.closePanel();
            }}
          >
            <CloseIcon className="size-4" />
          </Button>
        </div>

        <aside
          aria-label={t("workspace.settings.nav.sectionsLabel")}
          className="col-start-1 row-start-2 flex min-h-0 flex-col gap-2 overflow-y-auto border-r border-[var(--border-1)] bg-[var(--background-fronted)] px-3 pb-4 pt-3 max-[760px]:row-start-2 max-[760px]:overflow-x-auto max-[760px]:border-b max-[760px]:border-r-0 max-[760px]:px-3 max-[760px]:pb-3.5 max-[760px]:pt-5"
        >
          {[
            {
              id: "general" as const,
              label: t("workspace.settings.nav.general")
            },
            {
              id: "agent" as const,
              label: t("workspace.settings.nav.agent")
            },
            {
              id: "appearance" as const,
              label: t("workspace.settings.nav.appearance")
            },
            {
              id: "apps" as const,
              label: t("workspace.settings.nav.apps")
            },
            {
              id: "about" as const,
              label: t("workspace.settings.nav.about")
            },
            ...(settingsState.developerPanelVisible
              ? [
                  {
                    id: "developer" as const,
                    label: t("workspace.settings.nav.developer")
                  }
                ]
              : [])
          ].map((section) => {
            const selected = settingsState.activeSection === section.id;
            return (
              <button
                key={section.id}
                aria-pressed={selected}
                className={cn(
                  "block w-full min-w-0 truncate whitespace-nowrap rounded-md border-0 px-2.5 py-1.5 text-left text-[13px] font-semibold leading-[1.35] outline-none transition-colors duration-150 hover:bg-[var(--transparency-block)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--border-focus)]",
                  selected
                    ? "bg-[var(--transparency-block)] text-[var(--text-primary)]"
                    : "bg-transparent text-[var(--text-secondary)]"
                )}
                type="button"
                onClick={() => settingsService.selectSection(section.id)}
              >
                {section.label}
              </button>
            );
          })}
        </aside>

        <div className="col-start-2 row-start-2 flex min-h-0 flex-col max-[760px]:col-start-1 max-[760px]:row-start-3">
          <div className="flex min-h-0 flex-1 flex-col gap-0 overflow-y-auto px-[22px] pb-[22px] pt-0 max-[760px]:px-5 max-[760px]:pb-6">
            {settingsState.activeSection === "general" ? (
              <WorkspaceGeneralSettingsSection
                changingLocale={desktopPreferencesState.changingLocale}
                changingSleepPreventionMode={
                  desktopPreferencesState.changingSleepPreventionMode
                }
                locale={desktopPreferencesState.locale}
                onLocaleChange={(nextLocale) => {
                  void settingsService.changeLocale(nextLocale);
                }}
                onSleepPreventionModeChange={(mode) => {
                  void settingsService.changeSleepPreventionMode(mode);
                }}
                sleepPreventionMode={
                  desktopPreferencesState.sleepPreventionMode
                }
              />
            ) : settingsState.activeSection === "agent" ? (
              <WorkspaceAgentSettingsSection
                agentConversationDetailMode={
                  desktopPreferencesState.agentConversationDetailMode
                }
                browserUseConnectionMode={
                  desktopPreferencesState.browserUseConnectionMode
                }
                changingAgentConversationDetailMode={
                  desktopPreferencesState.changingAgentConversationDetailMode
                }
                changingDefaultAgentProvider={
                  desktopPreferencesState.changingDefaultAgentProvider
                }
                changingBrowserUseConnectionMode={
                  desktopPreferencesState.changingBrowserUseConnectionMode
                }
                defaultAgentProvider={
                  desktopPreferencesState.defaultAgentProvider
                }
                focusedAnchor={settingsState.generalFocusAnchor}
                focusRequestID={settingsState.generalFocusRequestID}
                onBrowserUseConnectionModeChange={(mode) => {
                  void settingsService.changeBrowserUseConnectionMode(mode);
                }}
                onAgentConversationDetailModeChange={(mode) => {
                  void settingsService.changeAgentConversationDetailMode(mode);
                }}
                onDefaultAgentProviderChange={(provider) => {
                  void settingsService.changeDefaultAgentProvider(provider);
                }}
                onOpenExternalAgentImport={onOpenExternalAgentImport}
              />
            ) : settingsState.activeSection === "appearance" ? (
              <WorkspaceAppearanceSettingsSection
                changingDockPlacement={
                  desktopPreferencesState.changingDockPlacement
                }
                changingThemeSource={
                  desktopPreferencesState.changingThemeSource
                }
                changingMinimizeAnimation={
                  desktopPreferencesState.changingMinimizeAnimation
                }
                changingWorkbenchWindowSnapping={
                  desktopPreferencesState.changingWorkbenchWindowSnapping
                }
                dockPlacement={desktopPreferencesState.dockPlacement}
                minimizeAnimation={desktopPreferencesState.minimizeAnimation}
                onDockPlacementChange={(placement) => {
                  void settingsService.changeDockPlacement(placement);
                }}
                onMinimizeAnimationChange={(animation) => {
                  void settingsService.changeMinimizeAnimation(animation);
                }}
                onWorkbenchWindowSnappingChange={(value) => {
                  void settingsService.changeWorkbenchWindowSnapping(value);
                }}
                onSelectWallpaper={onSelectWallpaper}
                onSelectWallpaperDisplayMode={onSelectWallpaperDisplayMode}
                onThemeChange={(nextThemeSource) => {
                  void settingsService.changeThemeSource(nextThemeSource);
                }}
                selectedWallpaperDisplayMode={selectedWallpaperDisplayMode}
                selectedWallpaperID={selectedWallpaperID}
                themeAppearance={desktopPreferencesState.theme.appearance}
                themeSource={desktopPreferencesState.theme.source}
                workbenchWindowSnapping={
                  desktopPreferencesState.workbenchWindowSnapping
                }
              />
            ) : settingsState.activeSection === "apps" ? (
              <WorkspaceAppsSettingsSection
                managedModels={settingsState.managedModels}
                onBeginDraft={(provider) => {
                  settingsService.beginManagedModelProviderDraft(provider);
                }}
                onCancelDraft={() => {
                  settingsService.cancelManagedModelProviderDraft();
                }}
                onDeleteProvider={(providerID) => {
                  void settingsService.removeManagedModelProvider(providerID);
                }}
                onDetectProviderModels={(providerID) => {
                  void settingsService.detectManagedModelProviderModels(
                    providerID
                  );
                }}
                onSaveDraft={() => {
                  void settingsService.saveManagedModelDraft();
                }}
                onSaveProvider={(provider) => {
                  void settingsService.saveManagedModelProvider(provider);
                }}
                onSetProviderEnabled={(providerID, enabled) => {
                  void settingsService.setManagedModelProviderEnabled(
                    providerID,
                    enabled
                  );
                }}
                onTestProvider={(providerID) => {
                  void settingsService.testManagedModelProvider(providerID);
                }}
                onUpdateDraft={(patch) => {
                  settingsService.updateManagedModelDraft(patch);
                }}
                onUpdateProvider={(providerID, patch) => {
                  settingsService.updateManagedModelProviderDraft(
                    providerID,
                    patch
                  );
                }}
              />
            ) : settingsState.activeSection === "about" ? (
              <WorkspaceAboutSettingsSection
                developerLogs={settingsState.developerLogs}
                onVersionTap={handleVersionTap}
              />
            ) : (
              <WorkspaceDeveloperSettingsSection
                analyticsDebugAvailable={
                  analyticsDebugPreferenceState.available
                }
                analyticsDebugEnabled={analyticsDebugPreferenceState.enabled}
                appCatalogChannel={desktopPreferencesState.appCatalogChannel}
                changingAppCatalogChannel={
                  desktopPreferencesState.changingAppCatalogChannel
                }
                developerLogs={settingsState.developerLogs}
                developerPanelVisible={settingsState.developerPanelVisible}
                fileDefaultOpenersByExtension={
                  desktopPreferencesState.fileDefaultOpenersByExtension
                }
                showAppDeveloperSources={
                  desktopPreferencesState.showAppDeveloperSources
                }
                onAppCatalogChannelChange={(channel) => {
                  void settingsService.changeAppCatalogChannel(channel);
                }}
                onAnalyticsDebugEnabledChange={(enabled) => {
                  analyticsDebugPreferenceService.setEnabled(enabled);
                }}
                onClearConversationHistory={() => {
                  if (
                    window.confirm(
                      t(
                        "workspace.settings.developer.clearConversationHistoryConfirm"
                      )
                    )
                  ) {
                    void settingsService.clearConversationHistory();
                  }
                }}
                onClearLogs={() => {
                  void settingsService.clearDeveloperLogs();
                }}
                onDeveloperPanelVisibleChange={(visible) => {
                  settingsService.setDeveloperPanelVisible(visible);
                }}
                onShowAppDeveloperSourcesChange={(show) => {
                  void settingsService.changeShowAppDeveloperSources(show);
                }}
                onExportLogs={() => {
                  void settingsService.exportDeveloperLogs();
                }}
                onFileDefaultOpenersChange={(openersByExtension) => {
                  void desktopPreferencesService.setFileDefaultOpenersByExtension(
                    openersByExtension
                  );
                }}
              />
            )}
          </div>
        </div>
      </section>
    </WorkspaceSettingsPanelPortal>
  );
}

const managedModelProviderLabels: Record<
  WorkspaceManagedModelProviderID,
  string
> = {
  agnes: "Agnes",
  anthropic: "Anthropic",
  openai: "OpenAI"
};

type ManagedModelProviderPreset = {
  provider: WorkspaceManagedModelProviderID;
  labelKey: DesktopI18nKey;
  baseUrl: string;
  apiKeyUrl: string;
  models: readonly string[];
};

const CUSTOM_MANAGED_MODEL_PROVIDER_PRESET = "__custom_provider__";
const AGNES_API_KEYS_URL = "https://platform.agnes-ai.com/settings/apiKeys";
const ANTHROPIC_API_KEYS_URL = "https://console.anthropic.com/settings/keys";
const DEEPSEEK_API_KEYS_URL = "https://platform.deepseek.com/api_keys";
const MINIMAX_API_KEYS_URL = "https://platform.minimax.io/console/access";
const MIMO_API_KEYS_URL = "https://platform.xiaomimimo.com/console/api-keys";
const OPENAI_API_KEYS_URL = "https://platform.openai.com/api-keys";

const managedModelProviderPresets: readonly ManagedModelProviderPreset[] = [
  {
    provider: "agnes",
    labelKey: "workspace.settings.apps.managedModels.presetLabels.agnes",
    baseUrl: "https://apihub.agnes-ai.com/v1",
    apiKeyUrl: AGNES_API_KEYS_URL,
    models: ["agnes-2.0-flash", "agnes-1.5-flash"]
  },
  {
    provider: "anthropic",
    labelKey:
      "workspace.settings.apps.managedModels.presetLabels.anthropicClaude",
    baseUrl: "https://api.anthropic.com/v1",
    apiKeyUrl: ANTHROPIC_API_KEYS_URL,
    models: ["claude-sonnet-4-6", "claude-opus-4-8", "claude-haiku-4-5"]
  },
  {
    provider: "anthropic",
    labelKey:
      "workspace.settings.apps.managedModels.presetLabels.deepseekAnthropic",
    baseUrl: "https://api.deepseek.com/anthropic",
    apiKeyUrl: DEEPSEEK_API_KEYS_URL,
    models: [
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "deepseek-chat",
      "deepseek-reasoner"
    ]
  },
  {
    provider: "anthropic",
    labelKey:
      "workspace.settings.apps.managedModels.presetLabels.minimaxAnthropic",
    baseUrl: "https://api.minimaxi.com/anthropic",
    apiKeyUrl: MINIMAX_API_KEYS_URL,
    models: [
      "MiniMax-M3",
      "MiniMax-M2.7-highspeed",
      "MiniMax-M2.7",
      "MiniMax-M2.5-highspeed",
      "MiniMax-M2.5",
      "MiniMax-M2.1-highspeed",
      "MiniMax-M2.1",
      "MiniMax-M2"
    ]
  },
  {
    provider: "openai",
    labelKey:
      "workspace.settings.apps.managedModels.presetLabels.openaiOfficial",
    baseUrl: "https://api.openai.com/v1",
    apiKeyUrl: OPENAI_API_KEYS_URL,
    models: ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano"]
  },
  {
    provider: "openai",
    labelKey:
      "workspace.settings.apps.managedModels.presetLabels.deepseekOpenai",
    baseUrl: "https://api.deepseek.com",
    apiKeyUrl: DEEPSEEK_API_KEYS_URL,
    models: [
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "deepseek-chat",
      "deepseek-reasoner"
    ]
  },
  {
    provider: "openai",
    labelKey:
      "workspace.settings.apps.managedModels.presetLabels.minimaxOpenai",
    baseUrl: "https://api.minimaxi.com/v1",
    apiKeyUrl: MINIMAX_API_KEYS_URL,
    models: [
      "MiniMax-M3",
      "MiniMax-M2.7-highspeed",
      "MiniMax-M2.7",
      "MiniMax-M2.5-highspeed",
      "MiniMax-M2.5",
      "MiniMax-M2.1-highspeed",
      "MiniMax-M2.1",
      "MiniMax-M2"
    ]
  },
  {
    provider: "openai",
    labelKey: "workspace.settings.apps.managedModels.presetLabels.mimoOpenai",
    baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
    apiKeyUrl: MIMO_API_KEYS_URL,
    models: ["mimo-v2.5-pro"]
  },
  {
    provider: "anthropic",
    labelKey:
      "workspace.settings.apps.managedModels.presetLabels.mimoAnthropic",
    baseUrl: "https://token-plan-cn.xiaomimimo.com/anthropic",
    apiKeyUrl: MIMO_API_KEYS_URL,
    models: ["mimo-v2.5-pro"]
  }
];

function defaultManagedProviderBaseUrl(
  provider: WorkspaceManagedModelProviderID
): string {
  switch (provider) {
    case "agnes":
      return "https://apihub.agnes-ai.com/v1";
    case "anthropic":
      return "https://api.anthropic.com/v1";
    case "openai":
      return "https://api.openai.com/v1";
  }
}

function defaultManagedProviderModel(
  provider: WorkspaceManagedModelProviderID
): string {
  switch (provider) {
    case "agnes":
      return "agnes-2.0-flash";
    case "anthropic":
      return "claude-sonnet-4-6";
    case "openai":
      return "gpt-5.5";
  }
}

function getManagedModelProviderPresets(
  provider: WorkspaceManagedModelProviderID
): ManagedModelProviderPreset[] {
  return managedModelProviderPresets.filter(
    (preset) => preset.provider === provider
  );
}

function getSelectedManagedModelProviderPreset(
  provider: WorkspaceManagedModelProviderID,
  baseUrl: string | undefined
): ManagedModelProviderPreset | null {
  const currentBaseUrl = baseUrl?.trim() ?? "";
  if (!currentBaseUrl) {
    return null;
  }
  return (
    managedModelProviderPresets.find(
      (preset) =>
        preset.provider === provider && preset.baseUrl === currentBaseUrl
    ) ?? null
  );
}

function toManagedModelPresetRows(
  preset: ManagedModelProviderPreset
): WorkspaceManagedModel[] {
  return preset.models.map((id) => ({
    id,
    name: id,
    provider: preset.provider
  }));
}

const managedModelProviderOrder: readonly WorkspaceManagedModelProviderID[] = [
  "agnes",
  "openai",
  "anthropic"
];

const managedModelFeedbackConfig: Record<
  WorkspaceManagedModelProviderFeedbackKind,
  { className: string; messageKey: DesktopI18nKey }
> = {
  testOk: {
    className: "text-[var(--state-success)]",
    messageKey: "workspace.settings.apps.managedModels.testSucceeded"
  },
  testFailed: {
    className: "text-[var(--state-danger)]",
    messageKey: "workspace.settings.apps.managedModels.testFailed"
  },
  detectEmpty: {
    className: "text-[var(--text-tertiary)]",
    messageKey: "workspace.settings.apps.managedModels.detectModelsEmpty"
  },
  detectFailed: {
    className: "text-[var(--state-danger)]",
    messageKey: "workspace.settings.apps.managedModels.detectModelsFailed"
  },
  saveFailed: {
    className: "text-[var(--state-danger)]",
    messageKey: "workspace.settings.apps.managedModels.saveFailed"
  },
  deleteFailed: {
    className: "text-[var(--state-danger)]",
    messageKey: "workspace.settings.apps.managedModels.deleteFailed"
  },
  requiredFields: {
    className: "text-[var(--state-danger)]",
    messageKey: "workspace.settings.apps.managedModels.requiredFieldsMissing"
  }
};

function ManagedModelFeedbackLine({
  feedback
}: {
  feedback: WorkspaceManagedModelProviderFeedback | undefined;
}) {
  const { t } = useTranslation();
  if (!feedback) {
    return null;
  }
  const config = managedModelFeedbackConfig[feedback.kind];
  return (
    <p className={cn("m-0 text-[12px] leading-[1.4]", config.className)}>
      {t(config.messageKey)}
    </p>
  );
}

function normalizeWorkspaceManagedModelRows(
  provider: WorkspaceManagedModelProviderID,
  models: readonly WorkspaceManagedModel[]
): WorkspaceManagedModel[] {
  const seen = new Set<string>();
  const normalized: WorkspaceManagedModel[] = [];
  for (const model of models) {
    const id = model.id.trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    normalized.push({
      id,
      name: model.name.trim() || id,
      provider
    });
  }
  return normalized;
}

function WorkspaceAppsSettingsSection({
  managedModels,
  onBeginDraft,
  onCancelDraft,
  onDeleteProvider,
  onDetectProviderModels,
  onSaveDraft,
  onSaveProvider,
  onSetProviderEnabled,
  onTestProvider,
  onUpdateDraft,
  onUpdateProvider
}: {
  managedModels: WorkspaceSettingsManagedModelsSnapshotState;
  onBeginDraft: (provider: WorkspaceManagedModelProviderID) => void;
  onCancelDraft: () => void;
  onDeleteProvider: (providerID: WorkspaceManagedModelProviderID) => void;
  onDetectProviderModels: (providerID: WorkspaceManagedModelProviderID) => void;
  onSaveDraft: () => void;
  onSaveProvider: (provider: WorkspaceManagedModelProviderDraft) => void;
  onSetProviderEnabled: (
    providerID: WorkspaceManagedModelProviderID,
    enabled: boolean
  ) => void;
  onTestProvider: (providerID: WorkspaceManagedModelProviderID) => void;
  onUpdateDraft: (patch: Partial<WorkspaceManagedModelProviderDraft>) => void;
  onUpdateProvider: (
    providerID: WorkspaceManagedModelProviderID,
    patch: Partial<WorkspaceManagedModelProviderDraft>
  ) => void;
}) {
  const { t } = useTranslation();
  const { draft, providers } = managedModels;
  const [expandedProviderID, setExpandedProviderID] =
    useState<WorkspaceManagedModelProviderID | null>(
      managedModels.focusedProvider
    );
  const [confirmingDeleteID, setConfirmingDeleteID] =
    useState<WorkspaceManagedModelProviderID | null>(null);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const addMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const provider = managedModels.focusedProvider;
    if (
      provider &&
      providers.some((candidate) => candidate.provider === provider)
    ) {
      setExpandedProviderID(provider);
    }
  }, [managedModels.focusedProvider, managedModels.focusRequestID, providers]);

  useEffect(() => {
    if (!addMenuOpen) {
      return;
    }
    const handlePointerDown = (event: MouseEvent) => {
      if (
        addMenuRef.current &&
        !addMenuRef.current.contains(event.target as Node)
      ) {
        setAddMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", handlePointerDown);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
    };
  }, [addMenuOpen]);

  const configuredProviders = new Set(
    providers.map((provider) => provider.provider)
  );
  const availableProviders = managedModelProviderOrder.filter(
    (provider) =>
      !configuredProviders.has(provider) && draft?.provider !== provider
  );
  const canAddProvider = availableProviders.length > 0 && draft === null;
  const isEmpty = providers.length === 0 && draft === null;

  return (
    <SettingsRows>
      <div className="flex w-full items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-2">
          <strong className="text-[13px] font-semibold text-[var(--text-primary)]">
            {t("workspace.settings.apps.managedModels.title")}
          </strong>
          <p className="m-0 text-[13px] leading-[1.35] text-[var(--text-secondary)]">
            {t("workspace.settings.apps.managedModels.description")}
          </p>
        </div>
        <div className="relative shrink-0" ref={addMenuRef}>
          <Button
            disabled={!canAddProvider}
            size="sm"
            type="button"
            onClick={() => setAddMenuOpen((open) => !open)}
          >
            <AddIcon className="size-3.5" />
            {t("workspace.settings.apps.managedModels.addProvider")}
          </Button>
          {addMenuOpen && canAddProvider ? (
            <div
              className="absolute right-0 top-[calc(100%+6px)] flex min-w-[160px] flex-col gap-0.5 rounded-[8px] border border-[var(--border-1)] bg-[var(--background-fronted)] p-1 shadow-[0_16px_40px_var(--shadow-elevated)]"
              role="menu"
              style={{ zIndex: "var(--z-panel-popover)" }}
            >
              {availableProviders.map((provider) => (
                <button
                  key={provider}
                  className="rounded-[6px] px-2.5 py-1.5 text-left text-[13px] text-[var(--text-primary)] outline-none transition-colors duration-150 hover:bg-[var(--transparency-hover)] focus-visible:bg-[var(--transparency-hover)]"
                  role="menuitem"
                  type="button"
                  onClick={() => {
                    onBeginDraft(provider);
                    setExpandedProviderID(null);
                    setAddMenuOpen(false);
                  }}
                >
                  {managedModelProviderLabels[provider]}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      {isEmpty ? (
        <div className="flex flex-col items-center gap-1.5 rounded-[10px] border border-dashed border-[var(--border-1)] bg-[var(--transparency-block)] px-4 py-8 text-center">
          <p className="m-0 text-[13px] font-medium text-[var(--text-primary)]">
            {t("workspace.settings.apps.managedModels.emptyTitle")}
          </p>
          <p className="m-0 text-[12px] leading-[1.4] text-[var(--text-secondary)]">
            {t("workspace.settings.apps.managedModels.emptyDescription")}
          </p>
        </div>
      ) : (
        <div className="flex w-full flex-col gap-2">
          {providers.map((provider) => (
            <ManagedModelProviderItem
              key={provider.provider}
              confirmingDelete={confirmingDeleteID === provider.provider}
              deleting={managedModels.deletingProvider === provider.provider}
              detecting={managedModels.detectingProvider === provider.provider}
              expanded={expandedProviderID === provider.provider}
              feedback={managedModels.feedback[provider.provider]}
              provider={provider}
              saving={managedModels.savingProvider === provider.provider}
              testing={managedModels.testingProvider === provider.provider}
              onCancelDelete={() => setConfirmingDeleteID(null)}
              onConfirmDelete={() => {
                setConfirmingDeleteID(null);
                onDeleteProvider(provider.provider);
              }}
              onDetect={() => onDetectProviderModels(provider.provider)}
              onRequestDelete={() => setConfirmingDeleteID(provider.provider)}
              onSave={() => onSaveProvider(provider)}
              onSetEnabled={(enabled) =>
                onSetProviderEnabled(provider.provider, enabled)
              }
              onTest={() => onTestProvider(provider.provider)}
              onToggleExpand={() =>
                setExpandedProviderID((current) =>
                  current === provider.provider ? null : provider.provider
                )
              }
              onUpdate={(patch) => onUpdateProvider(provider.provider, patch)}
            />
          ))}
          {draft ? (
            <ManagedModelDraftItem
              draft={draft}
              feedback={managedModels.feedback[draft.provider]}
              saving={managedModels.savingProvider === draft.provider}
              onCancel={onCancelDraft}
              onSave={onSaveDraft}
              onUpdate={onUpdateDraft}
            />
          ) : null}
        </div>
      )}
    </SettingsRows>
  );
}

function ManagedModelProviderItem({
  confirmingDelete,
  deleting,
  detecting,
  expanded,
  feedback,
  provider,
  saving,
  testing,
  onCancelDelete,
  onConfirmDelete,
  onDetect,
  onRequestDelete,
  onSave,
  onSetEnabled,
  onTest,
  onToggleExpand,
  onUpdate
}: {
  confirmingDelete: boolean;
  deleting: boolean;
  detecting: boolean;
  expanded: boolean;
  feedback: WorkspaceManagedModelProviderFeedback | undefined;
  provider: WorkspaceManagedModelProviderDraft;
  saving: boolean;
  testing: boolean;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
  onDetect: () => void;
  onRequestDelete: () => void;
  onSave: () => void;
  onSetEnabled: (enabled: boolean) => void;
  onTest: () => void;
  onToggleExpand: () => void;
  onUpdate: (patch: Partial<WorkspaceManagedModelProviderDraft>) => void;
}) {
  const { t } = useTranslation();
  const { addModel, modelInputRefs, updateModels } = useManagedModelRows(
    provider,
    onUpdate
  );
  const label = managedModelProviderLabels[provider.provider];
  const status = provider.hasApiKey
    ? `${t("workspace.settings.apps.managedModels.keyConfigured")} · ${t(
        "workspace.settings.apps.managedModels.modelCount",
        { count: String(provider.models.length) }
      )}`
    : t("workspace.settings.apps.managedModels.keyMissing");

  return (
    <section className="flex w-full flex-col gap-4 rounded-[10px] border border-[var(--border-1)] bg-[var(--transparency-block)] p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <strong className="block text-[13px] font-semibold text-[var(--text-primary)]">
            {label}
          </strong>
          <p className="m-0 mt-1 truncate text-[11px] leading-[1.3] text-[var(--text-secondary)]">
            {status}
          </p>
        </div>
        {confirmingDelete ? (
          <div className="flex shrink-0 items-center gap-2">
            <span className="text-[12px] text-[var(--text-secondary)]">
              {t("workspace.settings.apps.managedModels.deleteConfirm")}
            </span>
            <Button
              disabled={deleting}
              size="sm"
              type="button"
              variant="secondary"
              onClick={onConfirmDelete}
            >
              {deleting
                ? t("workspace.settings.apps.managedModels.deleting")
                : t("workspace.settings.apps.managedModels.delete")}
            </Button>
            <Button
              size="sm"
              type="button"
              variant="ghost"
              onClick={onCancelDelete}
            >
              {t("common.cancel")}
            </Button>
          </div>
        ) : (
          <div className="flex shrink-0 items-center gap-1">
            <Button
              aria-expanded={expanded}
              aria-label={t(
                expanded
                  ? "workspace.settings.apps.managedModels.collapse"
                  : "workspace.settings.apps.managedModels.expand"
              )}
              className="text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              size="icon"
              type="button"
              variant="ghost"
              onClick={onToggleExpand}
            >
              {expanded ? (
                <ChevronUpIcon aria-hidden="true" size={16} />
              ) : (
                <ChevronDownIcon aria-hidden="true" size={16} />
              )}
            </Button>
            <Button
              aria-label={t("workspace.settings.apps.managedModels.delete")}
              className="text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              size="icon"
              type="button"
              variant="ghost"
              onClick={onRequestDelete}
            >
              <DeleteIcon aria-hidden="true" size={15} />
            </Button>
            <Switch
              aria-label={t("workspace.settings.apps.managedModels.enabled", {
                provider: label
              })}
              checked={provider.enabled}
              disabled={saving}
              onCheckedChange={onSetEnabled}
            />
          </div>
        )}
      </div>

      {expanded ? null : <ManagedModelFeedbackLine feedback={feedback} />}

      {expanded ? (
        <>
          <ManagedModelProviderFields
            detecting={detecting}
            draft={provider}
            modelInputRefs={modelInputRefs}
            onDetect={onDetect}
            onUpdate={onUpdate}
            updateModels={updateModels}
          />
          <ManagedModelFeedbackLine feedback={feedback} />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button
              className="h-auto px-0 text-[12px] font-medium text-[var(--text-primary)] hover:bg-transparent hover:text-[var(--text-primary)]"
              size="sm"
              type="button"
              variant="ghost"
              onClick={addModel}
            >
              <AddIcon className="size-3.5" />
              {t("workspace.settings.apps.managedModels.addModel")}
            </Button>
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                disabled={testing}
                type="button"
                variant="secondary"
                onClick={onTest}
              >
                {testing
                  ? t("workspace.settings.apps.managedModels.testing")
                  : t("workspace.settings.apps.managedModels.test")}
              </Button>
              <Button disabled={saving} type="button" onClick={onSave}>
                {saving
                  ? t("workspace.settings.apps.managedModels.saving")
                  : t("workspace.settings.apps.managedModels.save")}
              </Button>
            </div>
          </div>
        </>
      ) : null}
    </section>
  );
}

function ManagedModelDraftItem({
  draft,
  feedback,
  saving,
  onCancel,
  onSave,
  onUpdate
}: {
  draft: WorkspaceManagedModelProviderDraft;
  feedback: WorkspaceManagedModelProviderFeedback | undefined;
  saving: boolean;
  onCancel: () => void;
  onSave: () => void;
  onUpdate: (patch: Partial<WorkspaceManagedModelProviderDraft>) => void;
}) {
  const { t } = useTranslation();
  const { addModel, modelInputRefs, updateModels } = useManagedModelRows(
    draft,
    onUpdate
  );

  return (
    <section className="flex w-full flex-col gap-4 rounded-[10px] border border-[var(--border-1)] bg-[var(--transparency-block)] p-4">
      <div className="flex items-center justify-between gap-3">
        <strong className="text-[13px] font-semibold text-[var(--text-primary)]">
          {managedModelProviderLabels[draft.provider]}
        </strong>
        <button
          aria-label={t("common.cancel")}
          className="flex size-8 items-center justify-center rounded-[6px] text-[var(--text-secondary)] transition-colors duration-150 hover:bg-[var(--transparency-hover)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-focus)]"
          type="button"
          onClick={onCancel}
        >
          <CloseIcon className="size-4" />
        </button>
      </div>

      <ManagedModelProviderFields
        detecting={false}
        draft={draft}
        modelInputRefs={modelInputRefs}
        onDetect={null}
        onUpdate={onUpdate}
        updateModels={updateModels}
      />

      <ManagedModelFeedbackLine feedback={feedback} />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button
          className="h-auto px-0 text-[12px] font-medium text-[var(--text-primary)] hover:bg-transparent hover:text-[var(--text-primary)]"
          size="sm"
          type="button"
          variant="ghost"
          onClick={addModel}
        >
          <AddIcon className="size-3.5" />
          {t("workspace.settings.apps.managedModels.addModel")}
        </Button>
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button disabled={saving} type="button" onClick={onSave}>
            {saving
              ? t("workspace.settings.apps.managedModels.saving")
              : t("workspace.settings.apps.managedModels.save")}
          </Button>
        </div>
      </div>
    </section>
  );
}

function useManagedModelRows(
  draft: WorkspaceManagedModelProviderDraft,
  onUpdate: (patch: Partial<WorkspaceManagedModelProviderDraft>) => void
): {
  addModel: () => void;
  modelInputRefs: React.MutableRefObject<Map<number, HTMLInputElement>>;
  updateModels: (models: readonly WorkspaceManagedModel[]) => void;
} {
  const modelInputRefs = useRef(new Map<number, HTMLInputElement>());
  const [pendingFocusModelIndex, setPendingFocusModelIndex] = useState<
    number | null
  >(null);

  const updateModels = useCallback(
    (models: readonly WorkspaceManagedModel[]) => {
      onUpdate({
        models: normalizeWorkspaceManagedModelRows(draft.provider, models)
      });
    },
    [draft.provider, onUpdate]
  );

  const addModel = useCallback(() => {
    const nextIndex = draft.models.length;
    setPendingFocusModelIndex(nextIndex);
    onUpdate({
      models: [...draft.models, { id: "", name: "", provider: draft.provider }]
    });
  }, [draft.models, draft.provider, onUpdate]);

  useEffect(() => {
    if (pendingFocusModelIndex === null) {
      return;
    }
    const input = modelInputRefs.current.get(pendingFocusModelIndex);
    if (!input) {
      return;
    }
    input.focus();
    setPendingFocusModelIndex(null);
  }, [draft.models.length, pendingFocusModelIndex]);

  return { addModel, modelInputRefs, updateModels };
}

function ManagedModelProviderFields({
  detecting,
  draft,
  modelInputRefs,
  onDetect,
  onUpdate,
  updateModels
}: {
  detecting: boolean;
  draft: WorkspaceManagedModelProviderDraft;
  modelInputRefs: React.MutableRefObject<Map<number, HTMLInputElement>>;
  onDetect: (() => void) | null;
  onUpdate: (patch: Partial<WorkspaceManagedModelProviderDraft>) => void;
  updateModels: (models: readonly WorkspaceManagedModel[]) => void;
}) {
  const { t } = useTranslation();
  const [visibleAPIKeyProviderID, setVisibleAPIKeyProviderID] =
    useState<WorkspaceManagedModelProviderID | null>(null);

  const apiKeyVisible = visibleAPIKeyProviderID === draft.provider;
  const presets = getManagedModelProviderPresets(draft.provider);
  const selectedPreset = getSelectedManagedModelProviderPreset(
    draft.provider,
    draft.baseUrl
  );
  const selectedPresetValue =
    selectedPreset?.baseUrl ?? CUSTOM_MANAGED_MODEL_PROVIDER_PRESET;
  const apiKeyPreset = presets.length === 1 ? presets[0] : selectedPreset;
  const apiKeyUrl = apiKeyPreset?.apiKeyUrl ?? "";

  return (
    <>
      {presets.length > 1 ? (
        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium text-[var(--text-secondary)]">
            {t("workspace.settings.apps.managedModels.quickFillProvider")}
          </span>
          <Select
            value={selectedPresetValue}
            onValueChange={(value) => {
              if (value === CUSTOM_MANAGED_MODEL_PROVIDER_PRESET) {
                onUpdate({ baseUrl: "", models: [] });
                return;
              }
              const preset = presets.find(
                (candidate) => candidate.baseUrl === value
              );
              if (!preset) {
                return;
              }
              onUpdate({
                baseUrl: preset.baseUrl,
                models: normalizeWorkspaceManagedModelRows(
                  draft.provider,
                  toManagedModelPresetRows(preset)
                )
              });
            }}
          >
            <SelectTrigger
              aria-label={t(
                "workspace.settings.apps.managedModels.quickFillProvider"
              )}
              className={workspaceSettingsSelectTriggerClass}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent
              className={workspaceSettingsSelectContentClass}
              style={{ zIndex: "var(--z-panel-popover)" }}
            >
              <SelectItem value={CUSTOM_MANAGED_MODEL_PROVIDER_PRESET}>
                {t("workspace.settings.apps.managedModels.customProvider")}
              </SelectItem>
              {presets.map((preset) => (
                <SelectItem key={preset.baseUrl} value={preset.baseUrl}>
                  {t(preset.labelKey)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
      ) : null}

      <div className="grid grid-cols-2 gap-3 max-[640px]:grid-cols-1">
        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium text-[var(--text-secondary)]">
            {t("workspace.settings.apps.managedModels.apiKey")}
          </span>
          <div className="relative">
            <input
              className={`${workspaceSettingsInputClass} pr-9`}
              placeholder={
                draft.hasApiKey
                  ? t("workspace.settings.apps.managedModels.keepExistingKey")
                  : "sk-..."
              }
              spellCheck={false}
              type={apiKeyVisible ? "text" : "password"}
              value={draft.apiKey}
              onChange={(event) =>
                onUpdate({ apiKey: event.currentTarget.value })
              }
            />
            <button
              aria-label={t(
                apiKeyVisible
                  ? "workspace.settings.apps.managedModels.hideApiKey"
                  : "workspace.settings.apps.managedModels.showApiKey"
              )}
              aria-pressed={apiKeyVisible}
              className={cn(
                "absolute right-1 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-[5px] text-[var(--text-secondary)] transition-colors duration-150 hover:bg-[var(--transparency-hover)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-focus)]",
                apiKeyVisible && "text-[var(--text-primary)]"
              )}
              type="button"
              onClick={() =>
                setVisibleAPIKeyProviderID((currentProviderID) =>
                  currentProviderID === draft.provider ? null : draft.provider
                )
              }
            >
              <EyeIcon aria-hidden="true" size={16} />
            </button>
          </div>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium text-[var(--text-secondary)]">
            {t("workspace.settings.apps.managedModels.baseUrl")}
          </span>
          <input
            className={workspaceSettingsInputClass}
            placeholder={defaultManagedProviderBaseUrl(draft.provider)}
            type="url"
            value={draft.baseUrl ?? ""}
            onChange={(event) =>
              onUpdate({ baseUrl: event.currentTarget.value })
            }
          />
        </label>
      </div>

      <div className="flex flex-col gap-3">
        {apiKeyUrl ? (
          <button
            className="inline-flex w-fit items-center gap-1.5 rounded-[5px] text-left text-[12px] font-medium text-[var(--text-primary)] transition-opacity duration-150 hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-focus)]"
            type="button"
            onClick={() => {
              window.open(apiKeyUrl, "_blank", "noopener,noreferrer");
            }}
          >
            {t("workspace.settings.apps.managedModels.getApiKey", {
              provider:
                (apiKeyPreset ? t(apiKeyPreset.labelKey) : null) ??
                managedModelProviderLabels[draft.provider]
            })}
            <OpenLinkLinedIcon aria-hidden="true" size={13} />
          </button>
        ) : null}
        <div aria-hidden="true" className="h-px w-full bg-[var(--border-1)]" />
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-medium text-[var(--text-secondary)]">
            {t("workspace.settings.apps.managedModels.models")}
          </span>
          {onDetect ? (
            <Button
              className="h-auto px-0 text-[12px] font-medium text-[var(--text-primary)] hover:bg-transparent hover:text-[var(--text-primary)]"
              disabled={detecting}
              size="sm"
              type="button"
              variant="ghost"
              onClick={onDetect}
            >
              {detecting
                ? t("workspace.settings.apps.managedModels.detectingModels")
                : t("workspace.settings.apps.managedModels.detectModels")}
            </Button>
          ) : null}
        </div>
        <div className="flex flex-col gap-1.5">
          {draft.models.map((model, index) => (
            <div
              key={`${model.provider}:${model.id}:${index}`}
              className="grid grid-cols-[max-content_minmax(0,1fr)_32px] items-center gap-1.5"
            >
              <span className={workspaceManagedModelProviderPrefixClass}>
                {draft.provider}:
              </span>
              <input
                aria-label={t("workspace.settings.apps.managedModels.modelId")}
                className={workspaceManagedModelInputClass}
                placeholder={
                  model.id
                    ? defaultManagedProviderModel(draft.provider)
                    : t(
                        "workspace.settings.apps.managedModels.modelIdPlaceholder"
                      )
                }
                ref={(input) => {
                  if (input) {
                    modelInputRefs.current.set(index, input);
                    return;
                  }
                  modelInputRefs.current.delete(index);
                }}
                value={model.id}
                onChange={(event) => {
                  const id = event.currentTarget.value;
                  updateModels(
                    draft.models.map((row, rowIndex) =>
                      rowIndex === index
                        ? { ...row, id, name: id.trim() || row.name }
                        : row
                    )
                  );
                }}
              />
              <button
                aria-label={t(
                  "workspace.settings.apps.managedModels.removeModel"
                )}
                className="flex size-8 items-center justify-center rounded-[6px] text-[var(--text-secondary)] transition-colors duration-150 hover:bg-[var(--transparency-hover)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-focus)]"
                type="button"
                onClick={() =>
                  updateModels(
                    draft.models.filter((_, rowIndex) => rowIndex !== index)
                  )
                }
              >
                <DeleteIcon aria-hidden="true" size={15} />
              </button>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function WorkspaceDeveloperSettingsSection({
  analyticsDebugAvailable,
  analyticsDebugEnabled,
  appCatalogChannel,
  changingAppCatalogChannel,
  developerLogs,
  developerPanelVisible,
  fileDefaultOpenersByExtension,
  showAppDeveloperSources,
  onAnalyticsDebugEnabledChange,
  onAppCatalogChannelChange,
  onClearConversationHistory,
  onClearLogs,
  onDeveloperPanelVisibleChange,
  onExportLogs,
  onFileDefaultOpenersChange,
  onShowAppDeveloperSourcesChange
}: {
  analyticsDebugAvailable: boolean;
  analyticsDebugEnabled: boolean;
  appCatalogChannel: DesktopAppCatalogChannel;
  changingAppCatalogChannel: DesktopAppCatalogChannel | null;
  developerLogs: WorkspaceSettingsDeveloperLogsSnapshotState;
  developerPanelVisible: boolean;
  fileDefaultOpenersByExtension: DesktopFileDefaultOpenersByExtension;
  showAppDeveloperSources: boolean;
  onAnalyticsDebugEnabledChange: (enabled: boolean) => void;
  onAppCatalogChannelChange: (channel: DesktopAppCatalogChannel) => void;
  onClearConversationHistory: () => void;
  onClearLogs: () => void;
  onDeveloperPanelVisibleChange: (visible: boolean) => void;
  onExportLogs: () => void;
  onFileDefaultOpenersChange: (
    openersByExtension: DesktopFileDefaultOpenersByExtension
  ) => void;
  onShowAppDeveloperSourcesChange: (show: boolean) => void;
}) {
  const { t } = useTranslation();
  const logs = developerLogs.logs;
  const [newExtension, setNewExtension] = useState("");
  const [newOpener, setNewOpener] =
    useState<DesktopFileDefaultOpener>("fileViewer");
  const normalizedNewExtension = normalizeDesktopFileExtension(newExtension);
  const fileDefaultOpeners = Object.entries(fileDefaultOpenersByExtension).sort(
    ([left], [right]) => left.localeCompare(right)
  );
  const canAddFileDefaultOpener =
    normalizedNewExtension !== null &&
    fileDefaultOpenersByExtension[normalizedNewExtension] === undefined;

  return (
    <SettingsRows>
      <div className="flex w-full items-center justify-between gap-4 max-[560px]:flex-col max-[560px]:items-stretch">
        <div className="flex min-w-0 flex-1 flex-col gap-1 max-[560px]:w-full">
          <strong className="text-[13px] font-semibold text-[var(--text-primary)]">
            {t("workspace.settings.developer.visibilityLabel")}
          </strong>
          <p className="m-0 text-[13px] leading-[1.3] text-[var(--text-secondary)]">
            {t("workspace.settings.developer.visibilityDescription")}
          </p>
        </div>
        <Switch
          aria-label={t("workspace.settings.developer.visibilityLabel")}
          checked={developerPanelVisible}
          onCheckedChange={onDeveloperPanelVisibleChange}
        />
      </div>

      <AppCatalogChannelControl
        appCatalogChannel={appCatalogChannel}
        changingAppCatalogChannel={changingAppCatalogChannel}
        onAppCatalogChannelChange={onAppCatalogChannelChange}
      />

      <div className="flex w-full items-center justify-between gap-4 max-[560px]:flex-col max-[560px]:items-stretch">
        <div className="flex min-w-0 flex-1 flex-col gap-1 max-[560px]:w-full">
          <strong className="text-[13px] font-semibold text-[var(--text-primary)]">
            {t("workspace.settings.developer.showAppDeveloperSourcesLabel")}
          </strong>
          <p className="m-0 text-[13px] leading-[1.3] text-[var(--text-secondary)]">
            {t(
              "workspace.settings.developer.showAppDeveloperSourcesDescription"
            )}
          </p>
        </div>
        <Switch
          aria-label={t(
            "workspace.settings.developer.showAppDeveloperSourcesLabel"
          )}
          checked={showAppDeveloperSources}
          onCheckedChange={onShowAppDeveloperSourcesChange}
        />
      </div>

      {analyticsDebugAvailable ? (
        <div className="flex w-full items-center justify-between gap-4 max-[560px]:flex-col max-[560px]:items-stretch">
          <div className="flex min-w-0 flex-1 flex-col gap-1 max-[560px]:w-full">
            <strong className="text-[13px] font-semibold text-[var(--text-primary)]">
              {t("workspace.settings.developer.analyticsDebugLabel")}
            </strong>
            <p className="m-0 text-[13px] leading-[1.3] text-[var(--text-secondary)]">
              {t("workspace.settings.developer.analyticsDebugDescription")}
            </p>
          </div>
          <Switch
            aria-label={t("workspace.settings.developer.analyticsDebugLabel")}
            checked={analyticsDebugEnabled}
            onCheckedChange={onAnalyticsDebugEnabledChange}
          />
        </div>
      ) : null}

      <div className="flex w-full flex-col gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <strong className="text-[13px] font-semibold text-[var(--text-primary)]">
            {t("workspace.settings.developer.fileDefaultOpenersLabel")}
          </strong>
          <p className="m-0 text-[13px] leading-[1.3] text-[var(--text-secondary)]">
            {t("workspace.settings.developer.fileDefaultOpenersDescription")}
          </p>
        </div>
        <div className="grid gap-2">
          {fileDefaultOpeners.map(([extension, opener]) => (
            <div
              key={extension}
              className="grid grid-cols-[minmax(70px,0.7fr)_minmax(130px,1fr)_auto] items-center gap-2 max-[560px]:grid-cols-[1fr]"
            >
              <span className="min-w-0 truncate text-[13px] text-[var(--text-primary)]">
                .{extension}
              </span>
              <Select
                value={opener}
                onValueChange={(value) => {
                  onFileDefaultOpenersChange({
                    ...fileDefaultOpenersByExtension,
                    [extension]: value as DesktopFileDefaultOpener
                  });
                }}
              >
                <SelectTrigger
                  aria-label={t(
                    "workspace.settings.developer.fileDefaultOpenerActionLabel",
                    { extension }
                  )}
                  className={workspaceSettingsSelectTriggerClass}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent
                  className={workspaceSettingsSelectContentClass}
                  style={{ zIndex: "var(--z-panel-popover)" }}
                >
                  {desktopFileDefaultOpeners.map((candidate) => (
                    <SelectItem key={candidate} value={candidate}>
                      {t(workspaceSettingsFileDefaultOpenerLabelKey(candidate))}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                aria-label={t(
                  "workspace.settings.developer.removeFileDefaultOpener",
                  { extension }
                )}
                variant="ghost"
                type="button"
                onClick={() => {
                  const { [extension]: _removed, ...remaining } =
                    fileDefaultOpenersByExtension;
                  onFileDefaultOpenersChange(remaining);
                }}
              >
                <DeleteIcon className="size-3.5" />
              </Button>
            </div>
          ))}
          <div className="grid grid-cols-[minmax(70px,0.7fr)_minmax(130px,1fr)_auto] items-center gap-2 max-[560px]:grid-cols-[1fr]">
            <Input
              aria-label={t(
                "workspace.settings.developer.fileDefaultOpenerExtensionLabel"
              )}
              className={workspaceSettingsInputClass}
              placeholder={t(
                "workspace.settings.developer.fileDefaultOpenerExtensionPlaceholder"
              )}
              value={newExtension}
              onChange={(event) => {
                setNewExtension(event.currentTarget.value);
              }}
            />
            <Select
              value={newOpener}
              onValueChange={(value) => {
                setNewOpener(value as DesktopFileDefaultOpener);
              }}
            >
              <SelectTrigger
                aria-label={t(
                  "workspace.settings.developer.fileDefaultOpenerNewActionLabel"
                )}
                className={workspaceSettingsSelectTriggerClass}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent
                className={workspaceSettingsSelectContentClass}
                style={{ zIndex: "var(--z-panel-popover)" }}
              >
                {desktopFileDefaultOpeners.map((candidate) => (
                  <SelectItem key={candidate} value={candidate}>
                    {t(workspaceSettingsFileDefaultOpenerLabelKey(candidate))}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              disabled={!canAddFileDefaultOpener}
              variant="secondary"
              type="button"
              onClick={() => {
                if (!normalizedNewExtension) {
                  return;
                }
                onFileDefaultOpenersChange({
                  ...fileDefaultOpenersByExtension,
                  [normalizedNewExtension]: newOpener
                });
                setNewExtension("");
              }}
            >
              <AddIcon className="size-3.5" />
              {t("workspace.settings.developer.addFileDefaultOpener")}
            </Button>
          </div>
        </div>
      </div>

      <SettingsRow label={t("workspace.settings.developer.logsSizeLabel")}>
        <p className="m-0 text-right text-[13px] leading-5 text-[var(--text-secondary)] max-[560px]:text-left">
          {developerLogs.loading || logs === null
            ? t("common.loading")
            : t("workspace.settings.developer.logsSummary", {
                count: String(logs.totalFiles),
                size: formatWorkspaceSettingsBytes(logs.totalSizeBytes)
              })}
        </p>
      </SettingsRow>

      <SettingsRow label={t("workspace.settings.developer.actionsLabel")}>
        <div className="flex flex-wrap justify-end gap-2 max-[560px]:justify-start">
          <Button
            variant="secondary"
            type="button"
            onClick={onExportLogs}
            disabled={developerLogs.exporting}
          >
            {developerLogs.exporting
              ? t("workspace.settings.developer.exportingLogs")
              : t("workspace.settings.developer.exportLogs")}
          </Button>
          <Button
            variant="secondary"
            type="button"
            onClick={onClearLogs}
            disabled={developerLogs.clearing || developerLogs.exporting}
          >
            {developerLogs.clearing
              ? t("workspace.settings.developer.clearingLogs")
              : t("workspace.settings.developer.clearLogs")}
          </Button>
          <Button
            variant="secondary"
            type="button"
            onClick={onClearConversationHistory}
            disabled={developerLogs.clearingConversationHistory}
          >
            <DeleteIcon className="size-3.5" />
            {developerLogs.clearingConversationHistory
              ? t("workspace.settings.developer.clearingConversationHistory")
              : t("workspace.settings.developer.clearConversationHistory")}
          </Button>
        </div>
      </SettingsRow>
    </SettingsRows>
  );
}

function AppCatalogChannelControl({
  appCatalogChannel,
  changingAppCatalogChannel,
  onAppCatalogChannelChange
}: {
  appCatalogChannel: DesktopAppCatalogChannel;
  changingAppCatalogChannel: DesktopAppCatalogChannel | null;
  onAppCatalogChannelChange: (channel: DesktopAppCatalogChannel) => void;
}) {
  const { t } = useTranslation();
  const effectiveAppCatalogChannel =
    changingAppCatalogChannel ?? appCatalogChannel;

  return (
    <div className="flex w-full items-center justify-between gap-4 max-[560px]:flex-col max-[560px]:items-stretch">
      <div className="flex min-w-0 flex-1 flex-col gap-1 max-[560px]:w-full">
        <strong className="text-[13px] font-semibold text-[var(--text-primary)]">
          {t("workspace.settings.apps.appCatalogChannelLabel")}
        </strong>
        <p className="m-0 text-[13px] leading-[1.3] text-[var(--text-secondary)]">
          {t("workspace.settings.apps.appCatalogChannelDescription")}
        </p>
      </div>
      <div
        aria-label={t("workspace.settings.apps.appCatalogChannelLabel")}
        className="grid h-8 shrink-0 grid-cols-2 overflow-hidden rounded-[6px] bg-[var(--transparency-block)] p-0.5"
        role="group"
      >
        {desktopAppCatalogChannels.map((channel) => {
          const selected = effectiveAppCatalogChannel === channel;
          return (
            <button
              key={channel}
              aria-pressed={selected}
              className={cn(
                "min-w-[92px] rounded-[5px] border-0 px-3 text-[13px] font-semibold leading-none outline-none transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--border-focus)]",
                selected
                  ? "bg-[var(--background-fronted)] text-[var(--text-primary)] shadow-sm"
                  : "bg-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              )}
              disabled={changingAppCatalogChannel !== null}
              type="button"
              onClick={() => onAppCatalogChannelChange(channel)}
            >
              {t(workspaceSettingsAppCatalogChannelOptionLabelKey(channel))}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function workspaceSettingsAppCatalogChannelOptionLabelKey(
  channel: DesktopAppCatalogChannel
): DesktopI18nKey {
  switch (channel) {
    case "production":
      return "workspace.settings.apps.appCatalogChannelOptions.production";
    case "staging":
      return "workspace.settings.apps.appCatalogChannelOptions.staging";
  }
}

function workspaceSettingsMinimizeAnimationOptionLabelKey(
  animation: DesktopMinimizeAnimation
): DesktopI18nKey {
  switch (animation) {
    case "scale":
      return "workspace.settings.appearance.minimizeAnimationOptions.scale";
    case "genie":
      return "workspace.settings.appearance.minimizeAnimationOptions.genie";
    case "off":
      return "workspace.settings.appearance.minimizeAnimationOptions.off";
  }
}

function workspaceSettingsWindowSnappingShortcutLabelKey(
  preset: DesktopWorkbenchWindowSnappingShortcutPreset
): DesktopI18nKey {
  switch (preset) {
    case "commandArrows":
      return "workspace.settings.appearance.workbenchWindowSnappingShortcutOptions.commandArrows";
    case "commandShiftArrows":
      return "workspace.settings.appearance.workbenchWindowSnappingShortcutOptions.commandShiftArrows";
  }
}

type WorkspaceSettingsWindowSnappingSelectValue =
  | "off"
  | DesktopWorkbenchWindowSnappingShortcutPreset;

function workspaceSettingsFileDefaultOpenerLabelKey(
  opener: DesktopFileDefaultOpener
): DesktopI18nKey {
  return `workspace.settings.developer.fileDefaultOpenerOptions.${opener}`;
}

function WorkspaceSettingsPanelPortal({
  children,
  dialogOpen,
  onClose
}: {
  children: React.ReactNode;
  dialogOpen: boolean;
  onClose: () => void;
}) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !dialogOpen) {
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [dialogOpen, onClose]);

  const panel = (
    <div
      className="fixed inset-0 grid place-items-center bg-[var(--backdrop)] supports-backdrop-filter:backdrop-blur-sm transition-[background] duration-[180ms] ease-[cubic-bezier(0.22,1,0.36,1)] [-webkit-app-region:no-drag] motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-[180ms] motion-safe:ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:animate-none"
      data-workspace-settings-backdrop="true"
      style={{ zIndex: "var(--z-panel)" }}
      onClick={onClose}
    >
      <div
        aria-hidden="true"
        className="pointer-events-auto absolute inset-x-0 top-0 z-0 h-[52px] [-webkit-app-region:drag]"
        data-workspace-settings-window-drag-region="true"
      />
      {children}
    </div>
  );

  if (typeof document === "undefined") {
    return panel;
  }

  return createPortal(panel, document.body);
}

function SettingsRows({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex w-full flex-col gap-8 pb-[22px] pt-5">{children}</div>
  );
}

function SettingsRow({
  children,
  label,
  valueClassName
}: {
  children: React.ReactNode;
  label: string;
  valueClassName?: string;
}) {
  return (
    <div className="flex w-full items-center justify-between gap-4 max-[560px]:flex-col max-[560px]:items-stretch">
      <div className="min-w-0">
        <strong className="text-[13px] font-semibold text-[var(--text-primary)]">
          {label}
        </strong>
      </div>
      <div
        className={cn(
          "flex min-w-0 justify-end max-[560px]:justify-start",
          valueClassName
        )}
      >
        {children}
      </div>
    </div>
  );
}

function ComputerUseSetupRow({
  anchorRef,
  attentionRequestID
}: {
  anchorRef?: React.Ref<HTMLDivElement>;
  attentionRequestID: number;
}) {
  const { t } = useTranslation();
  const { service: settingsService } = useWorkspaceSettingsService();
  const [status, setStatus] = useState<
    "idle" | "checking" | "installed" | "not-installed"
  >("idle");
  const [computerUseStatus, setComputerUseStatus] =
    useState<DesktopComputerUseStatus | null>(null);
  const [operation, setOperation] = useState<
    "grant" | "install" | "uninstall" | null
  >(null);
  const [operationProgress, setOperationProgress] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [attentionActive, setAttentionActive] = useState(false);
  const handledAttentionRequestRef = useRef(0);

  const operationRunning = operation !== null;

  useEffect(() => {
    if (!operationRunning) {
      return;
    }
    const timer = window.setInterval(() => {
      setOperationProgress((current) =>
        nextComputerUseOperationProgress(current)
      );
    }, 180);
    return () => {
      window.clearInterval(timer);
    };
  }, [operationRunning]);

  const checkStatus = useCallback(
    async (options?: { clearMessage?: boolean; silent?: boolean }) => {
      if (!options?.silent) {
        setStatus("checking");
      }
      if (options?.clearMessage !== false) {
        setMessage(null);
      }
      try {
        const result = await settingsService.checkComputerUseStatus();
        const nextStatus = result.installed ? "installed" : "not-installed";
        setComputerUseStatus(result);
        setStatus(nextStatus);
        return result;
      } catch {
        const fallbackStatus: DesktopComputerUseStatus = {
          installed: false,
          permissions: null
        };
        setComputerUseStatus(fallbackStatus);
        setStatus("not-installed");
        return fallbackStatus;
      }
    },
    [settingsService]
  );

  useEffect(() => {
    void checkStatus();
  }, [checkStatus]);

  const handleInstall = async () => {
    setOperation("install");
    setOperationProgress(8);
    setMessage(null);
    try {
      const currentStatus = await checkStatus({
        clearMessage: false,
        silent: true
      });
      if (currentStatus.installed) {
        setOperationProgress(100);
        await delay(computerUseOperationSettleMs);
        setMessage(null);
        return;
      }
      const result = await settingsService.installComputerUse();
      setOperationProgress(100);
      await delay(computerUseOperationSettleMs);
      if (result.success) {
        await checkStatus({ clearMessage: false });
        setMessage(null);
      } else {
        setMessage(t("workspace.settings.general.computerUseInstallFailed"));
      }
    } catch {
      setMessage(t("workspace.settings.general.computerUseInstallFailed"));
    } finally {
      setOperation(null);
      setOperationProgress(0);
    }
  };

  const handleUninstall = async () => {
    setOperation("uninstall");
    setOperationProgress(8);
    setMessage(null);
    try {
      const currentStatus = await checkStatus({
        clearMessage: false,
        silent: true
      });
      if (!currentStatus.installed) {
        setOperationProgress(100);
        await delay(computerUseOperationSettleMs);
        setMessage(null);
        return;
      }
      const result = await settingsService.uninstallComputerUse();
      setOperationProgress(100);
      await delay(computerUseOperationSettleMs);
      if (result.success) {
        await checkStatus({ clearMessage: false });
        setMessage(null);
      } else {
        setMessage(t("workspace.settings.general.computerUseUninstallFailed"));
      }
    } catch {
      setMessage(t("workspace.settings.general.computerUseUninstallFailed"));
    } finally {
      setOperation(null);
      setOperationProgress(0);
    }
  };

  const handleGrant = async () => {
    setOperation("grant");
    setOperationProgress(8);
    setMessage(null);
    try {
      const currentStatus = await checkStatus({
        clearMessage: false,
        silent: true
      });
      if (!currentStatus.installed) {
        setOperationProgress(100);
        await delay(computerUseOperationSettleMs);
        setMessage(null);
        return;
      }
      const result = await settingsService.grantComputerUsePermissions();
      if (result.success) {
        setOperationProgress(100);
        await delay(computerUseOperationSettleMs);
        await checkStatus({ clearMessage: false });
        setMessage(null);
      } else {
        setMessage(t("workspace.settings.general.computerUseGrantFailed"));
      }
    } catch {
      setMessage(t("workspace.settings.general.computerUseGrantFailed"));
    } finally {
      setOperation(null);
      setOperationProgress(0);
    }
  };

  useEffect(() => {
    if (
      attentionRequestID === 0 ||
      handledAttentionRequestRef.current === attentionRequestID ||
      status === "idle" ||
      status === "checking"
    ) {
      return;
    }

    handledAttentionRequestRef.current = attentionRequestID;
    if (
      status !== "not-installed" &&
      (status !== "installed" ||
        isComputerUseFullyAuthorized(computerUseStatus))
    ) {
      return;
    }

    const timers = [
      window.setTimeout(() => setAttentionActive(true), 80),
      window.setTimeout(() => setAttentionActive(false), 440),
      window.setTimeout(() => setAttentionActive(true), 680),
      window.setTimeout(() => setAttentionActive(false), 1040)
    ];
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      setAttentionActive(false);
    };
  }, [attentionRequestID, status, computerUseStatus]);

  const grantTooltip = resolveComputerUseGrantTooltip(computerUseStatus, t);
  const grantLabel =
    operation === "grant"
      ? t("workspace.settings.general.computerUseGranting")
      : isComputerUseFullyAuthorized(computerUseStatus)
        ? t("workspace.settings.general.computerUseAuthorizedButton")
        : t("workspace.settings.general.computerUseGrantButton");

  return (
    <div
      ref={anchorRef}
      className="relative isolate flex w-full items-center justify-between gap-4 outline-none max-[560px]:flex-col max-[560px]:items-stretch"
      data-workspace-settings-anchor="computer-use"
      tabIndex={-1}
    >
      <div
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute -inset-x-3 -inset-y-2 z-0 rounded-[8px] transition-colors duration-200",
          attentionActive
            ? "bg-[color-mix(in_srgb,var(--state-warning)_16%,transparent)]"
            : "bg-transparent"
        )}
      />
      <div className="relative z-[1] flex min-w-0 flex-1 flex-col gap-1 max-[560px]:w-full">
        <strong className="text-[13px] font-semibold text-[var(--text-primary)]">
          {t("workspace.settings.general.computerUseLabel")}
        </strong>
        <p className="m-0 text-[13px] leading-[1.3] text-[var(--text-secondary)]">
          {t("workspace.settings.general.computerUseDescription")}
        </p>
        {message && (
          <p className="m-0 mt-1 text-[13px] leading-[1.3] text-[var(--text-secondary)]">
            {message}
          </p>
        )}
      </div>
      <div
        className={cn(
          "relative z-[1] flex items-center justify-end gap-2",
          workspaceSettingsControlColumnClass
        )}
      >
        {(status === "checking" || status === "idle") && (
          <WorkspaceSettingsActionButton
            className="flex-1"
            disabled
            label={t("common.loading")}
          />
        )}
        {status === "not-installed" && (
          <WorkspaceSettingsActionButton
            className="flex-1"
            disabled={operationRunning}
            label={
              operation === "install"
                ? t("workspace.settings.general.computerUseInstalling")
                : t("workspace.settings.general.computerUseInstallButton")
            }
            progress={operation === "install" ? operationProgress : null}
            progressAriaLabel={t(
              "workspace.settings.general.computerUseProgressAria"
            )}
            onClick={() => {
              void handleInstall();
            }}
          />
        )}
        {status === "installed" && (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <WorkspaceSettingsActionButton
                  className="flex-1"
                  disabled={operationRunning}
                  label={grantLabel}
                  progress={operation === "grant" ? operationProgress : null}
                  progressAriaLabel={t(
                    "workspace.settings.general.computerUseProgressAria"
                  )}
                  onClick={() => {
                    void handleGrant();
                  }}
                />
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-[260px]">
                {grantTooltip}
              </TooltipContent>
            </Tooltip>
            <WorkspaceSettingsActionButton
              className="flex-1"
              disabled={operationRunning}
              label={
                operation === "uninstall"
                  ? t("workspace.settings.general.computerUseUninstalling")
                  : t("workspace.settings.general.computerUseUninstallButton")
              }
              progress={operation === "uninstall" ? operationProgress : null}
              progressAriaLabel={t(
                "workspace.settings.general.computerUseProgressAria"
              )}
              variant="destructive"
              onClick={() => {
                void handleUninstall();
              }}
            />
          </>
        )}
      </div>
    </div>
  );
}

function nextComputerUseOperationProgress(current: number): number {
  if (current >= 94) {
    return current;
  }
  if (current < 45) {
    return Math.min(45, current + 8);
  }
  if (current < 76) {
    return Math.min(76, current + 4);
  }
  return Math.min(94, current + 2);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function isComputerUseFullyAuthorized(
  status: DesktopComputerUseStatus | null
): boolean {
  const permissions = status?.permissions;
  return Boolean(
    status?.installed &&
    permissions?.source === "driver-daemon" &&
    permissions.accessibility === true &&
    permissions.screenRecording === true &&
    permissions.screenRecordingCapturable === true
  );
}

function resolveComputerUseGrantTooltip(
  status: DesktopComputerUseStatus | null,
  t: ReturnType<typeof useTranslation>["t"]
): string {
  if (isComputerUseFullyAuthorized(status)) {
    return t("workspace.settings.general.computerUseAuthorizedTooltip");
  }
  const permissions = status?.permissions;
  if (!permissions || permissions.source !== "driver-daemon") {
    return t("workspace.settings.general.computerUsePermissionUnknownTooltip");
  }

  const missingPermissions: string[] = [];
  if (permissions.accessibility !== true) {
    missingPermissions.push(
      t("workspace.settings.general.computerUsePermissionAccessibility")
    );
  }
  if (
    permissions.screenRecording !== true ||
    permissions.screenRecordingCapturable !== true
  ) {
    missingPermissions.push(
      t("workspace.settings.general.computerUsePermissionScreenRecording")
    );
  }

  return t("workspace.settings.general.computerUsePermissionMissingTooltip", {
    permissions: missingPermissions.join(
      t("workspace.settings.general.computerUsePermissionListSeparator")
    )
  });
}

function WorkspaceAgentSettingsSection({
  agentConversationDetailMode,
  browserUseConnectionMode,
  changingAgentConversationDetailMode,
  changingDefaultAgentProvider,
  changingBrowserUseConnectionMode,
  defaultAgentProvider,
  focusedAnchor,
  focusRequestID,
  onAgentConversationDetailModeChange,
  onDefaultAgentProviderChange,
  onBrowserUseConnectionModeChange,
  onOpenExternalAgentImport
}: {
  agentConversationDetailMode: DesktopAgentConversationDetailMode;
  browserUseConnectionMode: DesktopBrowserUseConnectionMode;
  changingAgentConversationDetailMode: DesktopAgentConversationDetailMode | null;
  changingDefaultAgentProvider: DesktopAgentProvider | null;
  changingBrowserUseConnectionMode: DesktopBrowserUseConnectionMode | null;
  defaultAgentProvider: DesktopAgentProvider;
  focusedAnchor: WorkspaceSettingsGeneralFocusAnchor | null;
  focusRequestID: number;
  onAgentConversationDetailModeChange: (
    mode: DesktopAgentConversationDetailMode
  ) => void;
  onBrowserUseConnectionModeChange: (
    mode: DesktopBrowserUseConnectionMode
  ) => void;
  onDefaultAgentProviderChange: (provider: DesktopAgentProvider) => void;
  onOpenExternalAgentImport: () => void;
}) {
  const { t } = useTranslation();
  const browserUseRowRef = useRef<HTMLDivElement | null>(null);
  const computerUseRowRef = useRef<HTMLDivElement | null>(null);
  const isUpdatingDefaultAgentProvider = changingDefaultAgentProvider !== null;
  const rawPendingDefaultAgentProvider =
    changingDefaultAgentProvider ?? defaultAgentProvider;
  const pendingDefaultAgentProvider = isWorkspaceSettingsDefaultAgentProvider(
    rawPendingDefaultAgentProvider
  )
    ? rawPendingDefaultAgentProvider
    : "codex";
  const isUpdatingBrowserUseConnectionMode =
    changingBrowserUseConnectionMode !== null;
  const pendingBrowserUseConnectionMode =
    changingBrowserUseConnectionMode ?? browserUseConnectionMode;
  const isUpdatingAgentConversationDetailMode =
    changingAgentConversationDetailMode !== null;
  const pendingAgentConversationDetailMode =
    changingAgentConversationDetailMode ?? agentConversationDetailMode;

  useEffect(() => {
    if (!focusedAnchor || focusRequestID === 0) {
      return;
    }
    const target =
      focusedAnchor === "computer-use"
        ? computerUseRowRef.current
        : browserUseRowRef.current;
    target?.scrollIntoView({ block: "center", behavior: "smooth" });
    target?.focus({ preventScroll: true });
  }, [focusedAnchor, focusRequestID]);

  return (
    <div className="flex flex-col gap-8 pb-[22px] pt-5">
      <div className="flex w-full flex-col gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <strong className="text-[13px] font-semibold text-[var(--text-primary)]">
            {t("workspace.settings.general.agentConversationDetailModeLabel")}
          </strong>
        </div>
        <div
          aria-label={t(
            "workspace.settings.general.agentConversationDetailModeLabel"
          )}
          className="grid w-full grid-cols-2 gap-2 max-[430px]:grid-cols-1"
          role="radiogroup"
        >
          {desktopAgentConversationDetailModes.map((mode) => {
            const selected = pendingAgentConversationDetailMode === mode;
            return (
              <button
                key={mode}
                aria-checked={selected}
                className={cn(
                  "flex min-h-[72px] min-w-0 flex-col items-start justify-center gap-1 rounded-[8px] border-solid px-3 py-2.5 text-left transition-colors duration-150 disabled:cursor-default disabled:opacity-70",
                  selected
                    ? "border border-[var(--tutti-purple)] bg-[var(--background-fronted)] text-[var(--text-primary)]"
                    : "border border-[var(--border-1)] bg-[var(--transparency-block)] text-[var(--text-primary)] hover:bg-[var(--transparency-hover)]"
                )}
                disabled={isUpdatingAgentConversationDetailMode}
                role="radio"
                type="button"
                onClick={() => onAgentConversationDetailModeChange(mode)}
              >
                <span className="text-[13px] font-semibold leading-[1.25]">
                  {mode === "coding"
                    ? t(
                        "workspace.settings.general.agentConversationDetailModeOptions.codingTitle"
                      )
                    : t(
                        "workspace.settings.general.agentConversationDetailModeOptions.generalTitle"
                      )}
                </span>
                <span className="text-[12px] leading-[1.3] text-[var(--text-secondary)]">
                  {mode === "coding"
                    ? t(
                        "workspace.settings.general.agentConversationDetailModeOptions.codingDescription"
                      )
                    : t(
                        "workspace.settings.general.agentConversationDetailModeOptions.generalDescription"
                      )}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex w-full items-center justify-between gap-4 max-[560px]:flex-col max-[560px]:items-stretch">
        <div className="flex min-w-0 flex-1 flex-col gap-1 max-[560px]:w-full">
          <strong className="text-[13px] font-semibold text-[var(--text-primary)]">
            {t("workspace.externalImport.settingsLabel")}
          </strong>
          <p className="m-0 text-[13px] leading-[1.3] text-[var(--text-secondary)]">
            {t("workspace.externalImport.settingsDescription")}
          </p>
        </div>
        <div
          className={cn(
            "flex justify-end max-[560px]:justify-start",
            workspaceSettingsControlColumnClass
          )}
        >
          <WorkspaceSettingsActionButton
            icon={<ImportLinedIcon className="size-3.5" />}
            label={t("workspace.externalImport.settingsAction")}
            type="button"
            onClick={onOpenExternalAgentImport}
          />
        </div>
      </div>

      <div className="flex w-full items-center justify-between gap-4 max-[560px]:flex-col max-[560px]:items-stretch">
        <div className="flex min-w-0 flex-1 flex-col gap-1 max-[560px]:w-full">
          <strong className="text-[13px] font-semibold text-[var(--text-primary)]">
            {t("workspace.settings.general.defaultAgentProviderLabel")}
          </strong>
          <p className="m-0 text-[13px] leading-[1.3] text-[var(--text-secondary)]">
            {t("workspace.settings.general.defaultAgentProviderDescription")}
          </p>
        </div>
        <div className="w-[220px] min-w-[220px] max-[560px]:w-full max-[560px]:min-w-0">
          <Select
            disabled={isUpdatingDefaultAgentProvider}
            value={pendingDefaultAgentProvider}
            onValueChange={(value) =>
              onDefaultAgentProviderChange(value as DesktopAgentProvider)
            }
          >
            <SelectTrigger
              aria-label={t(
                "workspace.settings.general.defaultAgentProviderLabel"
              )}
              className={workspaceSettingsSelectTriggerClass}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent
              className={workspaceSettingsSelectContentClass}
              style={{ zIndex: "var(--z-panel-popover)" }}
            >
              {workspaceSettingsDefaultAgentProviders.map((provider) => (
                <SelectItem key={provider} value={provider}>
                  {resolveWorkspaceAgentGuiLabel(provider)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div
        ref={browserUseRowRef}
        className="flex w-full items-center justify-between gap-4 outline-none max-[560px]:flex-col max-[560px]:items-stretch"
        data-workspace-settings-anchor="browser-use"
        tabIndex={-1}
      >
        <div className="flex min-w-0 flex-1 flex-col gap-1 max-[560px]:w-full">
          <strong className="text-[13px] font-semibold text-[var(--text-primary)]">
            {t("workspace.settings.general.browserUseConnectionModeLabel")}
          </strong>
          <p className="m-0 text-[13px] leading-[1.3] text-[var(--text-secondary)]">
            {t(
              "workspace.settings.general.browserUseConnectionModeDescription"
            )}
          </p>
        </div>
        <div className="w-[220px] min-w-[220px] max-[560px]:w-full max-[560px]:min-w-0">
          <Select
            disabled={isUpdatingBrowserUseConnectionMode}
            value={pendingBrowserUseConnectionMode}
            onValueChange={(value) =>
              onBrowserUseConnectionModeChange(
                value as DesktopBrowserUseConnectionMode
              )
            }
          >
            <SelectTrigger
              aria-label={t(
                "workspace.settings.general.browserUseConnectionModeLabel"
              )}
              className={workspaceSettingsSelectTriggerClass}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent
              className={workspaceSettingsSelectContentClass}
              style={{ zIndex: "var(--z-panel-popover)" }}
            >
              {desktopBrowserUseConnectionModes.map((mode) => (
                <Tooltip key={mode}>
                  <TooltipTrigger asChild>
                    <SelectItem value={mode}>
                      {mode === "autoConnect"
                        ? t(
                            "workspace.settings.general.browserUseConnectionModeOptions.autoConnect"
                          )
                        : t(
                            "workspace.settings.general.browserUseConnectionModeOptions.isolated"
                          )}
                    </SelectItem>
                  </TooltipTrigger>
                  <TooltipContent side="left" className="max-w-[260px]">
                    {mode === "autoConnect"
                      ? t(
                          "workspace.settings.general.browserUseConnectionModeOptionHints.autoConnect"
                        )
                      : t(
                          "workspace.settings.general.browserUseConnectionModeOptionHints.isolated"
                        )}
                  </TooltipContent>
                </Tooltip>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <ComputerUseSetupRow
        anchorRef={computerUseRowRef}
        attentionRequestID={
          focusedAnchor === "computer-use" ? focusRequestID : 0
        }
      />
    </div>
  );
}

function WorkspaceGeneralSettingsSection({
  changingLocale,
  changingSleepPreventionMode,
  locale,
  onLocaleChange,
  onSleepPreventionModeChange,
  sleepPreventionMode
}: {
  changingLocale: DesktopLocale | null;
  changingSleepPreventionMode: DesktopSleepPreventionMode | null;
  locale: DesktopLocale;
  onLocaleChange: (locale: DesktopLocale) => void;
  onSleepPreventionModeChange: (mode: DesktopSleepPreventionMode) => void;
  sleepPreventionMode: DesktopSleepPreventionMode;
}) {
  const { t } = useTranslation();
  const agentDiagnosticsReporting = useAgentDiagnosticsConsent();
  const isUpdatingLocale = changingLocale !== null;
  const pendingLocale = changingLocale ?? locale;
  const isUpdatingSleepPrevention = changingSleepPreventionMode !== null;
  const pendingSleepPreventionMode =
    changingSleepPreventionMode ?? sleepPreventionMode;

  return (
    <div className="flex flex-col gap-8 pb-[22px] pt-5">
      <div className="flex w-full items-center justify-between gap-4 max-[560px]:flex-col max-[560px]:items-stretch">
        <div className="flex min-w-0 flex-1 flex-col gap-1 max-[560px]:w-full">
          <strong className="text-[13px] font-semibold text-[var(--text-primary)]">
            {t("workspace.settings.general.preventSleepLabel")}
          </strong>
          <p className="m-0 text-[13px] leading-[1.3] text-[var(--text-secondary)]">
            {t("workspace.settings.general.preventSleepDescription")}
          </p>
        </div>
        <div className="w-[220px] min-w-[220px] max-[560px]:w-full max-[560px]:min-w-0">
          <Select
            disabled={isUpdatingSleepPrevention}
            value={pendingSleepPreventionMode}
            onValueChange={(value) =>
              onSleepPreventionModeChange(value as DesktopSleepPreventionMode)
            }
          >
            <SelectTrigger
              aria-label={t("workspace.settings.general.preventSleepLabel")}
              className={workspaceSettingsSelectTriggerClass}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent
              className={workspaceSettingsSelectContentClass}
              style={{ zIndex: "var(--z-panel-popover)" }}
            >
              {desktopSleepPreventionModes.map((mode) => (
                <SelectItem key={mode} value={mode}>
                  {mode === "never"
                    ? t("workspace.settings.general.preventSleepOptions.never")
                    : mode === "whileAgentRunning"
                      ? t(
                          "workspace.settings.general.preventSleepOptions.whileAgentRunning"
                        )
                      : t(
                          "workspace.settings.general.preventSleepOptions.always"
                        )}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex w-full items-center justify-between gap-4 max-[560px]:flex-col max-[560px]:items-stretch">
        <div className="flex min-w-0 flex-1 flex-col gap-1 max-[560px]:w-full">
          <strong className="text-[13px] font-semibold text-[var(--text-primary)]">
            {t("workspace.settings.general.languageLabel")}
          </strong>
          <p className="m-0 text-[13px] leading-[1.3] text-[var(--text-secondary)]">
            {t("workspace.settings.general.languageDescription")}
          </p>
        </div>
        <div className="w-[220px] min-w-[220px] max-[560px]:w-full max-[560px]:min-w-0">
          <Select
            disabled={isUpdatingLocale}
            value={pendingLocale}
            onValueChange={(value) => onLocaleChange(value as DesktopLocale)}
          >
            <SelectTrigger
              aria-label={t("workspace.settings.general.languageLabel")}
              className={workspaceSettingsSelectTriggerClass}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent
              className={workspaceSettingsSelectContentClass}
              style={{ zIndex: "var(--z-panel-popover)" }}
            >
              {desktopLocales.map((optionLocale) => (
                <SelectItem key={optionLocale} value={optionLocale}>
                  {optionLocale === "en"
                    ? t("workspace.settings.general.languageOptions.en")
                    : t("workspace.settings.general.languageOptions.zhCN")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex w-full items-center justify-between gap-4 max-[560px]:flex-col max-[560px]:items-stretch">
        <div className="flex min-w-0 flex-1 flex-col gap-1 max-[560px]:w-full">
          <strong className="text-[13px] font-semibold text-[var(--text-primary)]">
            {t("workspace.settings.general.agentDiagnosticsReportingLabel")}
          </strong>
          <p className="m-0 text-[13px] leading-[1.3] text-[var(--text-secondary)]">
            {t(
              "workspace.settings.general.agentDiagnosticsReportingDescription"
            )}
          </p>
        </div>
        <Switch
          aria-label={t(
            "workspace.settings.general.agentDiagnosticsReportingLabel"
          )}
          checked={agentDiagnosticsReporting}
          onCheckedChange={setAgentDiagnosticsConsent}
        />
      </div>
    </div>
  );
}

function WorkspaceAboutSettingsSection({
  developerLogs,
  onVersionTap
}: {
  developerLogs: WorkspaceSettingsDeveloperLogsSnapshotState;
  onVersionTap: () => void;
}) {
  const { t } = useTranslation();
  const hostService = useWorkspaceWorkbenchHostService();
  const logs = developerLogs.logs;
  const desktopVersion =
    developerLogs.loading && logs === null
      ? t("common.loading")
      : (logs?.desktopVersion ?? "0.0.0");

  const openExternal = useCallback(
    (url: string) => {
      void hostService.openExternal(url);
    },
    [hostService]
  );

  return (
    <div className="flex w-full flex-col gap-4 px-5 pb-5 pt-7">
      <div className="flex min-w-0 items-center justify-between gap-4 max-[560px]:flex-col max-[560px]:items-start">
        <div className="flex min-w-0 items-center gap-3.5">
          <img
            alt=""
            className="size-14 shrink-0 object-contain"
            draggable={false}
            src={tuttiDesktopIconUrl}
          />
          <div className="min-w-0">
            <strong className="block truncate text-[18px] font-semibold leading-7 text-[var(--text-primary)]">
              {t("workspace.settings.about.appName")}
            </strong>
          </div>
        </div>
        <button
          className="inline-flex h-7 shrink-0 cursor-default select-none items-center gap-1 rounded-full border border-[var(--border-1)] bg-[var(--background-fronted)] px-3 text-[12px] leading-5 text-[var(--text-secondary)] outline-none focus-visible:border-[var(--border-focus)] max-[560px]:ml-[70px]"
          type="button"
          onClick={onVersionTap}
        >
          <span>{t("workspace.settings.about.versionLabel")}</span>
          <span className="font-mono text-[13px] leading-5 text-[var(--text-primary)]">
            {desktopVersion}
          </span>
        </button>
      </div>

      <div className="flex flex-wrap gap-2 border-t border-[var(--border-1)] pt-4">
        <AboutActionButton
          icon={<WebIcon className="size-3.5" />}
          label={t("workspace.settings.about.websiteAction")}
          onClick={() => openExternal(tuttiWebsiteUrl)}
        />
        <AboutActionButton
          icon={<GitHubBrandIcon className="size-3.5" />}
          label={t("workspace.settings.about.githubAction")}
          onClick={() => openExternal(tuttiGitHubUrl)}
        />
      </div>
    </div>
  );
}

function AboutActionButton({
  icon,
  label,
  onClick
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className="inline-flex h-8 items-center gap-1.5 rounded-[6px] border border-[var(--border-1)] bg-[var(--background-fronted)] px-3 text-[13px] font-semibold text-[var(--text-secondary)] outline-none transition-colors duration-150 hover:bg-[var(--transparency-hover)] hover:text-[var(--text-primary)] focus-visible:border-[var(--border-focus)]"
      type="button"
      onClick={onClick}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function WorkspaceAppearanceSettingsSection({
  changingDockPlacement,
  changingMinimizeAnimation,
  changingThemeSource,
  changingWorkbenchWindowSnapping,
  dockPlacement,
  minimizeAnimation,
  onDockPlacementChange,
  onMinimizeAnimationChange,
  onWorkbenchWindowSnappingChange,
  onSelectWallpaper,
  onSelectWallpaperDisplayMode,
  onThemeChange,
  selectedWallpaperDisplayMode,
  selectedWallpaperID,
  themeAppearance,
  themeSource,
  workbenchWindowSnapping
}: {
  changingDockPlacement: DesktopDockPlacement | null;
  changingMinimizeAnimation: DesktopMinimizeAnimation | null;
  changingThemeSource: DesktopThemeSource | null;
  changingWorkbenchWindowSnapping: DesktopWorkbenchWindowSnapping | null;
  dockPlacement: DesktopDockPlacement;
  minimizeAnimation: DesktopMinimizeAnimation;
  onDockPlacementChange: (placement: DesktopDockPlacement) => void;
  onMinimizeAnimationChange: (animation: DesktopMinimizeAnimation) => void;
  onWorkbenchWindowSnappingChange: (
    value: DesktopWorkbenchWindowSnapping
  ) => void;
  onSelectWallpaper: (id: WorkspaceWallpaperId) => void;
  onSelectWallpaperDisplayMode: (
    displayMode: WorkspaceWallpaperDisplayMode
  ) => void;
  onThemeChange: (source: DesktopThemeSource) => void;
  selectedWallpaperDisplayMode: WorkspaceWallpaperDisplayMode;
  selectedWallpaperID: WorkspaceWallpaperId;
  themeAppearance: DesktopThemeAppearance;
  themeSource: DesktopThemeSource;
  workbenchWindowSnapping: DesktopWorkbenchWindowSnapping;
}) {
  const { t } = useTranslation();
  const isUpdatingTheme = changingThemeSource !== null;
  const pendingThemeSource = changingThemeSource ?? themeSource;
  const isUpdatingDockPlacement = changingDockPlacement !== null;
  const pendingDockPlacement = changingDockPlacement ?? dockPlacement;
  const isUpdatingMinimizeAnimation = changingMinimizeAnimation !== null;
  const pendingMinimizeAnimation =
    changingMinimizeAnimation ?? minimizeAnimation;
  const isUpdatingWorkbenchWindowSnapping =
    changingWorkbenchWindowSnapping !== null;
  const pendingWorkbenchWindowSnapping =
    changingWorkbenchWindowSnapping ?? workbenchWindowSnapping;

  return (
    <div className="flex flex-col gap-8 pb-[22px] pt-5">
      <div className="flex w-full items-center justify-between gap-4 max-[560px]:flex-col max-[560px]:items-stretch">
        <div className="flex min-w-0 flex-1 flex-col gap-1 max-[560px]:w-full">
          <strong className="text-[13px] font-semibold text-[var(--text-primary)]">
            {t("workspace.settings.appearance.themeLabel")}
          </strong>
          <p className="m-0 text-[13px] leading-[1.3] text-[var(--text-secondary)]">
            {t("workspace.settings.appearance.themeDescription")}
          </p>
        </div>
        <div className="w-[220px] min-w-[220px] max-[560px]:w-full max-[560px]:min-w-0">
          <Select
            disabled={isUpdatingTheme}
            value={pendingThemeSource}
            onValueChange={(value) =>
              onThemeChange(value as DesktopThemeSource)
            }
          >
            <SelectTrigger
              aria-label={t("workspace.settings.appearance.themeLabel")}
              className={workspaceSettingsSelectTriggerClass}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent
              className={workspaceSettingsSelectContentClass}
              style={{ zIndex: "var(--z-panel-popover)" }}
            >
              {desktopThemeSources.map((optionThemeSource) => (
                <SelectItem key={optionThemeSource} value={optionThemeSource}>
                  {optionThemeSource === "system"
                    ? t("workspace.settings.appearance.themeOptions.system")
                    : optionThemeSource === "light"
                      ? t("workspace.settings.appearance.themeOptions.light")
                      : t("workspace.settings.appearance.themeOptions.dark")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex w-full items-center justify-between gap-4 max-[560px]:flex-col max-[560px]:items-stretch">
        <div className="flex min-w-0 flex-1 flex-col gap-1 max-[560px]:w-full">
          <strong className="text-[13px] font-semibold text-[var(--text-primary)]">
            {t("workspace.settings.appearance.dockPlacementLabel")}
          </strong>
          <p className="m-0 text-[13px] leading-[1.3] text-[var(--text-secondary)]">
            {t("workspace.settings.appearance.dockPlacementDescription")}
          </p>
        </div>
        <div className="w-[220px] min-w-[220px] max-[560px]:w-full max-[560px]:min-w-0">
          <Select
            disabled={isUpdatingDockPlacement}
            value={pendingDockPlacement}
            onValueChange={(value) =>
              onDockPlacementChange(value as DesktopDockPlacement)
            }
          >
            <SelectTrigger
              aria-label={t("workspace.settings.appearance.dockPlacementLabel")}
              className={workspaceSettingsSelectTriggerClass}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent
              className={workspaceSettingsSelectContentClass}
              style={{ zIndex: "var(--z-panel-popover)" }}
            >
              {desktopDockPlacements.map((placement) => (
                <SelectItem key={placement} value={placement}>
                  {placement === "bottom"
                    ? t(
                        "workspace.settings.appearance.dockPlacementOptions.bottom"
                      )
                    : t(
                        "workspace.settings.appearance.dockPlacementOptions.left"
                      )}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex w-full items-center justify-between gap-4 max-[560px]:flex-col max-[560px]:items-stretch">
        <div className="flex min-w-0 flex-1 flex-col gap-1 max-[560px]:w-full">
          <strong className="text-[13px] font-semibold text-[var(--text-primary)]">
            {t("workspace.settings.appearance.minimizeAnimationLabel")}
          </strong>
          <p className="m-0 text-[13px] leading-[1.3] text-[var(--text-secondary)]">
            {t("workspace.settings.appearance.minimizeAnimationDescription")}
          </p>
        </div>
        <div className="w-[220px] min-w-[220px] max-[560px]:w-full max-[560px]:min-w-0">
          <Select
            disabled={isUpdatingMinimizeAnimation}
            value={pendingMinimizeAnimation}
            onValueChange={(value) =>
              onMinimizeAnimationChange(value as DesktopMinimizeAnimation)
            }
          >
            <SelectTrigger
              aria-label={t(
                "workspace.settings.appearance.minimizeAnimationLabel"
              )}
              className={workspaceSettingsSelectTriggerClass}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent
              className={workspaceSettingsSelectContentClass}
              style={{ zIndex: "var(--z-panel-popover)" }}
            >
              {desktopMinimizeAnimations.map((animation) => (
                <SelectItem key={animation} value={animation}>
                  {t(
                    workspaceSettingsMinimizeAnimationOptionLabelKey(animation)
                  )}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex w-full items-start justify-between gap-4 max-[560px]:flex-col max-[560px]:items-stretch">
        <div className="flex min-w-0 flex-1 flex-col gap-1 max-[560px]:w-full">
          <strong className="text-[13px] font-semibold text-[var(--text-primary)]">
            {t("workspace.settings.appearance.workbenchWindowSnappingLabel")}
          </strong>
          <p className="m-0 text-[13px] leading-[1.3] text-[var(--text-secondary)]">
            {t(
              "workspace.settings.appearance.workbenchWindowSnappingDescription"
            )}
          </p>
        </div>
        <div className="w-[220px] min-w-[220px] max-[560px]:w-full max-[560px]:min-w-0">
          <Select
            disabled={isUpdatingWorkbenchWindowSnapping}
            value={
              pendingWorkbenchWindowSnapping.enabled
                ? pendingWorkbenchWindowSnapping.shortcutPreset
                : "off"
            }
            onValueChange={(value) => {
              const nextValue =
                value as WorkspaceSettingsWindowSnappingSelectValue;
              onWorkbenchWindowSnappingChange({
                ...pendingWorkbenchWindowSnapping,
                enabled: nextValue !== "off",
                shortcutPreset:
                  nextValue === "off"
                    ? pendingWorkbenchWindowSnapping.shortcutPreset
                    : nextValue
              });
            }}
          >
            <SelectTrigger
              aria-label={t(
                "workspace.settings.appearance.workbenchWindowSnappingLabel"
              )}
              className={workspaceSettingsSelectTriggerClass}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent
              className={workspaceSettingsSelectContentClass}
              style={{ zIndex: "var(--z-panel-popover)" }}
            >
              <SelectItem value="off">
                {t(
                  "workspace.settings.appearance.workbenchWindowSnappingShortcutOptions.off"
                )}
              </SelectItem>
              {desktopWorkbenchWindowSnappingShortcutPresets.map((preset) => (
                <SelectItem key={preset} value={preset}>
                  {t(workspaceSettingsWindowSnappingShortcutLabelKey(preset))}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid grid-cols-1 items-stretch gap-3">
        <div
          className="flex min-w-0 flex-col gap-1"
          id="workspace-settings-wallpaper-heading"
        >
          <strong className="text-[13px] font-semibold text-[var(--text-primary)]">
            {t("workspace.settings.appearance.wallpaperLabel")}
          </strong>
        </div>
        <WorkspaceWallpaperPicker
          onSelectWallpaper={onSelectWallpaper}
          onSelectWallpaperDisplayMode={onSelectWallpaperDisplayMode}
          selectedWallpaperDisplayMode={selectedWallpaperDisplayMode}
          selectedWallpaperID={selectedWallpaperID}
          themeAppearance={themeAppearance}
        />
      </div>
    </div>
  );
}

const wallpaperTileBaseClass =
  "relative block aspect-[16/10] w-full cursor-pointer overflow-hidden rounded-lg border-0 bg-transparent p-0 text-inherit shadow-none outline-none transition-transform duration-150 hover:-translate-y-0.5 focus-visible:ring-2 focus-visible:ring-[var(--border-focus)]";
const wallpaperTileSelectedClass =
  "before:pointer-events-none before:absolute before:inset-0 before:z-[1] before:rounded-[inherit] before:border-2 before:border-primary before:opacity-0 before:content-['']";

function WorkspaceWallpaperPicker({
  onSelectWallpaper,
  onSelectWallpaperDisplayMode,
  selectedWallpaperDisplayMode,
  selectedWallpaperID,
  themeAppearance
}: {
  onSelectWallpaper: (id: WorkspaceWallpaperId) => void;
  onSelectWallpaperDisplayMode: (
    displayMode: WorkspaceWallpaperDisplayMode
  ) => void;
  selectedWallpaperDisplayMode: WorkspaceWallpaperDisplayMode;
  selectedWallpaperID: WorkspaceWallpaperId;
  themeAppearance: DesktopThemeAppearance;
}) {
  const { t } = useTranslation();
  const hostService = useWorkspaceWorkbenchHostService();
  const customWallpaper = useSyncExternalStore(
    (listener) => hostService.subscribeWallpaperChanges(listener),
    () => hostService.getCustomWallpaperSnapshot(),
    () => hostService.getCustomWallpaperSnapshot()
  );
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const isSaving = customWallpaper.status === "saving";
  const isRemoving = customWallpaper.status === "removing";
  const customSelected = selectedWallpaperID === customWorkspaceWallpaperId;

  const handleFilesSelected = async (
    event: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = event.target.files?.[0] ?? null;
    event.target.value = "";
    if (!file) {
      return;
    }
    setUploadError(null);
    try {
      await hostService.uploadCustomWallpaper(file);
      onSelectWallpaper(customWorkspaceWallpaperId);
    } catch (error) {
      setUploadError(resolveWallpaperUploadErrorMessage(t, error));
    }
  };

  const handleRemoveCustom = async () => {
    setUploadError(null);
    try {
      await hostService.removeCustomWallpaper();
      if (selectedWallpaperID === customWorkspaceWallpaperId) {
        onSelectWallpaper("default");
      }
    } catch {
      setUploadError(t("workspace.settings.appearance.wallpaperRemoveFailed"));
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div
        aria-labelledby="workspace-settings-wallpaper-heading"
        className="grid grid-cols-4 gap-2.5 max-[760px]:grid-cols-3 max-[560px]:grid-cols-2"
        role="listbox"
      >
        {workspaceWallpaperOptions.map((option) => {
          const resolvedOption = getWorkspaceWallpaperOption(
            option.id,
            themeAppearance
          );
          const selected = option.id === selectedWallpaperID;
          return (
            <button
              key={option.id}
              aria-label={t(option.titleKey)}
              aria-selected={selected}
              className={cn(
                wallpaperTileBaseClass,
                wallpaperTileSelectedClass,
                selected && "before:opacity-100"
              )}
              role="option"
              type="button"
              onClick={() => onSelectWallpaper(option.id)}
            >
              <img
                alt=""
                className="block size-full object-cover"
                draggable={false}
                src={resolvedOption.url}
              />
            </button>
          );
        })}

        {customWallpaper.exists && customWallpaper.thumbnailUrl ? (
          <div className="group relative">
            <button
              aria-label={t("workspace.wallpaper.options.custom")}
              aria-selected={customSelected}
              className={cn(
                wallpaperTileBaseClass,
                wallpaperTileSelectedClass,
                customSelected && "before:opacity-100"
              )}
              role="option"
              type="button"
              onClick={() => onSelectWallpaper(customWorkspaceWallpaperId)}
            >
              <img
                alt=""
                className="block size-full object-cover"
                draggable={false}
                src={customWallpaper.thumbnailUrl}
              />
            </button>
            <button
              aria-label={t("workspace.settings.appearance.wallpaperRemove")}
              className="absolute right-1 top-1 z-[2] inline-flex size-5 items-center justify-center rounded-full border-0 bg-black/55 text-white opacity-0 outline-none backdrop-blur-sm transition-opacity duration-150 hover:bg-black/70 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-[var(--border-focus)] group-hover:opacity-100"
              disabled={isRemoving}
              title={t("workspace.settings.appearance.wallpaperRemove")}
              type="button"
              onClick={() => {
                void handleRemoveCustom();
              }}
            >
              {isRemoving ? (
                <LoadingIcon className="size-3 animate-spin" />
              ) : (
                <CloseIcon className="size-3" />
              )}
            </button>
          </div>
        ) : null}

        <button
          aria-label={t("workspace.settings.appearance.wallpaperUpload")}
          className={cn(
            wallpaperTileBaseClass,
            "flex flex-col items-center justify-center gap-2 border border-dashed border-[var(--border-1)] bg-[var(--transparency-block)] px-3 text-center text-[var(--text-secondary)] hover:bg-[var(--transparency-hover)] disabled:cursor-default disabled:opacity-60"
          )}
          disabled={isSaving}
          title={t("workspace.settings.appearance.wallpaperUpload")}
          type="button"
          onClick={() => fileInputRef.current?.click()}
        >
          {isSaving ? (
            <LoadingIcon className="size-4 animate-spin" />
          ) : (
            <UploadIcon className="size-4" />
          )}
          <span className="max-w-full whitespace-normal text-[11px] font-medium leading-tight">
            {isSaving
              ? t("workspace.settings.appearance.wallpaperUploading")
              : t("workspace.settings.appearance.wallpaperUpload")}
          </span>
        </button>
      </div>

      <input
        accept="image/png,image/jpeg,image/webp,image/heic,image/heif,image/*"
        className="hidden"
        ref={fileInputRef}
        type="file"
        onChange={(event) => {
          void handleFilesSelected(event);
        }}
      />

      {customWallpaper.exists && customSelected ? (
        <div className="flex w-full items-center justify-between gap-4 max-[560px]:flex-col max-[560px]:items-stretch">
          <div className="min-w-0">
            <strong className="text-[13px] font-semibold text-[var(--text-primary)]">
              {t("workspace.settings.appearance.wallpaperDisplayModeLabel")}
            </strong>
          </div>
          <div className="w-[220px] min-w-[220px] max-[560px]:w-full max-[560px]:min-w-0">
            <Select
              value={selectedWallpaperDisplayMode}
              onValueChange={(value) =>
                onSelectWallpaperDisplayMode(
                  value as WorkspaceWallpaperDisplayMode
                )
              }
            >
              <SelectTrigger
                aria-label={t(
                  "workspace.settings.appearance.wallpaperDisplayModeLabel"
                )}
                className={workspaceSettingsSelectTriggerClass}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent
                className={workspaceSettingsSelectContentClass}
                style={{ zIndex: "var(--z-panel-popover)" }}
              >
                {workspaceWallpaperDisplayModes.map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {t(workspaceWallpaperDisplayModeTitleKey(mode))}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      ) : null}

      {uploadError ? (
        <p className="m-0 text-[11px] leading-[1.4] text-[var(--state-danger)]">
          {uploadError}
        </p>
      ) : null}
    </div>
  );
}

function resolveWallpaperUploadErrorMessage(
  t: ReturnType<typeof useTranslation>["t"],
  error: unknown
): string {
  if (error instanceof CustomWallpaperImageError) {
    if (error.code === "unsupported-type") {
      return t("workspace.settings.appearance.wallpaperUploadErrorType");
    }
    if (error.code === "too-large") {
      return t("workspace.settings.appearance.wallpaperUploadErrorTooLarge");
    }
  }
  return t("workspace.settings.appearance.wallpaperUploadError");
}
