import type * as React from "react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { WorkspaceSummary } from "@tutti-os/client-tuttid-ts";
import {
  AddIcon,
  Button,
  ChevronDownIcon,
  ChevronUpIcon,
  CloseIcon,
  DeleteIcon,
  EyeIcon,
  LinkIcon,
  LoadingIcon,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  UploadIcon
} from "@tutti-os/ui-system";
import { useAnalyticsDebugPreferenceService } from "@renderer/features/analytics-debug";
import { useDesktopPreferencesService } from "@renderer/features/desktop-preferences/ui/useDesktopPreferencesService";
import { useTranslation } from "@renderer/i18n";
import { cn } from "@renderer/lib/format";
import { formatWorkspaceSettingsBytes } from "../services/workspaceSettingsFormat";
import type { WorkspaceSettingsDeveloperLogsSnapshotState } from "../services/workspaceSettingsTypes";
import type {
  WorkspaceManagedModel,
  WorkspaceManagedModelProviderDraft,
  WorkspaceManagedModelProviderFeedback,
  WorkspaceManagedModelProviderFeedbackKind,
  WorkspaceManagedModelProviderID,
  WorkspaceSettingsManagedModelsSnapshotState
} from "../services/workspaceSettingsTypes";
import {
  desktopLocales,
  type DesktopI18nKey,
  type DesktopLocale
} from "../../../../../shared/i18n/index.ts";
import {
  type DesktopAgentProvider,
  desktopBrowserUseConnectionModes,
  desktopDockPlacements,
  desktopSleepPreventionModes,
  type DesktopBrowserUseConnectionMode,
  type DesktopDockPlacement,
  type DesktopSleepPreventionMode
} from "../../../../../shared/preferences/index.ts";
import {
  resolveWorkspaceAgentGuiLabel,
  workspaceAgentGuiProviders
} from "../services/workspaceAgentProviderCatalog";
import {
  desktopThemeSources,
  type DesktopThemeAppearance,
  type DesktopThemeSource
} from "../../../../../shared/theme/index.ts";
import { useWorkspaceSettingsService } from "./useWorkspaceSettingsService";
import { useWorkspaceWorkbenchHostService } from "./useWorkspaceWorkbenchHostService";
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

const developerPanelUnlockTaps = 7;

export function WorkspaceSettingsPanel({
  onSelectWallpaper,
  onSelectWallpaperDisplayMode,
  selectedWallpaperDisplayMode,
  selectedWallpaperID,
  workspace
}: {
  onSelectWallpaper: (id: WorkspaceWallpaperId) => void;
  onSelectWallpaperDisplayMode: (
    displayMode: WorkspaceWallpaperDisplayMode
  ) => void;
  selectedWallpaperDisplayMode: WorkspaceWallpaperDisplayMode;
  selectedWallpaperID: WorkspaceWallpaperId;
  workspace: WorkspaceSummary;
}) {
  const { t } = useTranslation();
  const {
    service: analyticsDebugPreferenceService,
    state: analyticsDebugPreferenceState
  } = useAnalyticsDebugPreferenceService();
  const { state: desktopPreferencesState } = useDesktopPreferencesService();
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
      settingsService.selectSection("developer");
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
        className="grid h-[min(500px,calc(100vh-40px))] w-[min(760px,calc(100vw-40px))] origin-center grid-cols-[160px_minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-2xl border border-[var(--border-1)] bg-[var(--background-fronted)] text-[var(--text-primary)] shadow-panel transition-[background,opacity] duration-[180ms] ease-[cubic-bezier(0.22,1,0.36,1)] [-webkit-app-region:no-drag] motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-[0.96] motion-safe:duration-[250ms] motion-safe:ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:animate-none max-[760px]:h-[min(100vh-24px,520px)] max-[760px]:w-[min(calc(100vw-24px),640px)] max-[760px]:grid-cols-1 max-[760px]:grid-rows-[auto_auto_minmax(0,1fr)]"
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
              id: "appearance" as const,
              label: t("workspace.settings.nav.appearance")
            },
            {
              id: "apps" as const,
              label: t("workspace.settings.nav.apps")
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
                changingDefaultAgentProvider={
                  desktopPreferencesState.changingDefaultAgentProvider
                }
                changingBrowserUseConnectionMode={
                  desktopPreferencesState.changingBrowserUseConnectionMode
                }
                changingLocale={desktopPreferencesState.changingLocale}
                changingSleepPreventionMode={
                  desktopPreferencesState.changingSleepPreventionMode
                }
                defaultAgentProvider={
                  desktopPreferencesState.defaultAgentProvider
                }
                browserUseConnectionMode={
                  desktopPreferencesState.browserUseConnectionMode
                }
                developerLogs={settingsState.developerLogs}
                locale={desktopPreferencesState.locale}
                onBrowserUseConnectionModeChange={(mode) => {
                  void settingsService.changeBrowserUseConnectionMode(mode);
                }}
                onDefaultAgentProviderChange={(provider) => {
                  void settingsService.changeDefaultAgentProvider(provider);
                }}
                onLocaleChange={(nextLocale) => {
                  void settingsService.changeLocale(nextLocale);
                }}
                onSleepPreventionModeChange={(mode) => {
                  void settingsService.changeSleepPreventionMode(mode);
                }}
                onVersionTap={handleVersionTap}
                sleepPreventionMode={
                  desktopPreferencesState.sleepPreventionMode
                }
              />
            ) : settingsState.activeSection === "appearance" ? (
              <WorkspaceAppearanceSettingsSection
                changingDockPlacement={
                  desktopPreferencesState.changingDockPlacement
                }
                changingThemeSource={
                  desktopPreferencesState.changingThemeSource
                }
                dockPlacement={desktopPreferencesState.dockPlacement}
                onDockPlacementChange={(placement) => {
                  void settingsService.changeDockPlacement(placement);
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
            ) : (
              <WorkspaceDeveloperSettingsSection
                analyticsDebugAvailable={
                  analyticsDebugPreferenceState.available
                }
                analyticsDebugEnabled={analyticsDebugPreferenceState.enabled}
                developerLogs={settingsState.developerLogs}
                developerPanelVisible={settingsState.developerPanelVisible}
                onAnalyticsDebugEnabledChange={(enabled) => {
                  analyticsDebugPreferenceService.setEnabled(enabled);
                }}
                onClearLogs={() => {
                  void settingsService.clearDeveloperLogs();
                }}
                onDeveloperPanelVisibleChange={(visible) => {
                  settingsService.setDeveloperPanelVisible(visible);
                }}
                onExportLogs={() => {
                  void settingsService.exportDeveloperLogs();
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
            <Switch
              aria-label={t("workspace.settings.apps.managedModels.enabled", {
                provider: label
              })}
              checked={provider.enabled}
              disabled={saving}
              onCheckedChange={onSetEnabled}
            />
            <button
              aria-expanded={expanded}
              aria-label={t(
                expanded
                  ? "workspace.settings.apps.managedModels.collapse"
                  : "workspace.settings.apps.managedModels.expand"
              )}
              className="flex size-8 items-center justify-center rounded-[6px] text-[var(--text-secondary)] transition-colors duration-150 hover:bg-[var(--transparency-hover)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-focus)]"
              type="button"
              onClick={onToggleExpand}
            >
              {expanded ? (
                <ChevronUpIcon aria-hidden="true" size={16} />
              ) : (
                <ChevronDownIcon aria-hidden="true" size={16} />
              )}
            </button>
            <button
              aria-label={t("workspace.settings.apps.managedModels.delete")}
              className="flex size-8 items-center justify-center rounded-[6px] text-[var(--text-secondary)] transition-colors duration-150 hover:bg-[var(--transparency-hover)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-focus)]"
              type="button"
              onClick={onRequestDelete}
            >
              <DeleteIcon aria-hidden="true" size={15} />
            </button>
          </div>
        )}
      </div>

      {expanded ? null : <ManagedModelFeedbackLine feedback={feedback} />}

      {expanded ? (
        <>
          <ManagedModelProviderFields
            detecting={detecting}
            draft={provider}
            onDetect={onDetect}
            onUpdate={onUpdate}
          />
          <ManagedModelFeedbackLine feedback={feedback} />
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

  return (
    <section className="flex w-full flex-col gap-4 rounded-[10px] border border-[var(--border-focus)] bg-[var(--transparency-block)] p-4">
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
        onDetect={null}
        onUpdate={onUpdate}
      />

      <ManagedModelFeedbackLine feedback={feedback} />

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
    </section>
  );
}

function ManagedModelProviderFields({
  detecting,
  draft,
  onDetect,
  onUpdate
}: {
  detecting: boolean;
  draft: WorkspaceManagedModelProviderDraft;
  onDetect: (() => void) | null;
  onUpdate: (patch: Partial<WorkspaceManagedModelProviderDraft>) => void;
}) {
  const { t } = useTranslation();
  const [visibleAPIKeyProviderID, setVisibleAPIKeyProviderID] =
    useState<WorkspaceManagedModelProviderID | null>(null);
  const [newModelID, setNewModelID] = useState("");

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

  const updateModels = (models: readonly WorkspaceManagedModel[]) => {
    onUpdate({
      models: normalizeWorkspaceManagedModelRows(draft.provider, models)
    });
  };
  const addModel = () => {
    const id = newModelID.trim();
    if (!id) {
      return;
    }
    updateModels([...draft.models, { id, name: id, provider: draft.provider }]);
    setNewModelID("");
  };

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

      {apiKeyUrl ? (
        <button
          className="inline-flex w-fit items-center gap-1.5 rounded-[5px] text-left text-[12px] font-medium text-[var(--text-primary)] underline underline-offset-4 transition-opacity duration-150 hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-focus)]"
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
          <LinkIcon aria-hidden="true" size={13} />
        </button>
      ) : null}

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-medium text-[var(--text-secondary)]">
            {t("workspace.settings.apps.managedModels.models")}
          </span>
          {onDetect ? (
            <Button
              disabled={detecting}
              size="sm"
              type="button"
              variant="secondary"
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
              className="grid grid-cols-[72px_minmax(0,1fr)_32px] items-center gap-1.5"
            >
              <span className="flex h-8 items-center justify-center rounded-[6px] border border-[var(--border-1)] bg-[var(--transparency-block)] px-2 text-[11px] text-[var(--text-secondary)]">
                {draft.provider}:
              </span>
              <input
                aria-label={t("workspace.settings.apps.managedModels.modelId")}
                className={workspaceSettingsInputClass}
                placeholder={defaultManagedProviderModel(draft.provider)}
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
          <div className="grid grid-cols-[72px_minmax(0,1fr)_72px] items-center gap-1.5">
            <span className="flex h-8 items-center justify-center rounded-[6px] border border-[var(--border-1)] bg-[var(--transparency-block)] px-2 text-[11px] text-[var(--text-secondary)]">
              {draft.provider}:
            </span>
            <input
              aria-label={t("workspace.settings.apps.managedModels.modelId")}
              className={workspaceSettingsInputClass}
              placeholder={t(
                "workspace.settings.apps.managedModels.modelIdPlaceholder"
              )}
              value={newModelID}
              onChange={(event) => setNewModelID(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addModel();
                }
              }}
            />
            <Button
              disabled={!newModelID.trim()}
              size="sm"
              type="button"
              variant="secondary"
              onClick={addModel}
            >
              <AddIcon className="size-3.5" />
              {t("workspace.settings.apps.managedModels.addModel")}
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}

function WorkspaceDeveloperSettingsSection({
  analyticsDebugAvailable,
  analyticsDebugEnabled,
  developerLogs,
  developerPanelVisible,
  onAnalyticsDebugEnabledChange,
  onClearLogs,
  onDeveloperPanelVisibleChange,
  onExportLogs
}: {
  analyticsDebugAvailable: boolean;
  analyticsDebugEnabled: boolean;
  developerLogs: WorkspaceSettingsDeveloperLogsSnapshotState;
  developerPanelVisible: boolean;
  onAnalyticsDebugEnabledChange: (enabled: boolean) => void;
  onClearLogs: () => void;
  onDeveloperPanelVisibleChange: (visible: boolean) => void;
  onExportLogs: () => void;
}) {
  const { t } = useTranslation();
  const logs = developerLogs.logs;

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
        </div>
      </SettingsRow>
    </SettingsRows>
  );
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
      className="fixed inset-0 grid place-items-center bg-[color-mix(in_srgb,var(--backdrop)_28%,transparent)] supports-backdrop-filter:backdrop-blur-sm transition-[background] duration-[180ms] ease-[cubic-bezier(0.22,1,0.36,1)] [-webkit-app-region:no-drag] motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-[180ms] motion-safe:ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:animate-none"
      data-workspace-settings-backdrop="true"
      style={{ zIndex: "var(--z-panel)" }}
      onClick={onClose}
    >
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

function WorkspaceGeneralSettingsSection({
  browserUseConnectionMode,
  changingDefaultAgentProvider,
  changingBrowserUseConnectionMode,
  changingLocale,
  changingSleepPreventionMode,
  defaultAgentProvider,
  developerLogs,
  locale,
  onDefaultAgentProviderChange,
  onBrowserUseConnectionModeChange,
  onLocaleChange,
  onSleepPreventionModeChange,
  onVersionTap,
  sleepPreventionMode
}: {
  browserUseConnectionMode: DesktopBrowserUseConnectionMode;
  changingDefaultAgentProvider: DesktopAgentProvider | null;
  changingBrowserUseConnectionMode: DesktopBrowserUseConnectionMode | null;
  changingLocale: DesktopLocale | null;
  changingSleepPreventionMode: DesktopSleepPreventionMode | null;
  defaultAgentProvider: DesktopAgentProvider;
  developerLogs: WorkspaceSettingsDeveloperLogsSnapshotState;
  locale: DesktopLocale;
  onBrowserUseConnectionModeChange: (
    mode: DesktopBrowserUseConnectionMode
  ) => void;
  onDefaultAgentProviderChange: (provider: DesktopAgentProvider) => void;
  onLocaleChange: (locale: DesktopLocale) => void;
  onSleepPreventionModeChange: (mode: DesktopSleepPreventionMode) => void;
  onVersionTap: () => void;
  sleepPreventionMode: DesktopSleepPreventionMode;
}) {
  const { t } = useTranslation();
  const isUpdatingLocale = changingLocale !== null;
  const pendingLocale = changingLocale ?? locale;
  const isUpdatingDefaultAgentProvider = changingDefaultAgentProvider !== null;
  const pendingDefaultAgentProvider =
    changingDefaultAgentProvider ?? defaultAgentProvider;
  const isUpdatingBrowserUseConnectionMode =
    changingBrowserUseConnectionMode !== null;
  const pendingBrowserUseConnectionMode =
    changingBrowserUseConnectionMode ?? browserUseConnectionMode;
  const isUpdatingSleepPrevention = changingSleepPreventionMode !== null;
  const pendingSleepPreventionMode =
    changingSleepPreventionMode ?? sleepPreventionMode;
  const logs = developerLogs.logs;

  return (
    <div className="flex flex-col gap-8 pb-[22px] pt-5">
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
              {workspaceAgentGuiProviders.map((provider) => (
                <SelectItem key={provider} value={provider}>
                  {resolveWorkspaceAgentGuiLabel(provider)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

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
        <div className="min-w-0">
          <strong className="text-[13px] font-semibold text-[var(--text-primary)]">
            {t("workspace.settings.general.versionLabel")}
          </strong>
        </div>
        <button
          className="m-0 inline-flex h-5 cursor-default select-none items-center justify-end rounded-[5px] border-0 bg-transparent p-0 text-right font-mono text-[13px] leading-5 text-[var(--text-secondary)] outline-none focus-visible:outline-none max-[560px]:justify-start max-[560px]:text-left"
          type="button"
          onClick={onVersionTap}
        >
          {developerLogs.loading && logs === null
            ? t("common.loading")
            : (logs?.desktopVersion ?? "0.0.0")}
        </button>
      </div>
    </div>
  );
}

function WorkspaceAppearanceSettingsSection({
  changingDockPlacement,
  changingThemeSource,
  dockPlacement,
  onDockPlacementChange,
  onSelectWallpaper,
  onSelectWallpaperDisplayMode,
  onThemeChange,
  selectedWallpaperDisplayMode,
  selectedWallpaperID,
  themeAppearance,
  themeSource
}: {
  changingDockPlacement: DesktopDockPlacement | null;
  changingThemeSource: DesktopThemeSource | null;
  dockPlacement: DesktopDockPlacement;
  onDockPlacementChange: (placement: DesktopDockPlacement) => void;
  onSelectWallpaper: (id: WorkspaceWallpaperId) => void;
  onSelectWallpaperDisplayMode: (
    displayMode: WorkspaceWallpaperDisplayMode
  ) => void;
  onThemeChange: (source: DesktopThemeSource) => void;
  selectedWallpaperDisplayMode: WorkspaceWallpaperDisplayMode;
  selectedWallpaperID: WorkspaceWallpaperId;
  themeAppearance: DesktopThemeAppearance;
  themeSource: DesktopThemeSource;
}) {
  const { t } = useTranslation();
  const isUpdatingTheme = changingThemeSource !== null;
  const pendingThemeSource = changingThemeSource ?? themeSource;
  const isUpdatingDockPlacement = changingDockPlacement !== null;
  const pendingDockPlacement = changingDockPlacement ?? dockPlacement;

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
